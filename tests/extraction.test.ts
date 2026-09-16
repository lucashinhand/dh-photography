import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePublicGalleryItems,
  parseSitemapInventory,
  fetchGalleryJson,
  galleryJsonWarning,
} from '../scripts/lib/live-crawl.js';
import { buildReconciliation } from '../scripts/lib/reconcile.js';
import {
  buildReport,
  extractionExitCode,
  parseArgs,
} from '../scripts/extract-squarespace.js';
import {
  parseXmlExport,
  sanitizeWordpressXml,
} from '../scripts/lib/xml-export.js';
import {
  renditionCandidates,
  normalizeAssetUrl,
} from '../scripts/lib/url-normalization.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sanitisedXmlPath = resolve(
  repositoryRoot,
  'migration/recovery/squarespace-export-sanitised.xml',
);

test('parses the namespaced WordPress export and preserves XML image order', async () => {
  const xml = await readFile(sanitisedXmlPath, 'utf8');
  const parsed = parseXmlExport(xml);

  assert.equal(parsed.stats.itemCount, 1094);
  assert.equal(parsed.stats.pageCount, 18);
  assert.equal(parsed.stats.attachmentCount, 1076);
  assert.equal(parsed.stats.placementCount, 1089);
  assert.equal(parsed.stats.uniquePlacementAssets, 1089);
  assert.equal(parsed.pages[0]?.slug, 'portfolio');
  assert.equal(parsed.pages[0]?.placements.length, 66);
  assert.equal(parsed.pages.at(-1)?.slug, 'conference');
  assert.equal(parsed.pages.at(-1)?.placements.length, 184);
  assert.match(
    parsed.pages.find((page) => page.slug === 'about')?.bodyHtml ?? '',
    /David Hahn is a Sydney based photographer/,
  );
  assert.doesNotMatch(
    parsed.pages.find((page) => page.slug === 'portfolio')?.bodyHtml ?? '',
    /<img\b/i,
  );
});

test('groups repeated placements by stable normalized CDN identity', () => {
  const xml = `<?xml version="1.0"?>
    <rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
      <channel>
        <title>Test</title>
        <item><title>one</title><link>/one</link><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
          <content:encoded><![CDATA[<div><img src="http://images.squarespace-cdn.com/content/v1/a/asset.jpg?format=original" /></div>]]></content:encoded>
        </item>
        <item><title>two</title><link>/two</link><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
          <content:encoded><![CDATA[<div><img src="https://images.squarespace-cdn.com/content/v1/a/asset.jpg" /></div>]]></content:encoded>
        </item>
      </channel>
    </rss>`;
  const parsed = parseXmlExport(xml);
  assert.equal(parsed.stats.placementCount, 2);
  assert.equal(parsed.stats.uniquePlacementAssets, 1);
  assert.equal(parsed.placements[0]?.imageId, parsed.placements[1]?.imageId);
  assert.equal(
    parsed.placements[0]?.sourceUrl,
    'https://images.squarespace-cdn.com/content/v1/a/asset.jpg',
  );
});

test('sanitizes author and creator account metadata while retaining public contact copy', async () => {
  const xml = await readFile(sanitisedXmlPath, 'utf8');
  const withPrivateMetadata = xml.replace(
    '<item>',
    '<item><wp:author><wp:login>private-login</wp:login></wp:author><dc:creator>private-creator</dc:creator>',
  );
  assert.notEqual(withPrivateMetadata, xml);
  const sanitized = sanitizeWordpressXml(withPrivateMetadata);
  assert.doesNotMatch(
    sanitized,
    /<wp:author\b|<dc:creator\b|<wp:author_email\b/i,
  );
  assert.match(sanitized, /david@hahn\.net/);
});

test('normalizes HTTP CDN URLs and builds the bounded rendition probe order', () => {
  const http = normalizeAssetUrl(
    'http://images.squarespace-cdn.com/content/v1/site/asset/file%20name.jpg?format=original#fragment',
  );
  const https = normalizeAssetUrl(
    'https://images.squarespace-cdn.com/content/v1/site/asset/file%20name.jpg?format=2500w',
  );
  assert.ok(http);
  assert.ok(https);
  assert.equal(http?.url, https?.url);
  assert.equal(http?.identity, https?.identity);
  assert.deepEqual(
    renditionCandidates(http!.url).map((candidate) => candidate.width),
    [2500, 1500, 1000, 750, 500, 300, 100],
  );
  assert.ok(
    renditionCandidates(http!.url).every((candidate) =>
      candidate.url.startsWith('https://'),
    ),
  );
});

test('accepts canonical-domain sitemap routes and records image metadata without private fields', () => {
  const sitemap = `<?xml version="1.0"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <url><loc>https://www.davidhahnphotography.com.au/celebrity</loc>
        <image:image><image:loc>http://images.squarespace-cdn.com/content/v1/site/id/a.jpg</image:loc><image:title>celebrity - Jane</image:title><image:caption>Portrait</image:caption></image:image>
      </url>
    </urlset>`;
  const parsed = parseSitemapInventory(
    sitemap,
    'https://recorder-nonagon-24ym.squarespace.com',
  );
  assert.deepEqual(parsed.routes, ['/celebrity']);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0]?.pageSlug, 'celebrity');
  assert.equal(parsed.images[0]?.metadataSources[0]?.title, 'celebrity - Jane');
  assert.equal(parsed.images[0]?.metadataSources[0]?.source, 'sitemap');
});

test('allowlists public gallery JSON item metadata and decodes HTML entities', () => {
  const images = parsePublicGalleryItems(
    [
      {
        authorId: 'private-author-id',
        title: 'Jane &amp; John',
        body: '<p>Portrait &amp; studio</p>',
        excerpt: '',
        assetUrl:
          'http://images.squarespace-cdn.com/content/v1/site/id/jane.jpg',
        originalSize: '1600x1200',
        contentType: 'image/jpeg',
        systemDataVariants: '1600x1200,100w,300w',
        tags: ['portrait'],
      },
    ],
    'celebrity',
  );
  assert.equal(images.length, 1);
  assert.equal(images[0]?.title, 'Jane & John');
  assert.equal(images[0]?.caption, 'Portrait & studio');
  assert.equal(images[0]?.observedWidth, 1600);
  assert.equal(images[0]?.observedHeight, 1200);
  assert.equal(images[0]?.metadataSources[0]?.method, 'format-json');
  assert.doesNotMatch(
    JSON.stringify(images),
    /private-author-id|websiteSettings|userAccountsContext/,
  );
});

test('uses live gallery order while retaining XML-only placements after it', () => {
  const xml = `<?xml version="1.0"?>
    <rss xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wp="http://wordpress.org/export/1.2/">
      <channel><title>Test</title>
        <item><title>gallery</title><link>/gallery</link><wp:post_type>page</wp:post_type><wp:status>publish</wp:status>
          <content:encoded><![CDATA[<div><img src="https://images.squarespace-cdn.com/content/v1/a/one.jpg" /><img src="https://images.squarespace-cdn.com/content/v1/a/two.jpg" /></div>]]></content:encoded>
        </item>
      </channel>
    </rss>`;
  const parsed = parseXmlExport(xml);
  const one = parsed.placements[0]!;
  const two = parsed.placements[1]!;
  const crawl = {
    status: 'complete' as const,
    baseUrl: 'https://example.com',
    sitemapUrl: 'https://example.com/sitemap.xml',
    routes: ['/gallery'],
    sitemapPageCount: 1,
    sitemapImageCount: 0,
    sitemapImages: [],
    navigation: [
      {
        label: 'gallery',
        slug: 'gallery',
        path: '/gallery',
        href: 'https://example.com/gallery',
        order: 0,
      },
    ],
    pages: [
      {
        slug: 'gallery',
        path: '/gallery',
        url: 'https://example.com/gallery',
        title: 'gallery — David Hahn Photography',
        description: 'gallery',
        canonicalUrl: 'https://example.com/gallery',
        headings: [],
        publicText: [],
        footerText: [],
        links: [],
        images: [
          {
            imageId: two.imageId,
            sourceUrl: two.sourceUrl,
            sourceUrls: [two.sourceUrl],
            order: 0,
            title: 'Two',
            caption: '',
            alt: 'Two',
            tags: [],
            metadataSources: [
              {
                source: 'live' as const,
                method: 'format-json' as const,
                pageSlug: 'gallery',
                order: 0,
                sourceUrl: two.sourceUrl,
                title: 'Two',
              },
            ],
          },
          {
            imageId: one.imageId,
            sourceUrl: one.sourceUrl,
            sourceUrls: [one.sourceUrl],
            order: 1,
            title: 'One',
            caption: '',
            alt: 'One',
            tags: [],
            metadataSources: [
              {
                source: 'live' as const,
                method: 'format-json' as const,
                pageSlug: 'gallery',
                order: 1,
                sourceUrl: one.sourceUrl,
                title: 'One',
              },
            ],
          },
        ],
        layout: 'gallery' as const,
        fetchedAt: new Date().toISOString(),
      },
    ],
    screenshots: [],
    instagram: '',
    errors: [],
    warnings: [] as string[],
    fetchedAt: new Date().toISOString(),
  };
  const result = buildReconciliation(parsed, crawl);
  assert.equal(result.orderPolicy, 'live');
  assert.deepEqual(
    result.pages[0]?.placements.map((placement) => placement.imageId),
    [two.imageId, one.imageId],
  );
  assert.equal(result.pages[0]?.placements[0]?.title, 'Two');
  assert.equal(result.orderDifferences.length, 1);

  const jsonWarning = galleryJsonWarning('/gallery', 'HTTP 503');
  crawl.warnings = [jsonWarning];
  const report = buildReport(
    crawl.baseUrl,
    'migration/export.xml',
    'test-sha',
    parsed,
    crawl,
    result,
    repositoryRoot,
  );
  assert.deepEqual(report.crawl.warnings, [jsonWarning]);
  assert.ok(report.warnings.includes(jsonWarning));
});

test('propagates a gallery JSON request failure as a public warning', async () => {
  const context = {
    request: {
      get: async () => ({
        ok: () => false,
        status: () => 503,
      }),
    },
  } as unknown as Parameters<typeof fetchGalleryJson>[0];
  const result = await fetchGalleryJson(
    context,
    'https://example.com/gallery',
    1_000,
    'gallery',
  );
  assert.equal(result.error, 'HTTP 503');
  assert.equal(
    galleryJsonWarning('/gallery', result.error ?? ''),
    '/gallery: format=json unavailable (HTTP 503)',
  );
});

test('fails the CLI for partial crawls while allowing explicit no-crawl mode', () => {
  assert.equal(extractionExitCode('partial', false), 1);
  assert.equal(extractionExitCode('failed', false), 1);
  assert.equal(extractionExitCode('skipped', false), 1);
  assert.equal(
    extractionExitCode('skipped', parseArgs(['--no-crawl']).noCrawl),
    0,
  );
  assert.equal(extractionExitCode('complete', false), 0);
});
