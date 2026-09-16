import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  downloadSource,
  encodeImagePair,
  estimateServingBytes,
  fallbackUrls,
  inspectImage,
  assertEncodedFileSize,
  MAX_SERVING_FILE_BYTES,
  processSite,
  type InputSite,
} from '../scripts/process-images.js';

async function tempDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'dh-photography-images-'));
}

async function jpegBuffer(
  width: number,
  height: number,
  orientation?: number,
  metadata = false,
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 80, b: 40 },
    },
  });
  if (orientation === undefined && !metadata)
    return image.jpeg({ quality: 92 }).toBuffer();
  return image
    .withMetadata(orientation === undefined ? {} : { orientation })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function responseFor(
  buffer: Buffer,
  contentType = 'image/jpeg',
  status = 200,
): Response {
  return new Response(buffer as unknown as BodyInit, {
    status,
    headers: { 'content-type': contentType },
  });
}

async function writeMinimalProcessorFixture(directory: string): Promise<{
  sitePath: string;
  assetsPath: string;
  manifestPath: string;
  budgetProjectionPath: string;
  downloadsDirectory: string;
  outputDirectory: string;
}> {
  const sitePath = path.join(directory, 'site.json');
  const assetsPath = path.join(directory, 'assets.json');
  const manifestPath = path.join(directory, 'images.json');
  const budgetProjectionPath = path.join(directory, 'budget-projection.json');
  const downloadsDirectory = path.join(directory, 'downloads');
  const outputDirectory = path.join(directory, 'public', 'images');
  const site: InputSite = {
    name: 'David Hahn Photography',
    description: '',
    email: '',
    phone: '',
    instagram: '',
    pages: [],
    photos: {},
  };
  const assets = {
    schemaVersion: 1,
    generatedAt: '2026-09-16T00:00:00.000Z',
    source: {
      baseUrl: 'https://cdn.example.test',
      xmlPath: 'export.xml',
      xmlSha256: 'test',
    },
    policy: {
      sourceProtocol: 'https' as const,
      requestedWidths: [2500, 1500, 1000, 750, 500, 300, 100] as const,
      preferredWidth: 2500 as const,
      maxCommittedWidth: 2500 as const,
      originalDownloads: 'excluded' as const,
    },
    assets: [
      {
        id: 'photo-one',
        identity: 'photo-one',
        sourceUrl: 'https://cdn.example.test/photo.jpg',
        originalFilename: 'photo.jpg',
        filename: 'photo.jpg',
        pageSlugs: [],
        placementCount: 0,
        sourceUrls: ['https://cdn.example.test/photo.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
    ],
  };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`);
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(
    budgetProjectionPath,
    `${JSON.stringify({ assets: { large: { gallery_weighted_average_bytes: 100 }, thumbnail: { gallery_weighted_average_bytes: 50 } } }, null, 2)}\n`,
  );
  return {
    sitePath,
    assetsPath,
    manifestPath,
    budgetProjectionPath,
    downloadsDirectory,
    outputDirectory,
  };
}

test('fallback URLs use HTTPS and the bounded Squarespace format sequence', () => {
  const urls = fallbackUrls('http://images.example.test/photo.jpg?foo=bar');
  assert.deepEqual(
    urls.map((url) => new URL(url).searchParams.get('format')),
    ['2500w', '1500w', '1000w', '750w', '500w', '300w', '100w'],
  );
  assert.ok(urls.every((url) => url.startsWith('https://')));
  assert.ok(
    urls.every((url) => new URL(url).searchParams.get('foo') === 'bar'),
  );
});

test('encoding auto-orients, converts to sRGB, strips metadata, and does not upscale', async () => {
  const directory = await tempDirectory();
  const sourcePath = path.join(directory, 'orientation.jpg');
  await writeFile(sourcePath, await jpegBuffer(80, 40, 6));

  const pair = await encodeImagePair(sourcePath);
  const largeMetadata = await sharp(pair.large.data).metadata();
  const thumbnailMetadata = await sharp(pair.thumbnail.data).metadata();

  assert.equal(largeMetadata.format, 'webp');
  assert.equal(largeMetadata.width, 40);
  assert.equal(largeMetadata.height, 80);
  assert.equal(largeMetadata.space, 'srgb');
  assert.equal(largeMetadata.orientation, undefined);
  assert.equal(largeMetadata.exif, undefined);
  assert.equal(largeMetadata.iptc, undefined);
  assert.equal(largeMetadata.xmp, undefined);
  assert.equal(thumbnailMetadata.width, 40);
  assert.equal(thumbnailMetadata.height, 80);
  assert.equal(thumbnailMetadata.orientation, undefined);
});

test('small landscape images remain at source size and thumbnails derive from large', async () => {
  const directory = await tempDirectory();
  const sourcePath = path.join(directory, 'small.jpg');
  await writeFile(sourcePath, await jpegBuffer(120, 80));

  const pair = await encodeImagePair(sourcePath);
  const largeMetadata = await sharp(pair.large.data).metadata();
  const thumbnailMetadata = await sharp(pair.thumbnail.data).metadata();

  assert.equal(largeMetadata.width, 120);
  assert.equal(largeMetadata.height, 80);
  assert.equal(thumbnailMetadata.width, 120);
  assert.equal(thumbnailMetadata.height, 80);
});

test('encoded serving files must remain below the per-file cap', () => {
  assert.doesNotThrow(() =>
    assertEncodedFileSize(MAX_SERVING_FILE_BYTES - 1, 'large'),
  );
  assert.throws(
    () => assertEncodedFileSize(MAX_SERVING_FILE_BYTES, 'large'),
    /must be smaller than 50000000 bytes/,
  );
  assert.throws(
    () => assertEncodedFileSize(MAX_SERVING_FILE_BYTES + 1, 'thumbnail'),
    /thumbnail.*must be smaller than 50000000 bytes/,
  );
});

test('inspection trusts decoded format and dimensions rather than the URL extension', async () => {
  const png = await sharp({
    create: {
      width: 23,
      height: 17,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 0.8 },
    },
  })
    .png()
    .toBuffer();
  const inspection = await inspectImage(png);
  assert.equal(inspection.format, 'png');
  assert.equal(inspection.mime, 'image/png');
  assert.equal(inspection.width, 23);
  assert.equal(inspection.height, 17);
});

test('download rejects an HTTP redirect before making the downgraded request', async () => {
  const directory = await tempDirectory();
  const requestedUrls: string[] = [];
  await assert.rejects(
    downloadSource('https://cdn.example.test/photo.jpg', {
      downloadsDirectory: path.join(directory, 'downloads'),
      retryCount: 1,
      fetchImpl: async (url) => {
        requestedUrls.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example.test/photo.jpg' },
        });
      },
    }),
    /non-HTTPS image redirect/,
  );
  assert.equal(requestedUrls.length, 1);
  assert.equal(
    new URL(requestedUrls[0] ?? '').searchParams.get('format'),
    '2500w',
  );
});

test('duplicate source content creates one asset while preserving every placement alias', async () => {
  const directory = await tempDirectory();
  const sitePath = path.join(directory, 'site.json');
  const assetsPath = path.join(directory, 'assets.json');
  const manifestPath = path.join(directory, 'images.json');
  const budgetProjectionPath = path.join(directory, 'budget-projection.json');
  const downloadsDirectory = path.join(directory, 'downloads');
  const outputDirectory = path.join(directory, 'public', 'images');
  const source = await jpegBuffer(96, 64);
  const pages = [
    {
      slug: 'first',
      title: 'First',
      kind: 'gallery' as const,
      description: '',
      bodyHtml: '',
      placements: [
        {
          imageId: 'photo-one',
          title: 'One',
          caption: '',
          alt: 'One',
          tags: [],
        },
      ],
    },
    {
      slug: 'second',
      title: 'Second',
      kind: 'gallery' as const,
      description: '',
      bodyHtml: '',
      placements: [
        {
          imageId: 'photo-two',
          title: 'Two',
          caption: '',
          alt: 'Two',
          tags: [],
        },
      ],
    },
  ];
  const site: InputSite = {
    name: 'David Hahn Photography',
    description: '',
    email: '',
    phone: '',
    instagram: '',
    pages,
    photos: {
      'photo-one': {
        id: 'photo-one',
        sourceUrl: 'https://cdn.example.test/legacy.jpg',
        sourceUrls: ['https://cdn.example.test/legacy.jpg'],
        originalFilename: 'legacy.jpg',
      },
    },
  };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`);
  const assets = {
    schemaVersion: 1,
    generatedAt: '2026-09-16T00:00:00.000Z',
    source: {
      baseUrl: 'https://cdn.example.test',
      xmlPath: 'export.xml',
      xmlSha256: 'test',
    },
    policy: {
      sourceProtocol: 'https',
      requestedWidths: [2500, 1500, 1000, 750, 500, 300, 100],
      preferredWidth: 2500,
      maxCommittedWidth: 2500,
      originalDownloads: 'excluded',
    },
    assets: [
      {
        id: 'photo-one',
        identity: 'first',
        sourceUrl: 'http://cdn.example.test/first.jpg',
        originalFilename: 'first.jpg',
        filename: 'first.jpg',
        pageSlugs: ['first'],
        placementCount: 1,
        sourceUrls: ['http://cdn.example.test/first.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
      {
        id: 'photo-two',
        identity: 'second',
        sourceUrl: 'https://cdn.example.test/second.jpg',
        originalFilename: 'second.jpg',
        filename: 'second.jpg',
        pageSlugs: ['second'],
        placementCount: 1,
        sourceUrls: ['https://cdn.example.test/second.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
    ],
  };
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(
    budgetProjectionPath,
    `${JSON.stringify({ assets: { large: { gallery_weighted_average_bytes: 100 }, thumbnail: { gallery_weighted_average_bytes: 50 } } }, null, 2)}\n`,
  );

  const requestedUrls: string[] = [];
  const result = await processSite({
    mode: 'run',
    assetManifestPath: assetsPath,
    budgetProjectionPath,
    sitePath,
    imagesManifestPath: manifestPath,
    downloadsDirectory,
    outputDirectory,
    retryCount: 1,
    fetchImpl: async (url) => {
      requestedUrls.push(String(url));
      return responseFor(source);
    },
    now: () => new Date('2026-09-16T00:00:00.000Z'),
  });

  assert.ok(result.manifest);
  assert.equal(result.manifest.images.length, 1);
  assert.deepEqual(result.manifest.images[0]?.photoIds.sort(), [
    'photo-one',
    'photo-two',
  ]);
  assert.equal(requestedUrls.length, 2);
  assert.ok(
    requestedUrls.every(
      (url) => new URL(url).searchParams.get('format') === '2500w',
    ),
  );

  const updated = JSON.parse(await readFile(sitePath, 'utf8')) as InputSite;
  assert.deepEqual(updated.pages, pages);
  assert.equal(
    updated.photos['photo-one']?.large,
    updated.photos['photo-two']?.large,
  );
  assert.equal(
    updated.photos['photo-one']?.thumbnail,
    updated.photos['photo-two']?.thumbnail,
  );
  assert.equal(updated.photos['photo-one']?.width, 96);
  assert.equal(updated.photos['photo-one']?.height, 64);
  assert.equal('sourceUrl' in (updated.photos['photo-one'] ?? {}), false);
  assert.equal('sourceUrls' in (updated.photos['photo-one'] ?? {}), false);
  assert.equal(
    'originalFilename' in (updated.photos['photo-one'] ?? {}),
    false,
  );
  await stat(
    path.join(
      outputDirectory,
      `${result.manifest.images[0]?.contentHash}.webp`,
    ),
  );
  await stat(
    path.join(
      outputDirectory,
      `${result.manifest.images[0]?.contentHash}-thumb.webp`,
    ),
  );
});

test('different source metadata that encodes identically shares one serving pair', async () => {
  const directory = await tempDirectory();
  const sitePath = path.join(directory, 'site.json');
  const assetsPath = path.join(directory, 'assets.json');
  const manifestPath = path.join(directory, 'images.json');
  const budgetProjectionPath = path.join(directory, 'budget-projection.json');
  const downloadsDirectory = path.join(directory, 'downloads');
  const outputDirectory = path.join(directory, 'public', 'images');
  const source = await jpegBuffer(96, 64);
  const sourceWithMetadata = await jpegBuffer(96, 64, undefined, true);
  assert.notDeepEqual(source, sourceWithMetadata);

  const pages = [
    {
      slug: 'first',
      title: 'First',
      kind: 'gallery' as const,
      description: '',
      bodyHtml: '',
      placements: [
        {
          imageId: 'photo-one',
          title: '',
          caption: '',
          alt: 'One',
          tags: [],
        },
      ],
    },
    {
      slug: 'second',
      title: 'Second',
      kind: 'gallery' as const,
      description: '',
      bodyHtml: '',
      placements: [
        {
          imageId: 'photo-two',
          title: '',
          caption: '',
          alt: 'Two',
          tags: [],
        },
      ],
    },
  ];
  const site: InputSite = {
    name: 'David Hahn Photography',
    description: '',
    email: '',
    phone: '',
    instagram: '',
    pages,
    photos: {
      'photo-one': {
        id: 'photo-one',
        sourceUrl: 'https://cdn.example.test/first.jpg',
      },
      'photo-two': {
        id: 'photo-two',
        sourceUrl: 'https://cdn.example.test/second.jpg',
      },
    },
  };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`);
  const assets = {
    schemaVersion: 1,
    generatedAt: '2026-09-16T00:00:00.000Z',
    source: {
      baseUrl: 'https://cdn.example.test',
      xmlPath: 'export.xml',
      xmlSha256: 'test',
    },
    policy: {
      sourceProtocol: 'https',
      requestedWidths: [2500, 1500, 1000, 750, 500, 300, 100],
      preferredWidth: 2500,
      maxCommittedWidth: 2500,
      originalDownloads: 'excluded',
    },
    assets: [
      {
        id: 'photo-one',
        identity: 'first',
        sourceUrl: 'https://cdn.example.test/first.jpg',
        originalFilename: 'first.jpg',
        filename: 'first.jpg',
        pageSlugs: ['first'],
        placementCount: 1,
        sourceUrls: ['https://cdn.example.test/first.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
      {
        id: 'photo-two',
        identity: 'second',
        sourceUrl: 'https://cdn.example.test/second.jpg',
        originalFilename: 'second.jpg',
        filename: 'second.jpg',
        pageSlugs: ['second'],
        placementCount: 1,
        sourceUrls: ['https://cdn.example.test/second.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
    ],
  };
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(
    budgetProjectionPath,
    `${JSON.stringify({ assets: { large: { gallery_weighted_average_bytes: 100 }, thumbnail: { gallery_weighted_average_bytes: 50 } } }, null, 2)}\n`,
  );

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'old-source.webp'), 'old');
  await writeFile(path.join(outputDirectory, 'old-source-thumb.webp'), 'old');
  await writeFile(path.join(outputDirectory, 'unrelated.webp'), 'keep');
  await writeFile(
    manifestPath,
    `${JSON.stringify({
      version: 1,
      images: [
        {
          contentHash: 'old-source',
          large: { path: '/images/old-source.webp' },
          thumbnail: { path: '/images/old-source-thumb.webp' },
        },
      ],
    })}\n`,
  );

  const result = await processSite({
    mode: 'run',
    assetManifestPath: assetsPath,
    budgetProjectionPath,
    sitePath,
    imagesManifestPath: manifestPath,
    downloadsDirectory,
    outputDirectory,
    retryCount: 1,
    fetchImpl: async (url) =>
      responseFor(
        String(url).includes('/second.jpg') ? sourceWithMetadata : source,
      ),
    now: () => new Date('2026-09-16T00:00:00.000Z'),
  });

  assert.ok(result.manifest);
  assert.equal(result.manifest.images.length, 1);
  assert.equal(result.manifest.sourceContentCount, 2);
  assert.equal(result.manifest.uniqueContentCount, 1);
  const image = result.manifest.images[0];
  assert.ok(image);
  assert.deepEqual(image.photoIds.sort(), ['photo-one', 'photo-two']);
  assert.equal(image.sourceVariants.length, 2);
  assert.equal(
    new Set(image.sourceVariants.map((variant) => variant.sourceSha256)).size,
    2,
  );
  assert.deepEqual(
    new Set(image.sourceVariants.flatMap((variant) => variant.photoIds)),
    new Set(['photo-one', 'photo-two']),
  );

  const updated = JSON.parse(await readFile(sitePath, 'utf8')) as InputSite;
  assert.equal(
    updated.photos['photo-one']?.large,
    updated.photos['photo-two']?.large,
  );
  assert.equal(
    updated.photos['photo-one']?.thumbnail,
    updated.photos['photo-two']?.thumbnail,
  );
  await assert.rejects(stat(path.join(outputDirectory, 'old-source.webp')));
  await assert.rejects(
    stat(path.join(outputDirectory, 'old-source-thumb.webp')),
  );
  await stat(path.join(outputDirectory, 'unrelated.webp'));
  const servingFiles = (await readdir(outputDirectory)).filter((name) =>
    name.endsWith('.webp'),
  );
  assert.equal(servingFiles.length, 3);

  const rerun = await processSite({
    mode: 'run',
    assetManifestPath: assetsPath,
    budgetProjectionPath,
    sitePath,
    imagesManifestPath: manifestPath,
    downloadsDirectory,
    outputDirectory,
    retryCount: 1,
    fetchImpl: async () => {
      throw new Error('verified source cache should avoid a network request');
    },
    now: () => new Date('2026-09-16T00:00:00.000Z'),
  });
  assert.equal(rerun.manifest?.images[0]?.status, 'cached');
});

test('failed downloads write a resumable failure manifest before aborting', async () => {
  const directory = await tempDirectory();
  const sitePath = path.join(directory, 'site.json');
  const assetsPath = path.join(directory, 'assets.json');
  const manifestPath = path.join(directory, 'images.json');
  const budgetProjectionPath = path.join(directory, 'budget-projection.json');
  const downloadsDirectory = path.join(directory, 'downloads');
  const outputDirectory = path.join(directory, 'public', 'images');
  const site: InputSite = {
    name: 'David Hahn Photography',
    description: '',
    email: '',
    phone: '',
    instagram: '',
    pages: [],
    photos: {},
  };
  const assets = {
    schemaVersion: 1,
    generatedAt: '2026-09-16T00:00:00.000Z',
    source: {
      baseUrl: 'https://cdn.example.test',
      xmlPath: 'export.xml',
      xmlSha256: 'test',
    },
    policy: {
      sourceProtocol: 'https' as const,
      requestedWidths: [2500, 1500, 1000, 750, 500, 300, 100] as const,
      preferredWidth: 2500 as const,
      maxCommittedWidth: 2500 as const,
      originalDownloads: 'excluded' as const,
    },
    assets: [
      {
        id: 'broken-photo',
        identity: 'broken-photo',
        sourceUrl: 'https://cdn.example.test/broken.jpg',
        originalFilename: 'broken.jpg',
        filename: 'broken.jpg',
        pageSlugs: [],
        placementCount: 0,
        sourceUrls: ['https://cdn.example.test/broken.jpg'],
        candidateUrls: [],
        observed: [],
        metadataSources: [],
      },
    ],
  };
  await writeFile(sitePath, `${JSON.stringify(site, null, 2)}\n`);
  await writeFile(assetsPath, `${JSON.stringify(assets, null, 2)}\n`);
  await writeFile(
    budgetProjectionPath,
    `${JSON.stringify({ assets: { large: { gallery_weighted_average_bytes: 100 }, thumbnail: { gallery_weighted_average_bytes: 50 } } }, null, 2)}\n`,
  );
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'old-content.webp'), 'old-large');
  await writeFile(
    path.join(outputDirectory, 'old-content-thumb.webp'),
    'old-thumbnail',
  );
  await writeFile(path.join(outputDirectory, 'unrelated.webp'), 'keep');
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: '2026-09-15T00:00:00.000Z',
        assetManifestPath: assetsPath,
        sitePath,
        outputDirectory,
        downloadDirectory: downloadsDirectory,
        sourceCount: 1,
        sourceContentCount: 1,
        uniqueContentCount: 1,
        servingBytes: 19,
        servingBudgetBytes: 750_000_000,
        images: [
          {
            contentHash: 'old-content',
            photoIds: ['old-photo'],
            sourceUrls: [],
            sourceVariants: [],
            selectedUrl: 'https://cdn.example.test/old.jpg',
            sourceBytes: 1,
            sourceMime: 'image/jpeg',
            sourceFormat: 'jpeg',
            sourceWidth: 1,
            sourceHeight: 1,
            large: {
              path: '/images/old-content.webp',
              bytes: 9,
              sha256: 'old-large',
              width: 1,
              height: 1,
              mime: 'image/webp',
            },
            thumbnail: {
              path: '/images/old-content-thumb.webp',
              bytes: 10,
              sha256: 'old-thumbnail',
              width: 1,
              height: 1,
              mime: 'image/webp',
            },
            status: 'processed',
          },
        ],
        status: 'complete',
      },
      null,
      2,
    )}\n`,
  );

  await assert.rejects(
    processSite({
      mode: 'run',
      assetManifestPath: assetsPath,
      budgetProjectionPath,
      sitePath,
      imagesManifestPath: manifestPath,
      downloadsDirectory,
      outputDirectory,
      retryCount: 1,
      fetchImpl: async () => responseFor(Buffer.from('not an image')),
    }),
    /1 image source download\(s\) failed/,
  );
  const failure = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    status: string;
    images: Array<{ contentHash: string }>;
    failures: Array<{ photoIds: string[]; error: string }>;
  };
  assert.equal(failure.status, 'failed');
  assert.equal(failure.images[0]?.contentHash, 'old-content');
  await stat(path.join(outputDirectory, 'old-content.webp'));
  await stat(path.join(outputDirectory, 'old-content-thumb.webp'));
  await stat(path.join(outputDirectory, 'unrelated.webp'));
  assert.deepEqual(failure.failures[0]?.photoIds, ['broken-photo']);
  assert.match(failure.failures[0]?.error ?? '', /Unable to download/);

  const source = await jpegBuffer(96, 64);
  const retry = await processSite({
    mode: 'run',
    assetManifestPath: assetsPath,
    budgetProjectionPath,
    sitePath,
    imagesManifestPath: manifestPath,
    downloadsDirectory,
    outputDirectory,
    retryCount: 1,
    fetchImpl: async () => responseFor(source),
    now: () => new Date('2026-09-16T00:00:00.000Z'),
  });
  assert.equal(retry.manifest?.status, 'complete');
  assert.equal(retry.manifest?.images.length, 1);
  await assert.rejects(stat(path.join(outputDirectory, 'old-content.webp')));
  await assert.rejects(
    stat(path.join(outputDirectory, 'old-content-thumb.webp')),
  );
  await stat(path.join(outputDirectory, 'unrelated.webp'));
});

test('pending transactions recover output and manifest-before-site interruptions', async () => {
  const directory = await tempDirectory();
  const fixture = await writeMinimalProcessorFixture(directory);
  const source = await jpegBuffer(96, 64);
  const options = {
    mode: 'run' as const,
    assetManifestPath: fixture.assetsPath,
    budgetProjectionPath: fixture.budgetProjectionPath,
    sitePath: fixture.sitePath,
    imagesManifestPath: fixture.manifestPath,
    downloadsDirectory: fixture.downloadsDirectory,
    outputDirectory: fixture.outputDirectory,
    retryCount: 1,
    now: () => new Date('2026-09-16T00:00:00.000Z'),
  };

  await processSite({
    ...options,
    fetchImpl: async () => responseFor(source),
  });
  const previousManifest = JSON.parse(
    await readFile(fixture.manifestPath, 'utf8'),
  ) as Record<string, unknown> & { images: Array<Record<string, unknown>> };
  const previousSite = JSON.parse(
    await readFile(fixture.sitePath, 'utf8'),
  ) as InputSite;

  const orphanPath = path.join(fixture.outputDirectory, 'interrupted.webp');
  const stageDirectory = path.join(
    fixture.outputDirectory,
    '.staging-interrupted-output',
  );
  await writeFile(orphanPath, 'orphan');
  await mkdir(stageDirectory, { recursive: true });
  await writeFile(path.join(stageDirectory, 'leftover.webp'), 'leftover');
  const outputJournal = {
    version: 1,
    transactionId: 'interrupted-output',
    outputDirectory: fixture.outputDirectory,
    sitePath: fixture.sitePath,
    stageDirectory,
    outputPaths: ['/images/interrupted.webp'],
    previousManifest,
    nextManifest: { ...previousManifest, transactionId: 'interrupted-output' },
    previousSite,
    nextSite: previousSite,
  };
  await writeFile(
    `${fixture.manifestPath}.pending`,
    `${JSON.stringify(outputJournal, null, 2)}\n`,
  );

  await processSite({
    ...options,
    fetchImpl: async () => {
      throw new Error('verified source cache should avoid a network request');
    },
  });
  await assert.rejects(stat(orphanPath));
  await assert.rejects(stat(stageDirectory));
  await assert.rejects(stat(`${fixture.manifestPath}.pending`));

  const manifestBeforeSite = JSON.parse(
    await readFile(fixture.manifestPath, 'utf8'),
  ) as Record<string, unknown> & { images: Array<Record<string, unknown>> };
  const siteBefore = JSON.parse(
    await readFile(fixture.sitePath, 'utf8'),
  ) as InputSite;
  const nextSite: InputSite = {
    ...siteBefore,
    description: 'recovered metadata',
  };
  const nextManifest = {
    ...manifestBeforeSite,
    transactionId: 'manifest-before-site',
  };
  const metadataStageDirectory = path.join(
    fixture.outputDirectory,
    '.staging-manifest-before-site',
  );
  await mkdir(metadataStageDirectory, { recursive: true });
  await writeFile(
    `${fixture.manifestPath}.pending`,
    `${JSON.stringify(
      {
        version: 1,
        transactionId: 'manifest-before-site',
        outputDirectory: fixture.outputDirectory,
        sitePath: fixture.sitePath,
        stageDirectory: metadataStageDirectory,
        outputPaths: [
          ...manifestBeforeSite.images.flatMap((image) => [
            (image.large as { path: string }).path,
            (image.thumbnail as { path: string }).path,
          ]),
        ],
        previousManifest: manifestBeforeSite,
        nextManifest,
        previousSite: siteBefore,
        nextSite,
      },
      null,
      2,
    )}\n`,
  );
  // Simulate the manifest rename having succeeded immediately before the
  // process stopped, while site.json still contains the previous snapshot.
  await writeFile(
    fixture.manifestPath,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
  );

  const recovered = await processSite({
    ...options,
    fetchImpl: async () => {
      throw new Error('verified source cache should avoid a network request');
    },
  });
  assert.equal(recovered.site?.description, 'recovered metadata');
  assert.equal(
    JSON.parse(await readFile(fixture.sitePath, 'utf8')).description,
    'recovered metadata',
  );
  await assert.rejects(stat(metadataStageDirectory));
  await assert.rejects(stat(`${fixture.manifestPath}.pending`));
});

test('preflight estimates discovered unique sources with the fixed overhead and safety factor', async () => {
  const estimate = estimateServingBytes(100, 30 * 10 * 1024 * 1024);
  assert.equal(estimate, Math.ceil(10 * 1024 * 1024 * 100 * 1.2 + 25_000_000));
});
