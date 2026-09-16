import { siteBase, siteOrigin } from '../lib/deployment';
import { site, withBase } from '../lib/site';

export const prerender = true;

export function GET() {
  const sitemap = new URL(withBase('/sitemap.xml', siteBase), siteOrigin);
  return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${sitemap}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

void site;
