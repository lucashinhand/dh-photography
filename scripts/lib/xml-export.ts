import { createHash } from 'node:crypto';

import { load, type CheerioAPI } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';

import type {
  MetadataSourceRecord,
  ParsedXmlExport,
  XmlAttachmentRecord,
  XmlPageRecord,
  XmlPlacementRecord,
} from './extraction-types.js';
import {
  firstUrlFromSrcset,
  normalizeAssetUrl,
  normalizeSlug,
  routePath,
} from './url-normalization.js';

type XmlValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | XmlValue[]
  | { [key: string]: XmlValue };

interface ParsedItem {
  title?: XmlValue;
  link?: XmlValue;
  pubDate?: XmlValue;
  'content:encoded'?: XmlValue;
  'wp:post_name'?: XmlValue;
  'wp:post_type'?: XmlValue;
  'wp:post_id'?: XmlValue;
  'wp:status'?: XmlValue;
  'wp:attachment_url'?: XmlValue;
  'wp:post_date'?: XmlValue;
  'dc:creator'?: XmlValue;
}

interface ParsedChannel {
  title?: XmlValue;
  link?: XmlValue;
  description?: XmlValue;
  item?: ParsedItem | ParsedItem[];
}

function asText(value: XmlValue): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value);
  if (Array.isArray(value)) return value.map(asText).join('');
  if ('__cdata' in value) return asText(value.__cdata);
  if ('#text' in value) return asText(value['#text']);
  return '';
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseTags(value: string): string[] {
  return value
    .split(/[|,;]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function sourceCandidates(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
): string[] {
  const attributes = [
    'src',
    'data-src',
    'data-image',
    'data-image-url',
    'data-srcset',
    'srcset',
  ];
  const urls: string[] = [];

  for (const attribute of attributes) {
    const value = $(element).attr(attribute);
    if (!value) continue;
    if (attribute.endsWith('srcset'))
      urls.push(
        ...value
          .split(',')
          .map((candidate) => candidate.trim().split(/\s+/)[0]),
      );
    else urls.push(value);
  }

  const href = $(element).closest('a').attr('href');
  if (href && /squarespace-cdn\.com/i.test(href)) urls.push(href);
  return urls.filter(Boolean);
}

function firstNormalizedImageUrl(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
): string | undefined {
  const rawCandidates = sourceCandidates($, element);
  const srcsetCandidate =
    $(element).attr('srcset') || $(element).attr('data-srcset');
  if (srcsetCandidate) {
    const largest = firstUrlFromSrcset(srcsetCandidate);
    if (largest) rawCandidates.unshift(largest);
  }

  for (const raw of rawCandidates) {
    const normalized = normalizeAssetUrl(raw);
    if (normalized) return normalized.url;
  }
  return undefined;
}

function nearestCaption(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
): string {
  const image = $(element);
  const caption = image
    .closest(
      'figure, [data-caption], .gallery-item, .image-slide, .sqs-gallery-design-block',
    )
    .find('figcaption, [data-caption], .image-caption, .caption')
    .first()
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  if (caption) return caption;

  const parentCaption = image
    .parent('caption')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
  return parentCaption;
}

function sanitizePublicHtml(input: string): string {
  const $ = load(input, {}, false);
  $(
    'script, style, noscript, template, iframe, object, embed, form, input, button, textarea, select',
  ).remove();
  $('img, picture, source, svg').remove();
  $('*').each((_, element) => {
    const attributes = [
      ...((element as { attribs?: Record<string, string> }).attribs
        ? Object.keys(
            (element as { attribs?: Record<string, string> }).attribs ?? {},
          )
        : []),
    ];
    for (const attribute of attributes) {
      if (
        /^on/i.test(attribute) ||
        ['style', 'srcdoc'].includes(attribute.toLowerCase())
      ) {
        $(element).removeAttr(attribute);
      }
    }

    const href = $(element).attr('href');
    if (href && /squarespace(?:-cdn)?\.com/i.test(href)) {
      $(element).replaceWith($(element).contents());
    } else if (href && /^http:\/\//i.test(href)) {
      $(element).attr('href', href.replace(/^http:/i, 'https:'));
    }
  });

  const body = $('body').html();
  return (body ?? $.root().html() ?? '').replace(/\s+$/g, '').trim();
}

function cleanPublicText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function metadataForImage(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
  sourceUrl: string,
  pageSlug: string,
  order: number,
): MetadataSourceRecord {
  const image = $(element);
  const title = cleanPublicText(
    image.attr('title') ?? image.attr('data-title') ?? '',
  );
  const caption = nearestCaption($, element);
  const alt = cleanPublicText(image.attr('alt') ?? '');
  const tags = parseTags(
    image.attr('data-tags') ?? image.attr('data-sqs-tags') ?? '',
  );

  return {
    source: 'xml',
    pageSlug,
    order,
    sourceUrl,
    ...(title ? { title } : {}),
    ...(caption ? { caption } : {}),
    ...(alt ? { alt } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

function itemBodyHtml(item: ParsedItem): string {
  return asText(item['content:encoded']);
}

function itemSlug(item: ParsedItem): string {
  const candidate =
    asText(item['wp:post_name']) || asText(item.link) || asText(item.title);
  return normalizeSlug(candidate);
}

function itemPath(item: ParsedItem): string {
  const link = asText(item.link);
  return routePath(link || itemSlug(item));
}

function createPlacement(
  $: CheerioAPI,
  element: Parameters<CheerioAPI>[0],
  pageSlug: string,
  order: number,
): XmlPlacementRecord | undefined {
  const sourceUrl = firstNormalizedImageUrl($, element);
  if (!sourceUrl) return undefined;
  const normalized = normalizeAssetUrl(sourceUrl);
  if (!normalized) return undefined;
  const metadata = metadataForImage($, element, sourceUrl, pageSlug, order);
  return {
    imageId: normalized.id,
    pageSlug,
    order,
    sourceUrl,
    title: metadata.title ?? '',
    caption: metadata.caption ?? '',
    alt: metadata.alt ?? '',
    tags: metadata.tags ?? [],
    metadataSources: [metadata],
  };
}

export function sanitizeWordpressXml(xml: string): string {
  let sanitized = xml;
  sanitized = sanitized.replace(
    /\s*<wp:author\b[^>]*>[\s\S]*?<\/wp:author>\s*/gi,
    '\n',
  );

  const privateTags = [
    'dc:creator',
    'wp:author_id',
    'wp:author_login',
    'wp:author_email',
    'wp:author_display_name',
    'wp:author_first_name',
    'wp:author_last_name',
    'wp:post_author',
  ];
  for (const tag of privateTags) {
    const escaped = tag.replace(':', '\\:');
    sanitized = sanitized.replace(
      new RegExp(`\\s*<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}>\\s*`, 'gi'),
      '\n',
    );
  }
  return sanitized;
}

export function parseXmlExport(xml: string): ParsedXmlExport {
  const parser = new XMLParser({
    ignoreAttributes: false,
    cdataPropName: '__cdata',
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
  });
  const parsed = parser.parse(xml) as { rss?: { channel?: ParsedChannel } };
  const channel = parsed.rss?.channel ?? {};
  const items = asArray(channel.item);
  const pages: XmlPageRecord[] = [];
  const attachments: XmlAttachmentRecord[] = [];
  const placements: XmlPlacementRecord[] = [];

  for (const item of items) {
    const type = asText(item['wp:post_type']);
    if (type === 'attachment') {
      const sourceUrl = normalizeAssetUrl(
        asText(item['wp:attachment_url']) || asText(item.link),
      );
      if (!sourceUrl) continue;
      attachments.push({
        id: sourceUrl.id,
        sourceUrl: sourceUrl.url,
        title: cleanPublicText(asText(item.title)),
        filename: sourceUrl.filename,
        postName: asText(item['wp:post_name']),
        postDate: asText(item['wp:post_date']) || asText(item.pubDate),
      });
      continue;
    }

    if (type !== 'page' || !['publish', ''].includes(asText(item['wp:status'])))
      continue;
    const slug = itemSlug(item);
    const rawBodyHtml = itemBodyHtml(item);
    const $ = load(rawBodyHtml, {}, false);
    const pagePlacements: XmlPlacementRecord[] = [];
    $('img').each((order, element) => {
      const placement = createPlacement($, element, slug, order);
      if (placement) pagePlacements.push(placement);
    });

    const page: XmlPageRecord = {
      slug,
      path: itemPath(item),
      title: cleanPublicText(asText(item.title)) || slug,
      description: '',
      bodyHtml: sanitizePublicHtml(rawBodyHtml),
      rawBodyHtml,
      placements: pagePlacements,
      sourceItemId: asText(item['wp:post_id']),
      status: asText(item['wp:status']) || 'publish',
    };
    pages.push(page);
    placements.push(...pagePlacements);
  }

  const placementIds = new Set(
    placements.map((placement) => placement.imageId),
  );
  const attachmentIds = new Set(attachments.map((attachment) => attachment.id));

  return {
    channelTitle: cleanPublicText(asText(channel.title)),
    channelLink: asText(channel.link).trim(),
    channelDescription: cleanPublicText(asText(channel.description)),
    pages,
    attachments,
    placements,
    sanitizedXml: sanitizeWordpressXml(xml),
    stats: {
      itemCount: items.length,
      pageCount: pages.length,
      attachmentCount: attachments.length,
      placementCount: placements.length,
      uniquePlacementAssets: placementIds.size,
      attachmentOnlyAssets: [...attachmentIds].filter(
        (id) => !placementIds.has(id),
      ).length,
      placementOnlyAssets: [...placementIds].filter(
        (id) => !attachmentIds.has(id),
      ).length,
    },
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function deriveContactDetails(
  pages: XmlPageRecord[],
  liveInstagram = '',
): {
  email: string;
  phone: string;
  instagram: string;
} {
  const contact = pages.find((page) => page.slug === 'contact');
  const text = contact
    ? cleanPublicText(load(contact.rawBodyHtml, {}, false).text())
    : '';
  const email =
    contact?.rawBodyHtml.match(
      /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?=\s|<|$|[>,;])/i,
    )?.[0] ??
    text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?![A-Z0-9])/i)?.[0] ??
    '';
  const phone =
    text
      .match(/\+?\d[\d ()-]{7,}\d/)?.[0]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  return { email, phone, instagram: liveInstagram };
}
