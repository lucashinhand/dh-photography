import type {
  AssetDownloadInput,
  CrawlResult,
  LiveImageRecord,
  LivePageRecord,
  MetadataSourceRecord,
  NavigationEntry,
  ParsedXmlExport,
  ReconciledPage,
  ReconciledPlacement,
  ReconciliationResult,
  XmlPlacementRecord,
} from './extraction-types.js';
import {
  renditionCandidates,
  normalizeAssetUrl,
  normalizeSlug,
  routePath,
} from './url-normalization.js';

interface MutableAsset {
  id: string;
  identity: string;
  sourceUrl: string;
  originalFilename: string;
  filename: string;
  pageSlugs: Set<string>;
  placementCount: number;
  sourceUrls: Set<string>;
  observed: AssetDownloadInput['observed'];
  metadataSources: MetadataSourceRecord[];
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function addUniqueMetadata(
  target: MetadataSourceRecord[],
  source: MetadataSourceRecord,
): void {
  const key = JSON.stringify(source);
  if (!target.some((candidate) => JSON.stringify(candidate) === key))
    target.push(source);
}

function addAsset(
  assets: Map<string, MutableAsset>,
  sourceUrl: string,
  pageSlug?: string,
  metadataSources: MetadataSourceRecord[] = [],
  observed?: AssetDownloadInput['observed'][number],
  placement = false,
): MutableAsset | undefined {
  const normalized = normalizeAssetUrl(sourceUrl);
  if (!normalized) return undefined;
  let asset = assets.get(normalized.id);
  if (!asset) {
    asset = {
      id: normalized.id,
      identity: normalized.identity,
      sourceUrl: normalized.url,
      originalFilename: normalized.filename,
      filename: normalized.filename,
      pageSlugs: new Set(),
      placementCount: 0,
      sourceUrls: new Set(),
      observed: [],
      metadataSources: [],
    };
    assets.set(normalized.id, asset);
  }
  asset.sourceUrls.add(normalized.url);
  if (pageSlug) asset.pageSlugs.add(pageSlug);
  if (placement) asset.placementCount += 1;
  for (const metadata of metadataSources)
    addUniqueMetadata(asset.metadataSources, metadata);
  if (
    observed &&
    !asset.observed.some(
      (candidate) => JSON.stringify(candidate) === JSON.stringify(observed),
    )
  ) {
    asset.observed.push(observed);
  }
  return asset;
}

function toAssetDownloadInput(asset: MutableAsset): AssetDownloadInput {
  return {
    id: asset.id,
    identity: asset.identity,
    sourceUrl: asset.sourceUrl,
    originalFilename: asset.originalFilename,
    filename: asset.filename,
    pageSlugs: [...asset.pageSlugs],
    placementCount: asset.placementCount,
    sourceUrls: [...asset.sourceUrls],
    candidateUrls: renditionCandidates(asset.sourceUrl),
    observed: asset.observed,
    metadataSources: asset.metadataSources,
  };
}

function liveForImage(
  page: LivePageRecord | undefined,
  imageId: string,
): LiveImageRecord | undefined {
  return page?.images.find((image) => image.imageId === imageId);
}

function mergeField(
  field: 'title' | 'caption' | 'alt' | 'tags',
  xmlValue: string | string[],
  liveValue: string | string[],
  imageId: string,
  pageSlug: string,
  conflicts: ReconciliationResult['metadataConflicts'],
): string | string[] {
  const xmlHasValue = Array.isArray(xmlValue)
    ? xmlValue.length > 0
    : Boolean(xmlValue.trim());
  const liveHasValue = Array.isArray(liveValue)
    ? liveValue.length > 0
    : Boolean(liveValue.trim());
  if (xmlHasValue && liveHasValue) {
    const equal =
      Array.isArray(xmlValue) && Array.isArray(liveValue)
        ? JSON.stringify(xmlValue) === JSON.stringify(liveValue)
        : String(xmlValue) === String(liveValue);
    if (!equal)
      conflicts.push({ imageId, pageSlug, field, xmlValue, liveValue });
  }
  if (xmlHasValue) return xmlValue;
  return liveValue;
}

function pageKind(
  slug: string,
  placementCount: number,
): ReconciledPage['kind'] {
  if (slug === 'about') return 'about';
  if (slug === 'contact') return 'contact';
  return placementCount > 0 ? 'gallery' : 'gallery';
}

function orderedPages(
  pages: ReconciledPage[],
  navigation: NavigationEntry[],
): ReconciledPage[] {
  if (!navigation.length) return pages;
  const order = new Map(navigation.map((entry, index) => [entry.slug, index]));
  return pages
    .map((page, index) => ({
      page,
      index,
      navOrder: order.get(page.slug) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((a, b) => a.navOrder - b.navOrder || a.index - b.index)
    .map(({ page }) => page);
}

export function buildReconciliation(
  parsed: ParsedXmlExport,
  crawl: CrawlResult,
): ReconciliationResult {
  const assets = new Map<string, MutableAsset>();
  const liveBySlug = new Map(crawl.pages.map((page) => [page.slug, page]));

  for (const attachment of parsed.attachments) {
    addAsset(assets, attachment.sourceUrl);
  }
  for (const placement of parsed.placements) {
    addAsset(
      assets,
      placement.sourceUrl,
      placement.pageSlug,
      placement.metadataSources,
      { source: 'xml', pageSlug: placement.pageSlug, url: placement.sourceUrl },
      true,
    );
  }
  for (const page of crawl.pages) {
    for (const image of page.images) {
      addAsset(
        assets,
        image.sourceUrl,
        page.slug,
        image.metadataSources,
        {
          source: 'live',
          pageSlug: page.slug,
          url: image.sourceUrl,
          ...(image.observedWidth ? { width: image.observedWidth } : {}),
          ...(image.observedHeight ? { height: image.observedHeight } : {}),
        },
        false,
      );
    }
  }
  for (const sitemapImage of crawl.sitemapImages) {
    addAsset(
      assets,
      sitemapImage.sourceUrl,
      sitemapImage.pageSlug,
      sitemapImage.metadataSources,
      {
        source: 'sitemap',
        pageSlug: sitemapImage.pageSlug,
        url: sitemapImage.sourceUrl,
      },
      false,
    );
  }

  const metadataConflicts: ReconciliationResult['metadataConflicts'] = [];
  const orderDifferences: ReconciliationResult['orderDifferences'] = [];
  const outputPages: ReconciledPage[] = [];
  const orderPolicy: ReconciliationResult['orderPolicy'] = 'live';
  const navigation = crawl.navigation.length
    ? crawl.navigation
    : parsed.pages.map((page, order) => ({
        label: page.title,
        slug: page.slug,
        path: page.path,
        href: page.path,
        order,
      }));

  for (const xmlPage of parsed.pages) {
    const livePage = liveBySlug.get(xmlPage.slug);
    const xmlImageIds = xmlPage.placements.map(
      (placement) => placement.imageId,
    );
    const liveImageIds = livePage?.images.map((image) => image.imageId) ?? [];
    if (
      livePage &&
      JSON.stringify(xmlImageIds) !== JSON.stringify(liveImageIds)
    ) {
      orderDifferences.push({
        pageSlug: xmlPage.slug,
        xmlImageIds,
        liveImageIds,
      });
    }

    const liveOnlyImages = (livePage?.images ?? []).filter(
      (image) => !xmlImageIds.includes(image.imageId),
    );
    const liveOnlyImageIds = liveOnlyImages.map((image) => image.imageId);
    const xmlOnlyImageIds = xmlImageIds.filter(
      (imageId) => !liveImageIds.includes(imageId),
    );

    const toPlacement = (
      placement: XmlPlacementRecord,
      liveImage: LiveImageRecord | undefined,
      order: number,
    ): ReconciledPlacement => {
      const metadataSources = [...placement.metadataSources];
      if (liveImage) metadataSources.push(...liveImage.metadataSources);
      const title = mergeField(
        'title',
        placement.title,
        liveImage?.title ?? '',
        placement.imageId,
        xmlPage.slug,
        metadataConflicts,
      ) as string;
      const caption = mergeField(
        'caption',
        placement.caption,
        liveImage?.caption ?? '',
        placement.imageId,
        xmlPage.slug,
        metadataConflicts,
      ) as string;
      const alt = mergeField(
        'alt',
        placement.alt,
        liveImage?.alt ?? '',
        placement.imageId,
        xmlPage.slug,
        metadataConflicts,
      ) as string;
      const tags = mergeField(
        'tags',
        placement.tags,
        liveImage?.tags ?? [],
        placement.imageId,
        xmlPage.slug,
        metadataConflicts,
      ) as string[];
      return {
        imageId: placement.imageId,
        pageSlug: xmlPage.slug,
        order,
        title,
        caption,
        alt,
        tags: dedupeStrings(tags),
        sourceUrl: placement.sourceUrl,
        metadataSources,
        source: liveImage ? 'reconciled' : 'xml',
      };
    };
    const toLiveOnlyPlacement = (
      image: LiveImageRecord,
      order: number,
    ): ReconciledPlacement => ({
      imageId: image.imageId,
      pageSlug: xmlPage.slug,
      order,
      title: image.title,
      caption: image.caption,
      alt: image.alt,
      tags: image.tags,
      sourceUrl: image.sourceUrl,
      metadataSources: image.metadataSources,
      source: 'live',
    });

    const placements: ReconciledPlacement[] = [];
    if (orderPolicy === 'live' && livePage) {
      const remaining = new Map<string, XmlPlacementRecord[]>();
      for (const placement of xmlPage.placements) {
        const queue = remaining.get(placement.imageId) ?? [];
        queue.push(placement);
        remaining.set(placement.imageId, queue);
      }
      for (const liveImage of livePage.images) {
        const queue = remaining.get(liveImage.imageId) ?? [];
        const xmlPlacement = queue.shift();
        if (queue.length === 0) remaining.delete(liveImage.imageId);
        else remaining.set(liveImage.imageId, queue);
        if (xmlPlacement)
          placements.push(
            toPlacement(xmlPlacement, liveImage, placements.length),
          );
        else placements.push(toLiveOnlyPlacement(liveImage, placements.length));
      }
      for (const placement of xmlPage.placements) {
        const queue = remaining.get(placement.imageId);
        if (!queue?.includes(placement)) continue;
        queue.splice(queue.indexOf(placement), 1);
        if (queue.length === 0) remaining.delete(placement.imageId);
        placements.push(
          toPlacement(
            placement,
            liveForImage(livePage, placement.imageId),
            placements.length,
          ),
        );
      }
    } else {
      for (const placement of xmlPage.placements) {
        placements.push(
          toPlacement(
            placement,
            liveForImage(livePage, placement.imageId),
            placements.length,
          ),
        );
      }
      for (const image of liveOnlyImages) {
        placements.push(toLiveOnlyPlacement(image, placements.length));
      }
    }

    outputPages.push({
      slug: xmlPage.slug,
      path: xmlPage.path,
      title:
        navigation.find((entry) => entry.slug === xmlPage.slug)?.label ||
        xmlPage.title,
      kind: pageKind(xmlPage.slug, placements.length),
      description: livePage?.description || xmlPage.description,
      bodyHtml: xmlPage.bodyHtml,
      placements,
      xmlPlacementCount: xmlImageIds.length,
      livePlacementCount: liveImageIds.length,
      liveOnlyImageIds,
      xmlOnlyImageIds,
    });
  }

  const knownSlugs = new Set(parsed.pages.map((page) => page.slug));
  for (const livePage of crawl.pages) {
    if (knownSlugs.has(livePage.slug)) continue;
    outputPages.push({
      slug: livePage.slug,
      path: livePage.path,
      title:
        navigation.find((entry) => entry.slug === livePage.slug)?.label ||
        livePage.title ||
        livePage.slug,
      kind: pageKind(livePage.slug, livePage.images.length),
      description: livePage.description,
      bodyHtml: '',
      placements: livePage.images.map((image, order) => ({
        imageId: image.imageId,
        pageSlug: livePage.slug,
        order,
        title: image.title,
        caption: image.caption,
        alt: image.alt,
        tags: image.tags,
        sourceUrl: image.sourceUrl,
        metadataSources: image.metadataSources,
        source: 'live' as const,
      })),
      xmlPlacementCount: 0,
      livePlacementCount: livePage.images.length,
      liveOnlyImageIds: livePage.images.map((image) => image.imageId),
      xmlOnlyImageIds: [],
    });
  }

  return {
    orderPolicy,
    pages: orderedPages(outputPages, navigation),
    assets: [...assets.values()]
      .map(toAssetDownloadInput)
      .sort((a, b) => a.id.localeCompare(b.id)),
    navigation,
    metadataConflicts,
    orderDifferences,
    missingLivePages: parsed.pages
      .filter((page) => !liveBySlug.has(page.slug))
      .map((page) => page.slug),
    liveOnlyPages: crawl.pages
      .filter((page) => !knownSlugs.has(page.slug))
      .map((page) => page.slug),
  };
}

export interface DraftSiteContent {
  name: string;
  description: string;
  email: string;
  phone: string;
  instagram: string;
  pages: Array<{
    slug: string;
    title: string;
    kind: ReconciledPage['kind'];
    description: string;
    bodyHtml: string;
    placements: Array<{
      imageId: string;
      title: string;
      caption: string;
      alt: string;
      tags: string[];
    }>;
  }>;
  photos: Record<string, never>;
}

export function buildDraftSiteContent(
  parsed: ParsedXmlExport,
  reconciliation: ReconciliationResult,
  contact: { email: string; phone: string; instagram: string },
): DraftSiteContent {
  return {
    name: parsed.channelTitle || 'David Hahn Photography',
    description: parsed.channelDescription,
    email: contact.email,
    phone: contact.phone,
    instagram: contact.instagram,
    pages: reconciliation.pages.map((page) => ({
      slug: normalizeSlug(page.slug),
      title: page.title,
      kind: page.kind,
      description: page.description || page.title,
      bodyHtml: page.bodyHtml,
      placements: page.placements.map((placement) => ({
        imageId: placement.imageId,
        title: placement.title,
        caption: placement.caption,
        alt: placement.alt,
        tags: placement.tags,
      })),
    })),
    photos: {},
  };
}

export function pagePathForSlug(slug: string): string {
  return routePath(slug);
}
