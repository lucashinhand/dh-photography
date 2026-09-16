import { createHash } from 'node:crypto';

import { RENDITION_WIDTHS, type RenditionWidth } from './extraction-types.js';

const URL_BASE = 'https://recorder-nonagon-24ym.squarespace.com/';
const SQUARESPACE_CDN_HOST = /(?:^|\.)squarespace-cdn\.com$/i;
const SQUARESPACE_IMAGE_HOST = /(?:^|\.)squarespace(?:-cdn)?\.com$/i;

export interface NormalizedAssetUrl {
  url: string;
  identity: string;
  id: string;
  filename: string;
  host: string;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isSquarespaceAssetUrl(value: string): boolean {
  try {
    const url = new URL(value, URL_BASE);
    return (
      SQUARESPACE_CDN_HOST.test(url.hostname) ||
      SQUARESPACE_IMAGE_HOST.test(url.hostname)
    );
  } catch {
    return false;
  }
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeFilename(pathname: string, id: string): string {
  const decoded = decodePath(pathname);
  const basename = decoded.split('/').filter(Boolean).at(-1) ?? '';
  const withoutQuery = basename.split('?')[0];
  const cleaned = withoutQuery
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || `${id}.jpg`;
}

/**
 * Strip Squarespace's rendition query parameters and normalize all CDN URLs
 * to HTTPS. The returned URL is the stable source URL; use renditionUrl for
 * a bounded size probe.
 */
export function normalizeAssetUrl(
  raw: string,
  baseUrl = URL_BASE,
): NormalizedAssetUrl | null {
  const candidate = raw.trim();
  if (!candidate || !isHttpUrl(candidate)) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate, baseUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (
    !SQUARESPACE_CDN_HOST.test(parsed.hostname) &&
    !SQUARESPACE_IMAGE_HOST.test(parsed.hostname)
  ) {
    return null;
  }

  parsed.protocol = 'https:';
  parsed.hash = '';
  parsed.search = '';

  const url = parsed.toString();
  const identity = `${parsed.hostname.toLowerCase()}${decodePath(parsed.pathname).replace(/\/+/g, '/')}`;
  const id = `image-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;

  return {
    url,
    identity,
    id,
    filename: safeFilename(parsed.pathname, id),
    host: parsed.hostname.toLowerCase(),
  };
}

export function renditionUrl(sourceUrl: string, width: RenditionWidth): string {
  const normalized = normalizeAssetUrl(sourceUrl);
  if (!normalized)
    throw new Error(
      `Cannot create a Squarespace rendition URL from ${sourceUrl}`,
    );

  const url = new URL(normalized.url);
  url.searchParams.set('format', `${width}w`);
  return url.toString();
}

export function renditionCandidates(
  sourceUrl: string,
): Array<{ width: RenditionWidth; url: string }> {
  return RENDITION_WIDTHS.map((width) => ({
    width,
    url: renditionUrl(sourceUrl, width),
  }));
}

export function parseSrcset(value: string): string[] {
  return value
    .split(',')
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export function firstUrlFromSrcset(value: string): string | undefined {
  const candidates = parseSrcset(value);
  return candidates.at(-1) ?? candidates.at(0);
}

export function normalizeSlug(value: string): string {
  let candidate = value.trim();
  try {
    if (isHttpUrl(candidate)) candidate = new URL(candidate).pathname;
  } catch {
    // The fallback below handles a malformed or relative route.
  }

  candidate = candidate.split('?')[0].split('#')[0];
  candidate = decodePath(candidate).replace(/^\/+|\/+$/g, '');
  if (!candidate || candidate === 'index.html') return 'portfolio';
  return candidate.split('/').filter(Boolean).join('/');
}

export function routePath(slug: string): string {
  const normalized = normalizeSlug(slug);
  return `/${normalized}`;
}

export function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value);
  parsed.protocol = 'https:';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}
