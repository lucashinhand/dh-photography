import { siteBase, siteOrigin } from '../lib/deployment';
import { galleryPages, navPages, route, site } from '../lib/site';

export const prerender = true;

export function GET() {
  const paths = [
    '/',
    ...galleryPages().map((page) => `/${page.slug}/`),
    ...navPages()
      .filter((page) => page.kind !== 'gallery')
      .map((page) => `/${page.slug}/`),
  ];
  const urls = [...new Set(paths)].map(
    (path) =>
      `  <url><loc>${new URL(route(path, siteBase), siteOrigin)}</loc></url>`,
  );
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
  ].join('\n');
  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

void site;
