import { readFile, readdir, stat, lstat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { load } from 'cheerio';
import type { SiteContent } from '../src/content/types.js';

const MAX_BYTES = 750_000_000;
const MAX_FILE = 50_000_000;
const errors: string[] = [];
const root = process.cwd();
const tracked = [
  ...new Set(
    execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { encoding: 'utf8' },
    )
      .split('\0')
      .filter(Boolean),
  ),
];
for (const path of tracked) {
  const info = await lstat(path);
  check(!info.isSymbolicLink(), `Unexpected symlink: ${path}`);
  if (info.isSymbolicLink()) continue;
  check(
    !/^migration\/(?:downloads|private)\//.test(path) &&
      !/^migration\/source\/Squarespace-Wordpress-Export-/.test(path),
    `Private recovery input is tracked: ${path}`,
  );
  check(
    !/(?:^|\/)\.env(?:\.|$)/.test(path) || path.endsWith('.env.example'),
    `Environment file is tracked: ${path}`,
  );
  if (!/\.(?:md|json|xml|ts|tsx|js|mjs|astro|ya?ml|css|svg)$/.test(path))
    continue;
  const text = await readFile(path, 'utf8');
  if (path.startsWith('migration/'))
    check(
      !/(?:\/(?:Users|home|private|tmp)\/|[a-z]:[\\/]+Users[\\/]+)/i.test(text),
      `Local filesystem path in public recovery: ${path}`,
    );
  check(
    !/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(
      text,
    ),
    `Possible secret in tracked text: ${path}`,
  );
}
const sanitizedExport = await readFile(
  'migration/recovery/squarespace-export-sanitised.xml',
  'utf8',
);
check(
  !/<(?:wp:author(?:_[a-z_]+)?|dc:creator|wp:post_author)\b/i.test(
    sanitizedExport,
  ),
  'Account metadata remains in the sanitised XML.',
);
const site = JSON.parse(
  await readFile('src/content/site.json', 'utf8'),
) as SiteContent;
const checked = new Set<string>();
const hashes = new Map<string, string>();

function check(condition: unknown, message: string) {
  if (!condition) errors.push(message);
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        errors.push(`Unexpected symlink: ${path}`);
        return [];
      }
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

check(site.pages.length >= 18, 'Fewer than the 18 baseline pages recovered.');
check(
  new Set(site.pages.map((page) => page.slug)).size === site.pages.length,
  'Duplicate page slug.',
);
check(site.name === 'David Hahn Photography', 'Unexpected site name.');
const reconciliation = JSON.parse(
  await readFile('migration/recovery/reconciliation.json', 'utf8'),
) as { pages: Array<{ slug: string; placements: Array<{ imageId: string }> }> };
const live = JSON.parse(
  await readFile('migration/recovery/live-pages.json', 'utf8'),
) as { pages: Array<{ slug: string; images: Array<{ imageId: string }> }> };
for (const recovered of reconciliation.pages) {
  const current = site.pages.find((page) => page.slug === recovered.slug);
  check(Boolean(current), `Recovered route missing: ${recovered.slug}`);
  const currentIds = current?.placements.map((placement) => placement.imageId);
  check(
    JSON.stringify(currentIds) ===
      JSON.stringify(
        recovered.placements.map((placement) => placement.imageId),
      ),
    `Placement reconciliation mismatch: ${recovered.slug}`,
  );
  const displayed = live.pages.find((page) => page.slug === recovered.slug);
  if (displayed) {
    const liveIds = displayed.images.map((image) => image.imageId);
    check(
      JSON.stringify(currentIds?.slice(0, liveIds.length)) ===
        JSON.stringify(liveIds),
      `Live gallery order mismatch: ${recovered.slug}`,
    );
  }
}
let placements = 0;
for (const page of site.pages) {
  check(Boolean(page.title), `Missing title: ${page.slug}`);
  check(
    !/<(?:script|iframe|form)\b|\bon\w+\s*=/i.test(page.bodyHtml),
    `Unsafe recovered body: ${page.slug}`,
  );
  for (const placement of page.placements) {
    placements++;
    check(
      Boolean(site.photos[placement.imageId]),
      `Missing image ${placement.imageId} on ${page.slug}`,
    );
  }
}
check(
  placements >= 1089,
  `Only ${placements} image placements; XML baseline has 1089.`,
);
let imageBytes = 0;
for (const photo of Object.values(site.photos)) {
  for (const [field, width, height, limit] of [
    ['large', photo.width, photo.height, 2500],
    ['thumbnail', photo.thumbnailWidth, photo.thumbnailHeight, 640],
  ] as const) {
    const url = photo[field];
    check(
      /^\/?images\/[a-zA-Z0-9._-]+\.webp$/.test(url),
      `Unsafe asset path: ${url}`,
    );
    const path = resolve('public', url.replace(/^\//, ''));
    if (!path.startsWith(resolve('public/images') + '/')) continue;
    try {
      const buffer = await readFile(path);
      const metadata = await sharp(buffer).metadata();
      check(metadata.format === 'webp', `Not WebP: ${path}`);
      check(
        metadata.width === width && metadata.height === height,
        `Incorrect dimensions: ${path}`,
      );
      check(
        width <= limit && width > 0 && height > 0,
        `Invalid image bounds: ${path}`,
      );
      check(
        !metadata.exif && !metadata.xmp && !metadata.iptc,
        `Embedded private metadata: ${path}`,
      );
      check(buffer.length < MAX_FILE, `Image exceeds 50 MB: ${path}`);
      if (!checked.has(path)) {
        checked.add(path);
        imageBytes += buffer.length;
        const hash = createHash('sha256').update(buffer).digest('hex');
        const existing = hashes.get(hash);
        check(!existing, `Duplicate serving files: ${existing} and ${path}`);
        hashes.set(hash, path);
      }
    } catch (error) {
      errors.push(`Unreadable image ${url}: ${String(error)}`);
    }
  }
}
const imageManifest = JSON.parse(
  await readFile('migration/manifests/images.json', 'utf8'),
) as {
  status: string;
  sourceCount: number;
  images: Array<{
    photoIds: string[];
    large: { path: string; sha256: string };
    thumbnail: { path: string; sha256: string };
  }>;
};
check(
  imageManifest.status === 'complete',
  'Image import manifest is incomplete.',
);
check(
  imageManifest.sourceCount === Object.keys(site.photos).length,
  'Image manifest source count differs from site content.',
);
const manifestIds = new Set<string>();
for (const record of imageManifest.images) {
  for (const variant of [record.large, record.thumbnail]) {
    const assetPath = resolve('public', variant.path.replace(/^\//, ''));
    check(
      hashes.get(variant.sha256) === assetPath,
      `Serving checksum differs from manifest: ${variant.path}`,
    );
  }
  for (const id of record.photoIds) {
    manifestIds.add(id);
    check(
      site.photos[id]?.large === record.large.path &&
        site.photos[id]?.thumbnail === record.thumbnail.path,
      `Photo alias differs from manifest: ${id}`,
    );
  }
}
check(
  manifestIds.size === Object.keys(site.photos).length,
  'Image manifest aliases do not cover all photo IDs.',
);
const stored = await files('public/images');
check(
  stored.length === checked.size,
  `Unreferenced assets: ${stored.length} files, ${checked.size} referenced.`,
);
check(imageBytes < MAX_BYTES, `Serving images exceed 750 MB: ${imageBytes}`);
const sourceFiles = tracked;
let repositoryBytes = 0;
for (const path of sourceFiles) {
  const size = (await lstat(path)).size;
  repositoryBytes += size;
  check(size < MAX_FILE, `File exceeds 50 MB: ${path}`);
}
check(
  repositoryBytes < MAX_BYTES,
  `Repository payload exceeds 750 MB: ${repositoryBytes}`,
);
const readme = await readFile('README.md', 'utf8');
check(
  readme.includes('Photography and site content © 2026 David Hahn.'),
  'Missing photography copyright.',
);
check(
  readme.includes('Website source code © 2026 Lucas Hahn.'),
  'Missing code copyright.',
);
check(
  !(await readdir(root)).some((name) => /^licen[cs]e(?:\.|$)/i.test(name)),
  'Unexpected licence file.',
);

let buildBytes: number | undefined;
if (process.argv.includes('--build')) {
  const output = await files('dist');
  buildBytes = 0;
  const base = process.env.SITE_BASE ?? '/dh-photography/';
  const origin = process.env.SITE_ORIGIN ?? 'https://lucashahn.dev';
  const baseUrl = new URL(base, origin);
  for (const path of output) {
    const buffer = await readFile(path);
    buildBytes += buffer.length;
    if (!path.endsWith('.html')) continue;
    const html = buffer.toString();
    const $ = load(html);
    check(
      !/squarespace(?:-cdn)?\.com/i.test(html),
      `Squarespace URL in built HTML: ${path}`,
    );
    check(Boolean($('title').text()), `Missing page title: ${path}`);
    check(
      Boolean($('meta[name="description"]').attr('content')),
      `Missing page description: ${path}`,
    );
    const canonical = $('link[rel="canonical"]').attr('href');
    check(
      Boolean(canonical?.startsWith(baseUrl.href)),
      `Wrong canonical base: ${path} (${canonical})`,
    );
    const currentUrl = new URL(
      relative('dist', path).replace(/index\.html$/, ''),
      baseUrl,
    );
    for (const element of $(
      'a[href], img[src], script[src], link[href]',
    ).toArray()) {
      const value = $(element).attr('href') ?? $(element).attr('src');
      if (!value || /^(mailto:|tel:|data:|#)/i.test(value)) continue;
      const url = new URL(value, currentUrl);
      if (url.origin !== baseUrl.origin) continue;
      check(
        url.pathname.startsWith(base),
        `URL escapes base path in ${path}: ${value}`,
      );
      if (!url.pathname.startsWith(base)) continue;
      const local = decodeURIComponent(url.pathname.slice(base.length));
      let target = resolve('dist', local);
      if (!target.startsWith(resolve('dist'))) {
        errors.push(`Unsafe link: ${value}`);
        continue;
      }
      try {
        if ((await stat(target)).isDirectory())
          target = join(target, 'index.html');
        await stat(target);
      } catch {
        errors.push(`Broken built link in ${path}: ${value}`);
      }
    }
  }
  check(buildBytes < MAX_BYTES, `Build exceeds 750 MB: ${buildBytes}`);
  for (const required of ['sitemap.xml', 'robots.txt', '404.html']) {
    try {
      await stat(join('dist', required));
    } catch {
      errors.push(`Missing ${required}`);
    }
  }
}
console.log(
  JSON.stringify(
    {
      pages: site.pages.length,
      placements,
      photoIds: Object.keys(site.photos).length,
      servingFiles: checked.size,
      imageBytes,
      repositoryBytes,
      buildBytes,
      errors,
    },
    null,
    2,
  ),
);
if (errors.length) process.exitCode = 1;
