import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { assetUrl, route, safeBodyHtml, withBase } from '../src/lib/site';

test('base path helpers preserve root and avoid duplicate prefixes', () => {
  assert.equal(withBase('/', '/dh-photography/'), '/dh-photography/');
  assert.equal(
    withBase('/about/', '/dh-photography/'),
    '/dh-photography/about/',
  );
  assert.equal(
    withBase('/dh-photography/about/', '/dh-photography/'),
    '/dh-photography/about/',
  );
  assert.equal(withBase('/about/', '/'), '/about/');
  assert.equal(route('about', '/dh-photography/'), '/dh-photography/about/');
  assert.equal(route('/', '/'), '/');
});

test('asset URLs resolve local files and reject stale remote image sources', () => {
  assert.equal(
    assetUrl('/images/example.webp', '/dh-photography/'),
    '/dh-photography/images/example.webp',
  );
  assert.equal(assetUrl('images/example.webp', '/'), '/images/example.webp');
  assert.equal(
    assetUrl(
      'https://images.squarespace-cdn.com/example.jpg',
      '/dh-photography/',
    ),
    '',
  );
  assert.equal(assetUrl('//images.squarespace-cdn.com/example.jpg', '/'), '');
});

test('recovered body HTML removes embeds and keeps one page heading hierarchy', () => {
  const html = safeBodyHtml(
    '<h1>About David</h1><img src="https://images.squarespace-cdn.com/photo.jpg">' +
      '<a href="https://www.squarespace.com/legacy">Legacy</a>' +
      '<script>alert(1)</script>[caption id="x"]David[/caption]<p>Copy</p>',
  );
  assert.match(html, /<h2>About David<\/h2>/);
  assert.doesNotMatch(html, /<h1|<img|<script|\[caption|squarespace/i);
  assert.match(html, /<p>Copy<\/p>/);
});

test('recovered body HTML keeps safe links and removes executable schemes', () => {
  const html = safeBodyHtml(
    '<a href="http://example.com/public">HTTP</a>' +
      '<a href="/about/">Relative</a>' +
      '<a href="#details">Fragment</a>' +
      '<a href="mailto:david@example.com">Email</a>' +
      '<a href="tel:+61401143836">Phone</a>' +
      '<a href="java\u0000script:alert(1)">JavaScript</a>' +
      '<a href="java&#115;cript:alert(2)">Encoded JavaScript</a>' +
      '<a href="data:text/html,unsafe">Data</a>' +
      '<a href="vbscript:msgbox(1)">VBScript</a>',
  );
  assert.match(html, /href="https:\/\/example\.com\/public"/);
  assert.match(html, /href="\/about\/"/);
  assert.match(html, /href="#details"/);
  assert.match(html, /href="mailto:david@example\.com"/);
  assert.match(html, /href="tel:\+61401143836"/);
  assert.doesNotMatch(
    html,
    /href\s*=\s*["'][^"']*(?:javascript|data|vbscript)/i,
  );
});

test('production loader fails closed for missing or malformed extracted content', () => {
  const contentPath = path.resolve(
    'migration/recovery/squarespace-export-sanitised.xml',
  );
  assert.equal(existsSync(contentPath), true);
  const source = "import './src/lib/site.ts';";
  assert.throws(() =>
    execFileSync(process.execPath, ['--import', 'tsx', '--eval', source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        SITE_CONTENT_PATH: contentPath,
      },
      stdio: 'pipe',
    }),
  );
});
