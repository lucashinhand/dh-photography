import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { load } from 'cheerio';
import { chromium, type BrowserContext, type Page } from 'playwright';

import type {
  CrawlResult,
  LiveImageRecord,
  LivePageRecord,
  MetadataSourceRecord,
  NavigationEntry,
  ScreenshotRecord,
  SitemapImageRecord,
} from './extraction-types.js';
import {
  normalizeAssetUrl,
  normalizeBaseUrl,
  normalizeSlug,
  routePath,
} from './url-normalization.js';

const DEFAULT_TIMEOUT_MS = 45_000;
const DESKTOP_VIEWPORT = { width: 1440, height: 1100 };
const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface RawLiveImage {
  candidates: string[];
  order: number;
  title: string;
  caption: string;
  alt: string;
  tags: string[];
  observedWidth?: number;
  observedHeight?: number;
}

interface RawPageData {
  title: string;
  description: string;
  canonicalUrl: string;
  headings: string[];
  publicText: string[];
  footerText: string[];
  links: Array<{ href: string; label: string }>;
  navigation: Array<{ href: string; label: string }>;
  instagram: string;
  images: RawLiveImage[];
}

interface ParsedSitemap {
  routes: string[];
  images: SitemapImageRecord[];
}

interface PublicGalleryJsonItem {
  title?: unknown;
  body?: unknown;
  excerpt?: unknown;
  assetUrl?: unknown;
  filename?: unknown;
  originalSize?: unknown;
  contentType?: unknown;
  systemDataVariants?: unknown;
  tags?: unknown;
  categories?: unknown;
}

interface PublicGalleryJson {
  items?: unknown;
  website?: unknown;
}

export interface CrawlOptions {
  baseUrl: string;
  routes: string[];
  screenshotDir: string;
  timeoutMs?: number;
  captureScreenshots?: boolean;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

function absoluteHttpsUrl(baseUrl: string, value: string): string | undefined {
  try {
    const url = new URL(value, `${baseUrl}/`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.protocol = 'https:';
    return url.toString();
  } catch {
    return undefined;
  }
}

function imageMetadataSource(
  pageSlug: string,
  image: LiveImageRecord,
): MetadataSourceRecord {
  return {
    source: 'live',
    method: 'dom',
    pageSlug,
    order: image.order,
    sourceUrl: image.sourceUrl,
    ...(image.title ? { title: image.title } : {}),
    ...(image.caption ? { caption: image.caption } : {}),
    ...(image.alt ? { alt: image.alt } : {}),
    ...(image.tags.length ? { tags: image.tags } : {}),
    ...(image.observedWidth ? { observedWidth: image.observedWidth } : {}),
    ...(image.observedHeight ? { observedHeight: image.observedHeight } : {}),
  };
}

function stripMarkup(value: unknown): string {
  if (typeof value !== 'string') return '';
  return cleanText(load(value, {}, false).text());
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => stringList(item));
  if (typeof value === 'string')
    return value.split(/[|,;]/).map(cleanText).filter(Boolean);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      stringList(item),
    );
  }
  return [];
}

function imageSize(value: unknown): { width?: number; height?: number } {
  if (typeof value !== 'string') return {};
  const match = value.match(/^(\d+)x(\d+)$/);
  if (!match) return {};
  return { width: Number(match[1]), height: Number(match[2]) };
}

function publicInstagramUrl(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const website = value as { socialAccounts?: unknown };
  if (!Array.isArray(website.socialAccounts)) return '';
  for (const account of website.socialAccounts) {
    if (!account || typeof account !== 'object') continue;
    const profileUrl = (account as { profileUrl?: unknown }).profileUrl;
    if (typeof profileUrl !== 'string' || !/instagram\.com\//i.test(profileUrl))
      continue;
    const normalized = absoluteHttpsUrl('https://instagram.com', profileUrl);
    if (normalized && /https:\/\/(?:www\.)?instagram\.com\//i.test(normalized))
      return normalized;
  }
  return '';
}

function formatJsonImages(value: unknown, pageSlug: string): LiveImageRecord[] {
  if (!Array.isArray(value)) return [];
  const images: LiveImageRecord[] = [];
  for (const [order, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as PublicGalleryJsonItem;
    const source =
      typeof item.assetUrl === 'string'
        ? normalizeAssetUrl(item.assetUrl)
        : null;
    if (!source) continue;
    const originalSize =
      typeof item.originalSize === 'string' ? item.originalSize : '';
    const dimensions = imageSize(originalSize);
    const variants = stringList(item.systemDataVariants);
    const title = stripMarkup(item.title);
    const caption = stripMarkup(item.body) || stripMarkup(item.excerpt);
    const tags = stringList(item.tags ?? item.categories);
    const record: LiveImageRecord = {
      imageId: source.id,
      sourceUrl: source.url,
      sourceUrls: [source.url],
      order,
      title,
      caption,
      alt: '',
      tags,
      ...(dimensions.width ? { observedWidth: dimensions.width } : {}),
      ...(dimensions.height ? { observedHeight: dimensions.height } : {}),
      ...(originalSize ? { originalSize } : {}),
      ...(typeof item.contentType === 'string'
        ? { contentType: item.contentType }
        : {}),
      ...(variants.length ? { variants } : {}),
      metadataSources: [],
    };
    record.metadataSources.push({
      source: 'live',
      method: 'format-json',
      pageSlug,
      order,
      sourceUrl: source.url,
      ...(title ? { title } : {}),
      ...(caption ? { caption } : {}),
      ...(tags.length ? { tags } : {}),
      ...(dimensions.width ? { observedWidth: dimensions.width } : {}),
      ...(dimensions.height ? { observedHeight: dimensions.height } : {}),
      ...(originalSize ? { originalSize } : {}),
      ...(typeof item.contentType === 'string'
        ? { contentType: item.contentType }
        : {}),
      ...(variants.length ? { variants } : {}),
    });
    images.push(record);
  }
  return images;
}

export async function fetchGalleryJson(
  context: BrowserContext,
  url: string,
  timeoutMs: number,
  pageSlug: string,
): Promise<{ images: LiveImageRecord[]; instagram: string; error?: string }> {
  const jsonUrl = `${url}${url.includes('?') ? '&' : '?'}format=json`;
  try {
    const response = await context.request.get(jsonUrl, { timeout: timeoutMs });
    if (!response.ok()) {
      return {
        images: [],
        instagram: '',
        error: `HTTP ${response.status()}`,
      };
    }
    const data = (await response.json()) as PublicGalleryJson | null;
    if (!data || typeof data !== 'object') {
      return {
        images: [],
        instagram: '',
        error: 'invalid JSON payload',
      };
    }
    return {
      images: formatJsonImages(data.items, pageSlug),
      instagram: publicInstagramUrl(data.website),
    };
  } catch (error) {
    return {
      images: [],
      instagram: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function galleryJsonWarning(path: string, error: string): string {
  return `${path}: format=json unavailable (${error})`;
}

function mergeLiveImages(
  pageSlug: string,
  jsonImages: LiveImageRecord[],
  domImages: LiveImageRecord[],
): LiveImageRecord[] {
  const domById = new Map(domImages.map((image) => [image.imageId, image]));
  const jsonIds = new Set(jsonImages.map((image) => image.imageId));
  const merged = jsonImages.map((jsonImage) => {
    const domImage = domById.get(jsonImage.imageId);
    const record: LiveImageRecord = {
      ...jsonImage,
      sourceUrls: [
        ...new Set([...jsonImage.sourceUrls, ...(domImage?.sourceUrls ?? [])]),
      ],
      title: jsonImage.title || domImage?.title || '',
      caption: jsonImage.caption || domImage?.caption || '',
      alt: domImage?.alt || jsonImage.alt,
      tags: jsonImage.tags.length ? jsonImage.tags : (domImage?.tags ?? []),
      ...(jsonImage.observedWidth || domImage?.observedWidth
        ? { observedWidth: jsonImage.observedWidth ?? domImage?.observedWidth }
        : {}),
      ...(jsonImage.observedHeight || domImage?.observedHeight
        ? {
            observedHeight:
              jsonImage.observedHeight ?? domImage?.observedHeight,
          }
        : {}),
      metadataSources: [
        ...jsonImage.metadataSources,
        ...(domImage?.metadataSources ?? []),
      ],
    };
    return record;
  });
  for (const domImage of domImages) {
    if (jsonIds.has(domImage.imageId)) continue;
    merged.push({
      ...domImage,
      order: merged.length,
      metadataSources: domImage.metadataSources,
    });
  }
  return merged.map((image, order) => ({
    ...image,
    order,
    metadataSources: image.metadataSources.map((metadata) => ({
      ...metadata,
      order,
    })),
  }));
}

function xmlText(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function sitemapHostAllowed(hostname: string, baseUrl: string): boolean {
  const base = new URL(baseUrl);
  const host = hostname.toLowerCase();
  const canonical = [
    'davidhahnphotography.com.au',
    'www.davidhahnphotography.com.au',
  ];
  return host === base.hostname.toLowerCase() || canonical.includes(host);
}

function parseSitemapData(text: string, baseUrl: string): ParsedSitemap {
  const routes: string[] = [];
  const images: SitemapImageRecord[] = [];
  const urlBlocks = [...text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)].map(
    (match) => match[1] ?? '',
  );
  for (const block of urlBlocks) {
    const loc = xmlText(block.match(/<loc>([\s\S]*?)<\/loc>/i)?.[1] ?? '');
    const pageUrl = absoluteHttpsUrl(baseUrl, loc);
    if (!pageUrl) continue;
    let pagePath: string;
    try {
      const parsed = new URL(pageUrl);
      if (!sitemapHostAllowed(parsed.hostname, baseUrl)) continue;
      pagePath = routePath(parsed.pathname);
      routes.push(pagePath);
    } catch {
      continue;
    }

    const pageSlug = normalizeSlug(pagePath);
    for (const imageBlock of block.matchAll(
      /<image:image\b[^>]*>([\s\S]*?)<\/image:image>/gi,
    )) {
      const body = imageBlock[1] ?? '';
      const rawImageUrl = xmlText(
        body.match(/<image:loc>([\s\S]*?)<\/image:loc>/i)?.[1] ?? '',
      );
      const image = normalizeAssetUrl(rawImageUrl);
      if (!image) continue;
      const title = cleanText(
        xmlText(
          body.match(/<image:title>([\s\S]*?)<\/image:title>/i)?.[1] ?? '',
        ),
      );
      const caption = cleanText(
        xmlText(
          body.match(/<image:caption>([\s\S]*?)<\/image:caption>/i)?.[1] ?? '',
        ),
      );
      images.push({
        sourceUrl: image.url,
        pagePath,
        pageSlug,
        title,
        caption,
        imageId: image.id,
        metadataSources: [
          {
            source: 'sitemap',
            method: 'sitemap',
            pageSlug,
            sourceUrl: image.url,
            ...(title ? { title } : {}),
            ...(caption ? { caption } : {}),
          },
        ],
      });
    }
  }

  return { routes: [...new Set(routes)], images };
}

function parseSitemap(text: string, baseUrl: string): string[] {
  return parseSitemapData(text, baseUrl).routes;
}

async function fetchSitemap(
  context: BrowserContext,
  baseUrl: string,
  timeoutMs: number,
): Promise<{
  url: string;
  routes: string[];
  images: SitemapImageRecord[];
  error?: string;
}> {
  const url = `${baseUrl}/sitemap.xml`;
  try {
    const response = await context.request.get(url, { timeout: timeoutMs });
    if (!response.ok())
      return {
        url,
        routes: [],
        images: [],
        error: `Sitemap returned HTTP ${response.status()}`,
      };
    const parsed = parseSitemapData(await response.text(), baseUrl);
    return { url, routes: parsed.routes, images: parsed.images };
  } catch (error) {
    return {
      url,
      routes: [],
      images: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function readPageData(page: Page): Promise<RawPageData> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim();
    const splitTags = (value: string): string[] =>
      value
        .split(/[|,;]/)
        .map((tag) => clean(tag))
        .filter(Boolean);
    const visible = (element: Element): boolean => {
      const html = element as HTMLElement;
      const style = window.getComputedStyle(html);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        html.getBoundingClientRect().width > 0
      );
    };
    const sourceCandidates = (image: HTMLImageElement): string[] => {
      const attributes = [
        'src',
        'data-src',
        'data-image',
        'data-image-url',
        'srcset',
        'data-srcset',
      ];
      const candidates: string[] = [];
      for (const attribute of attributes) {
        const value = image.getAttribute(attribute);
        if (!value) continue;
        if (attribute.endsWith('srcset')) {
          candidates.push(
            ...value
              .split(',')
              .map((candidate) => candidate.trim().split(/\s+/)[0]),
          );
        } else {
          candidates.push(value);
        }
      }
      const link = image.closest('a')?.getAttribute('href');
      if (link && /squarespace-cdn\.com/i.test(link)) candidates.push(link);
      return candidates.filter(Boolean);
    };
    const imageCaption = (image: HTMLImageElement): string => {
      const root = image.closest(
        'figure, [data-caption], .gallery-item, .image-slide, .sqs-gallery-design-block',
      );
      if (!root) return '';
      const caption = root.querySelector(
        'figcaption, [data-caption], .image-caption, .caption',
      );
      return clean(caption?.textContent);
    };
    const imageNodes = [...document.querySelectorAll('img')].filter(
      visible,
    ) as HTMLImageElement[];
    const images: RawLiveImage[] = imageNodes.map((image, order) => {
      const tags = splitTags(
        image.getAttribute('data-tags') ??
          image.getAttribute('data-sqs-tags') ??
          '',
      );
      const width =
        image.naturalWidth || Number(image.getAttribute('width')) || undefined;
      const height =
        image.naturalHeight ||
        Number(image.getAttribute('height')) ||
        undefined;
      return {
        candidates: sourceCandidates(image),
        order,
        title: clean(
          image.getAttribute('title') ?? image.getAttribute('data-title'),
        ),
        caption: imageCaption(image),
        alt: clean(image.getAttribute('alt')),
        tags,
        ...(width ? { observedWidth: width } : {}),
        ...(height ? { observedHeight: height } : {}),
      };
    });
    const links = [...document.querySelectorAll('a')]
      .filter(visible)
      .map((anchor) => ({
        href: anchor.href,
        label: clean(anchor.textContent),
      }))
      .filter((link) => link.href && link.label);
    const navigation = [
      ...document.querySelectorAll(
        'header nav a, nav a, [role="navigation"] a',
      ),
    ]
      .filter(visible)
      .map((anchor) => ({
        href: (anchor as HTMLAnchorElement).href,
        label: clean(anchor.textContent),
      }))
      .filter((link) => link.href);
    const main = document.querySelector('main') ?? document.body;
    const publicText = [...(main?.innerText ?? '').split(/\n+/)]
      .map((line) => clean(line))
      .filter((line) => line.length > 0)
      .slice(0, 300);
    const instagram =
      links.find((link) => /(?:^|\.)instagram\.com\//i.test(link.href))?.href ??
      '';

    return {
      title: clean(document.title),
      description: clean(
        document
          .querySelector('meta[name="description"]')
          ?.getAttribute('content'),
      ),
      canonicalUrl:
        document.querySelector('link[rel="canonical"]')?.getAttribute('href') ??
        '',
      headings: [...document.querySelectorAll('h1, h2, h3')]
        .map((heading) => clean(heading.textContent))
        .filter(Boolean),
      publicText,
      footerText: [
        ...(document.querySelector('footer')?.innerText ?? '').split(/\n+/),
      ]
        .map((line) => clean(line))
        .filter((line) => line.length > 0)
        .slice(0, 100),
      links: links.slice(0, 300),
      navigation: navigation.slice(0, 100),
      instagram,
      images,
    };
  });
}

function normalizeRawImages(
  rawImages: RawLiveImage[],
  pageSlug: string,
): LiveImageRecord[] {
  const records: LiveImageRecord[] = [];
  for (const raw of rawImages) {
    const candidates = raw.candidates
      .map((candidate) => normalizeAssetUrl(candidate))
      .filter(
        (
          candidate,
        ): candidate is NonNullable<ReturnType<typeof normalizeAssetUrl>> =>
          Boolean(candidate),
      );
    const normalized = candidates.at(0);
    if (!normalized) continue;
    const sourceUrls = [
      ...new Set(candidates.map((candidate) => candidate.url)),
    ];
    const record: LiveImageRecord = {
      imageId: normalized.id,
      sourceUrl: normalized.url,
      sourceUrls,
      order: raw.order,
      title: raw.title,
      caption: raw.caption,
      alt: raw.alt,
      tags: raw.tags,
      ...(raw.observedWidth ? { observedWidth: raw.observedWidth } : {}),
      ...(raw.observedHeight ? { observedHeight: raw.observedHeight } : {}),
      metadataSources: [],
    };
    record.metadataSources.push(imageMetadataSource(pageSlug, record));
    records.push(record);
  }
  return records;
}

function classifyLayout(
  pageSlug: string,
  images: LiveImageRecord[],
  publicText: string[],
  headings: string[],
): LivePageRecord['layout'] {
  if (pageSlug === 'contact' && publicText.length > 0) return 'text';
  if (pageSlug === 'about' && images.length > 0) return 'mixed';
  if (images.length > 0) return 'gallery';
  if (headings.length > 1 || publicText.length > 0) return 'text';
  return 'unknown';
}

function screenshotName(
  layout: LivePageRecord['layout'],
  viewport: 'desktop' | 'mobile',
  slug: string,
): string {
  const safeSlug =
    slug.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'home';
  return `${layout}-${viewport}-${safeSlug}.jpg`;
}

async function captureRepresentativeScreenshots(
  page: Page,
  record: LivePageRecord,
  screenshotDir: string,
  seenLayouts: Set<LivePageRecord['layout']>,
): Promise<ScreenshotRecord[]> {
  if (seenLayouts.has(record.layout)) return [];
  seenLayouts.add(record.layout);
  const screenshots: ScreenshotRecord[] = [];
  for (const [viewport, size] of [
    ['desktop', DESKTOP_VIEWPORT],
    ['mobile', MOBILE_VIEWPORT],
  ] as const) {
    await page.setViewportSize(size);
    await page.waitForTimeout(150);
    const filename = screenshotName(record.layout, viewport, record.slug);
    const path = join(screenshotDir, filename);
    await page.screenshot({ path, fullPage: true, type: 'jpeg', quality: 70 });
    screenshots.push({
      layout: record.layout,
      viewport,
      slug: record.slug,
      path: record.path,
      file: path,
    });
  }
  await page.setViewportSize(DESKTOP_VIEWPORT);
  return screenshots;
}

function mergeNavigation(
  baseUrl: string,
  links: Array<{ href: string; label: string }>,
): NavigationEntry[] {
  const entries: NavigationEntry[] = [];
  for (const link of uniqueBy(links, (item) => item.href)) {
    const href = absoluteHttpsUrl(baseUrl, link.href);
    if (!href) continue;
    try {
      const parsed = new URL(href);
      const base = new URL(baseUrl);
      if (parsed.hostname !== base.hostname) continue;
      const path = routePath(parsed.pathname);
      const slug = normalizeSlug(path);
      entries.push({
        label: cleanText(link.label) || slug,
        slug,
        path,
        href,
        order: entries.length,
      });
    } catch {
      // Ignore navigation links which are not valid URLs.
    }
  }
  return entries;
}

async function scrollForLazyImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const delay = (ms: number) =>
      new Promise((resolve) => window.setTimeout(resolve, ms));
    const height = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    );
    for (let y = 0; y <= height; y += Math.max(window.innerHeight, 400)) {
      window.scrollTo(0, y);
      await delay(60);
    }
    window.scrollTo(0, 0);
    await delay(120);
  });
}

export async function crawlPublicSite(
  options: CrawlOptions,
): Promise<CrawlResult> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchedAt = new Date().toISOString();
  const errors: string[] = [];
  const warnings: string[] = [];
  const screenshots: ScreenshotRecord[] = [];
  const pages: LivePageRecord[] = [];
  const navigationLinks: Array<{ href: string; label: string }> = [];
  const instagramCandidates: string[] = [];
  const seenLayouts = new Set<LivePageRecord['layout']>();
  const sitemapUrl = `${baseUrl}/sitemap.xml`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: DESKTOP_VIEWPORT });
    // esbuild may serialize named helper functions inside page.evaluate with
    // its __name helper. Define the helper only in this isolated crawl
    // context; it never reaches recovered content or production output.
    await context.addInitScript({
      content:
        'globalThis.__name = (target, value) => Object.defineProperty(target, "name", { value, configurable: true });',
    });
    await context.route('http://**/*', async (route) => {
      try {
        const upgraded = new URL(route.request().url());
        upgraded.protocol = 'https:';
        await route.continue({ url: upgraded.toString() });
      } catch {
        await route.abort();
      }
    });
    const sitemap = await fetchSitemap(context, baseUrl, timeoutMs);
    if (sitemap.error) errors.push(sitemap.error);
    const routes = [...new Set([...options.routes, ...sitemap.routes])].map(
      routePath,
    );
    if (options.captureScreenshots !== false)
      await mkdir(options.screenshotDir, { recursive: true });

    for (const path of routes) {
      const url = `${baseUrl}${path === '/' ? '' : path}`;
      const page = await context.newPage();
      try {
        const response = await page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: timeoutMs,
        });
        if (!response || response.status() >= 400) {
          errors.push(`${path}: HTTP ${response?.status() ?? 'no response'}`);
          await page.close();
          continue;
        }
        await page
          .waitForLoadState('networkidle', {
            timeout: Math.min(timeoutMs, 10_000),
          })
          .catch(() => undefined);
        await scrollForLazyImages(page);
        const slug = normalizeSlug(path);
        const raw = await readPageData(page);
        const json = await fetchGalleryJson(context, url, timeoutMs, slug);
        if (json.error) warnings.push(galleryJsonWarning(path, json.error));
        if (json.instagram) instagramCandidates.push(json.instagram);
        navigationLinks.push(
          ...raw.navigation,
          ...raw.links.filter((link) =>
            /(?:^|\/)about|contact|portfolio|celebrity|fashion|real-life|food|corporate|reality|country|musician|logie|travel|actor|catalogue|property|interior|conference/i.test(
              link.href,
            ),
          ),
        );
        const domImages = normalizeRawImages(raw.images, slug);
        const images = mergeLiveImages(slug, json.images, domImages);
        const record: LivePageRecord = {
          slug,
          path,
          url,
          title: raw.title,
          description: raw.description,
          canonicalUrl:
            absoluteHttpsUrl(baseUrl, raw.canonicalUrl) ?? raw.canonicalUrl,
          headings: raw.headings,
          publicText: raw.publicText,
          footerText: raw.footerText,
          links: uniqueBy(
            raw.links,
            (link) => `${link.href}\n${link.label}`,
          ).map((link) => {
            const absolute = absoluteHttpsUrl(baseUrl, link.href) ?? link.href;
            const external = (() => {
              try {
                return new URL(absolute).hostname !== new URL(baseUrl).hostname;
              } catch {
                return false;
              }
            })();
            return { href: absolute, label: link.label, external };
          }),
          images,
          layout: classifyLayout(slug, images, raw.publicText, raw.headings),
          fetchedAt,
        };
        pages.push(record);
        if (options.captureScreenshots !== false) {
          screenshots.push(
            ...(await captureRepresentativeScreenshots(
              page,
              record,
              options.screenshotDir,
              seenLayouts,
            )),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${path}: ${message}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
    await context.close();
    const navigation = mergeNavigation(baseUrl, navigationLinks);
    const instagram =
      instagramCandidates[0] ??
      pages
        .flatMap((page) => page.links)
        .find((link) => /instagram\.com/i.test(link.href))?.href ??
      '';
    return {
      status:
        errors.length === 0
          ? 'complete'
          : pages.length > 0
            ? 'partial'
            : 'failed',
      baseUrl,
      sitemapUrl,
      routes,
      navigation,
      sitemapPageCount: sitemap.routes.length,
      sitemapImageCount: sitemap.images.length,
      sitemapImages: sitemap.images,
      pages,
      screenshots,
      instagram,
      errors,
      warnings,
      fetchedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    if (browser) await browser.close().catch(() => undefined);
    return {
      status: 'failed',
      baseUrl,
      sitemapUrl,
      routes: options.routes.map(routePath),
      navigation: [],
      sitemapPageCount: 0,
      sitemapImageCount: 0,
      sitemapImages: [],
      pages: [],
      screenshots,
      instagram: '',
      errors,
      warnings,
      fetchedAt,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

export { parseSitemap };

export function parseSitemapInventory(
  text: string,
  baseUrl: string,
): ParsedSitemap {
  return parseSitemapData(text, baseUrl);
}

export function parsePublicGalleryItems(
  value: unknown,
  pageSlug: string,
): LiveImageRecord[] {
  return formatJsonImages(value, pageSlug);
}
