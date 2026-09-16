import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { load } from 'cheerio';

import type {
  Placement,
  Photo,
  PortfolioPage,
  SiteContent,
} from '../content/types';

/**
 * The extractor writes this file after the Squarespace capture is complete.
 * Keeping the empty shape here lets the layout and CI checks run while capture
 * is in progress, without inventing portfolio content in the application.
 */
const EMPTY_SITE: SiteContent = {
  name: 'David Hahn Photography',
  description: '',
  email: '',
  phone: '',
  instagram: '',
  pages: [],
  photos: {},
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function normalisePlacement(value: unknown): Placement | null {
  if (!value || typeof value !== 'object') return null;
  const placement = value as Partial<Placement>;
  const imageId = text(placement.imageId).trim();
  if (!imageId) return null;

  return {
    imageId,
    title: text(placement.title),
    caption: text(placement.caption),
    alt: text(placement.alt),
    tags: Array.isArray(placement.tags)
      ? placement.tags.map(text).filter(Boolean)
      : [],
  };
}

function normalisePage(value: unknown): PortfolioPage | null {
  if (!value || typeof value !== 'object') return null;
  const page = value as Partial<PortfolioPage>;
  const slug = text(page.slug)
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!slug) return null;

  const kind: PortfolioPage['kind'] =
    page.kind === 'about' || page.kind === 'contact' ? page.kind : 'gallery';

  return {
    slug,
    title: text(page.title) || slug.replace(/-/g, ' '),
    kind,
    description: text(page.description),
    bodyHtml: text(page.bodyHtml),
    placements: Array.isArray(page.placements)
      ? page.placements
          .map(normalisePlacement)
          .filter((item): item is Placement => item !== null)
      : [],
  };
}

function normalisePhoto(value: unknown): Photo | null {
  if (!value || typeof value !== 'object') return null;
  const photo = value as Partial<Photo>;
  const large = text(photo.large).trim();
  const thumbnail = text(photo.thumbnail).trim();
  if (!large || !thumbnail) return null;

  return {
    id: text(photo.id).trim(),
    large,
    thumbnail,
    width: integer(photo.width),
    height: integer(photo.height),
    thumbnailWidth: integer(photo.thumbnailWidth),
    thumbnailHeight: integer(photo.thumbnailHeight),
  };
}

function loadSite(): SiteContent {
  const sourcePath =
    process.env.SITE_CONTENT_PATH ||
    join(process.cwd(), 'src', 'content', 'site.json');
  const production = process.env.NODE_ENV === 'production';
  if (!existsSync(sourcePath)) {
    if (production) {
      throw new Error(`Missing extracted site content at ${sourcePath}`);
    }
    return EMPTY_SITE;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(sourcePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('site.json must contain an object');
    }
    const source = parsed as Partial<SiteContent>;
    if (
      !Array.isArray(source.pages) ||
      !source.photos ||
      typeof source.photos !== 'object'
    ) {
      throw new Error('site.json must contain pages and photos collections');
    }

    const pages = source.pages
      .map(normalisePage)
      .filter((item): item is PortfolioPage => item !== null);
    const photos: Record<string, Photo> = {};
    if (source.photos && typeof source.photos === 'object') {
      for (const [id, value] of Object.entries(source.photos)) {
        const photo = normalisePhoto(value);
        if (photo) photos[id] = { ...photo, id: photo.id || id };
      }
    }

    const loaded: SiteContent = {
      name: text(source.name) || EMPTY_SITE.name,
      description: text(source.description),
      email: text(source.email),
      phone: text(source.phone),
      instagram: text(source.instagram),
      pages,
      photos,
    };
    if (production && loaded.pages.length === 0) {
      throw new Error('site.json contains no valid pages');
    }
    return loaded;
  } catch {
    // An incomplete export should leave the development shell usable. The
    // migration validator reports malformed content separately.
    if (production) {
      throw new Error(`Unable to load extracted site content at ${sourcePath}`);
    }
    return EMPTY_SITE;
  }
}

export const site = loadSite();

export function pageForSlug(slug: string): PortfolioPage | undefined {
  const normalised = slug.replace(/^\/+|\/+$/g, '');
  return site.pages.find((page) => page.slug === normalised);
}

export function homePage(): PortfolioPage | undefined {
  return (
    site.pages.find((page) => page.slug === 'portfolio') ??
    site.pages.find((page) => page.slug === 'home') ??
    site.pages.find((page) => page.kind === 'gallery')
  );
}

export function galleryPages(): PortfolioPage[] {
  return site.pages.filter(
    (page) =>
      page.kind === 'gallery' &&
      page.slug !== 'home' &&
      page.slug !== 'portfolio',
  );
}

export function navPages(): PortfolioPage[] {
  return site.pages.filter(
    (page) => page.slug !== 'home' && page.slug !== 'portfolio',
  );
}

export function photoFor(placement: Placement): Photo | undefined {
  return site.photos[placement.imageId];
}

export function basePath(): string {
  return (
    process.env.SITE_BASE || process.env.PUBLIC_BASE_PATH || '/dh-photography/'
  );
}

function normaliseBase(base: string): string {
  if (!base || base === '/') return '/';
  return `/${base.replace(/^\/+|\/+$/g, '')}/`;
}

/** Prefix a local path with Astro's configured base path. */
export function withBase(pathname: string, base = basePath()): string {
  if (!pathname) return normaliseBase(base);
  if (/^(?:https?:)?\/\//i.test(pathname) || pathname.startsWith('data:'))
    return pathname;

  const prefix = normaliseBase(base);
  const cleanPath = pathname.replace(/^\/+/, '');
  if (
    prefix !== '/' &&
    (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix))
  ) {
    return pathname;
  }
  if (pathname === '/') return prefix;
  return `${prefix}${cleanPath}`;
}

/** Resolve content paths without allowing a stale Squarespace URL into production. */
export function assetUrl(source: string, base = basePath()): string {
  if (!source || /^(?:https?:)?\/\//i.test(source)) return '';
  return withBase(source, base);
}

// eslint-disable-next-line no-control-regex -- Strip URL control characters before validating the scheme.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Keep authored links usable without allowing executable URL schemes. */
function safeHref(value: string): string | undefined {
  const cleaned = value.replace(CONTROL_CHARACTERS, '').trim();
  if (!cleaned) return '';

  const scheme = cleaned.match(/^([a-z][a-z\d+.-]*):/i)?.[1].toLowerCase();
  if (
    scheme &&
    scheme !== 'http' &&
    scheme !== 'https' &&
    scheme !== 'mailto' &&
    scheme !== 'tel'
  ) {
    return undefined;
  }
  if (cleaned.startsWith('//')) return `https:${cleaned}`;
  if (scheme === 'http') return cleaned.replace(/^http:/i, 'https:');
  return cleaned;
}

function sanitizeHrefAttributes(html: string): string {
  const $ = load(html, {}, false);
  $('*').each((_, element) => {
    const href = $(element).attr('href');
    if (href === undefined) return;
    const sanitized = safeHref(href);
    if (sanitized === undefined) $(element).removeAttr('href');
    else $(element).attr('href', sanitized);
  });
  return ($('body').html() ?? $.root().html() ?? '').trim();
}

/**
 * Body HTML is authored by the migration extractor. Remove executable/embed
 * elements and remote images so the static site never depends on Squarespace
 * at runtime. Gallery placements render recovered photographs separately.
 */
export function safeBodyHtml(html: string): string {
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<form\b[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/\[caption\b[\s\S]*?\[\/caption\]/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(
      /\s(?:href|src)\s*=\s*["'][^"']*squarespace(?:-cdn)?\.com[^"']*["']/gi,
      '',
    );
  return sanitizeHrefAttributes(stripped)
    .replace(/<h1\b/gi, '<h2')
    .replace(/<\/h1>/gi, '</h2>')
    .replace(/\son[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, '');
}

export function route(pathname: string, base = basePath()): string {
  const normalised =
    pathname === '/' ? '/' : `/${pathname.replace(/^\/+|\/+$/g, '')}/`;
  return withBase(normalised, base);
}
