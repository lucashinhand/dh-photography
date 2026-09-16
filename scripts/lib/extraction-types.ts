export const RENDITION_WIDTHS = [2500, 1500, 1000, 750, 500, 300, 100] as const;

export type RenditionWidth = (typeof RENDITION_WIDTHS)[number];

export type MetadataSourceKind = 'xml' | 'live' | 'sitemap';

export interface MetadataSourceRecord {
  source: MetadataSourceKind;
  method?: 'xml' | 'dom' | 'format-json' | 'sitemap';
  pageSlug?: string;
  order?: number;
  sourceUrl?: string;
  title?: string;
  caption?: string;
  alt?: string;
  tags?: string[];
  observedWidth?: number;
  observedHeight?: number;
  originalSize?: string;
  contentType?: string;
  variants?: string[];
}

export interface XmlPlacementRecord {
  imageId: string;
  pageSlug: string;
  order: number;
  sourceUrl: string;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
  metadataSources: MetadataSourceRecord[];
}

export interface LiveImageRecord {
  imageId: string;
  sourceUrl: string;
  sourceUrls: string[];
  order: number;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
  observedWidth?: number;
  observedHeight?: number;
  originalSize?: string;
  contentType?: string;
  variants?: string[];
  metadataSources: MetadataSourceRecord[];
}

export interface LivePageRecord {
  slug: string;
  path: string;
  url: string;
  title: string;
  description: string;
  canonicalUrl: string;
  headings: string[];
  publicText: string[];
  footerText: string[];
  links: Array<{ href: string; label: string; external: boolean }>;
  images: LiveImageRecord[];
  layout: 'gallery' | 'text' | 'mixed' | 'unknown';
  fetchedAt: string;
  error?: string;
}

export interface NavigationEntry {
  label: string;
  slug: string;
  path: string;
  href: string;
  order: number;
}

export interface SitemapImageRecord {
  sourceUrl: string;
  pagePath: string;
  pageSlug: string;
  title: string;
  caption: string;
  imageId: string;
  metadataSources: MetadataSourceRecord[];
}

export interface ScreenshotRecord {
  layout: LivePageRecord['layout'];
  viewport: 'desktop' | 'mobile';
  slug: string;
  path: string;
  file: string;
}

export interface CrawlResult {
  status: 'complete' | 'partial' | 'failed' | 'skipped';
  baseUrl: string;
  sitemapUrl: string;
  routes: string[];
  sitemapPageCount: number;
  sitemapImageCount: number;
  sitemapImages: SitemapImageRecord[];
  navigation: NavigationEntry[];
  pages: LivePageRecord[];
  screenshots: ScreenshotRecord[];
  instagram: string;
  errors: string[];
  warnings: string[];
  fetchedAt: string;
}

export interface XmlPageRecord {
  slug: string;
  path: string;
  title: string;
  description: string;
  bodyHtml: string;
  rawBodyHtml: string;
  placements: XmlPlacementRecord[];
  sourceItemId: string;
  status: string;
}

export interface XmlAttachmentRecord {
  id: string;
  sourceUrl: string;
  title: string;
  filename: string;
  postName: string;
  postDate: string;
}

export interface ParsedXmlExport {
  channelTitle: string;
  channelLink: string;
  channelDescription: string;
  pages: XmlPageRecord[];
  attachments: XmlAttachmentRecord[];
  placements: XmlPlacementRecord[];
  sanitizedXml: string;
  stats: {
    itemCount: number;
    pageCount: number;
    attachmentCount: number;
    placementCount: number;
    uniquePlacementAssets: number;
    attachmentOnlyAssets: number;
    placementOnlyAssets: number;
  };
}

export interface AssetObservedRecord {
  source: MetadataSourceKind;
  pageSlug?: string;
  url: string;
  width?: number;
  height?: number;
  originalSize?: string;
  contentType?: string;
  variants?: string[];
}

export interface AssetDownloadInput {
  id: string;
  identity: string;
  sourceUrl: string;
  originalFilename: string;
  filename: string;
  pageSlugs: string[];
  placementCount: number;
  sourceUrls: string[];
  candidateUrls: Array<{ width: RenditionWidth; url: string }>;
  observed: AssetObservedRecord[];
  metadataSources: MetadataSourceRecord[];
}

export interface AssetManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    baseUrl: string;
    xmlPath: string;
    xmlSha256: string;
  };
  policy: {
    sourceProtocol: 'https';
    requestedWidths: RenditionWidth[];
    preferredWidth: RenditionWidth;
    maxCommittedWidth: RenditionWidth;
    originalDownloads: 'excluded';
  };
  assets: AssetDownloadInput[];
}

export interface ReconciledPlacement {
  imageId: string;
  pageSlug: string;
  order: number;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
  sourceUrl: string;
  metadataSources: MetadataSourceRecord[];
  source: 'xml' | 'live' | 'reconciled';
}

export interface ReconciledPage {
  slug: string;
  path: string;
  title: string;
  kind: 'gallery' | 'about' | 'contact';
  description: string;
  bodyHtml: string;
  placements: ReconciledPlacement[];
  xmlPlacementCount: number;
  livePlacementCount: number;
  liveOnlyImageIds: string[];
  xmlOnlyImageIds: string[];
}

export interface ReconciliationResult {
  orderPolicy: 'xml' | 'live';
  pages: ReconciledPage[];
  assets: AssetDownloadInput[];
  navigation: NavigationEntry[];
  metadataConflicts: Array<{
    imageId: string;
    pageSlug: string;
    field: 'title' | 'caption' | 'alt' | 'tags';
    xmlValue: string | string[];
    liveValue: string | string[];
  }>;
  orderDifferences: Array<{
    pageSlug: string;
    xmlImageIds: string[];
    liveImageIds: string[];
  }>;
  missingLivePages: string[];
  liveOnlyPages: string[];
}

export interface ExtractionReport {
  generatedAt: string;
  baseUrl: string;
  sourceXml: string;
  xmlSha256: string;
  crawl: {
    status: CrawlResult['status'];
    orderPolicy: ReconciliationResult['orderPolicy'];
    routes: number;
    pages: number;
    sitemapPages: number;
    sitemapImageEntries: number;
    sitemapUniqueAssets: number;
    errors: string[];
    warnings: string[];
  };
  inventory: {
    xmlItems: number;
    xmlPages: number;
    xmlAttachments: number;
    xmlPlacements: number;
    uniqueAssets: number;
    outputPages: number;
    outputPlacements: number;
    liveOnlyPlacements: number;
    xmlOnlyPlacements: number;
  };
  metadata: {
    conflicts: number;
    missingAltText: number;
    pagesWithoutLiveData: string[];
  };
  screenshots: ScreenshotRecord[];
  warnings: string[];
}
