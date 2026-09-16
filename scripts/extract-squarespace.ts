import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { crawlPublicSite } from './lib/live-crawl.js';
import type {
  CrawlResult,
  ExtractionReport,
  ReconciliationResult,
} from './lib/extraction-types.js';
import {
  deriveContactDetails,
  parseXmlExport,
  sha256,
} from './lib/xml-export.js';
import { buildDraftSiteContent, buildReconciliation } from './lib/reconcile.js';
import { normalizeBaseUrl } from './lib/url-normalization.js';

const DEFAULT_BASE_URL = 'https://recorder-nonagon-24ym.squarespace.com';
const DEFAULT_XML =
  'migration/source/Squarespace-Wordpress-Export-09-16-2026.xml';

interface CliOptions {
  baseUrl: string;
  xmlPath: string;
  outputRoot: string;
  noCrawl: boolean;
  screenshots: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith('--')) continue;
    const [name, inlineValue] = argument.slice(2).split('=', 2);
    if (inlineValue !== undefined) values.set(name, inlineValue);
    else if (args[index + 1] && !args[index + 1].startsWith('--'))
      values.set(name, args[++index]);
    else flags.add(name);
  }
  const cwd = process.cwd();
  const xmlPath = values.get('xml') ?? DEFAULT_XML;
  const outputRoot = values.get('output') ?? cwd;
  return {
    baseUrl:
      values.get('base-url') ?? process.env.SQUARESPACE_URL ?? DEFAULT_BASE_URL,
    xmlPath: isAbsolute(xmlPath) ? xmlPath : resolve(cwd, xmlPath),
    outputRoot: isAbsolute(outputRoot) ? outputRoot : resolve(cwd, outputRoot),
    noCrawl: flags.has('no-crawl'),
    screenshots: !flags.has('no-screenshots'),
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function relativePath(root: string, target: string): string {
  return relative(root, target).replaceAll('\\', '/');
}

function skippedCrawl(baseUrl: string, routes: string[]): CrawlResult {
  return {
    status: 'skipped',
    baseUrl,
    sitemapUrl: `${baseUrl}/sitemap.xml`,
    routes,
    sitemapPageCount: 0,
    sitemapImageCount: 0,
    sitemapImages: [],
    navigation: [],
    pages: [],
    screenshots: [],
    instagram: '',
    errors: [],
    warnings: [],
    fetchedAt: new Date().toISOString(),
  };
}

function publicLivePages(crawl: CrawlResult, outputRoot: string): unknown {
  return {
    schemaVersion: 1,
    generatedAt: crawl.fetchedAt,
    baseUrl: crawl.baseUrl,
    status: crawl.status,
    instagram: crawl.instagram,
    errors: crawl.errors,
    warnings: crawl.warnings,
    sitemap: {
      pageCount: crawl.sitemapPageCount,
      imageEntries: crawl.sitemapImageCount,
      uniqueAssets: new Set(crawl.sitemapImages.map((image) => image.imageId))
        .size,
    },
    navigation: crawl.navigation,
    pages: crawl.pages.map((page) => ({
      slug: page.slug,
      path: page.path,
      url: page.url,
      title: page.title,
      description: page.description,
      canonicalUrl: page.canonicalUrl,
      headings: page.headings,
      publicText: page.publicText,
      footerText: page.footerText,
      links: page.links,
      layout: page.layout,
      fetchedAt: page.fetchedAt,
      images: page.images.map((image) => ({
        imageId: image.imageId,
        sourceUrl: image.sourceUrl,
        sourceUrls: image.sourceUrls,
        order: image.order,
        title: image.title,
        caption: image.caption,
        alt: image.alt,
        tags: image.tags,
        ...(image.observedWidth ? { observedWidth: image.observedWidth } : {}),
        ...(image.observedHeight
          ? { observedHeight: image.observedHeight }
          : {}),
        ...(image.originalSize ? { originalSize: image.originalSize } : {}),
        ...(image.contentType ? { contentType: image.contentType } : {}),
        ...(image.variants?.length ? { variants: image.variants } : {}),
        metadataSources: image.metadataSources,
      })),
    })),
    sitemapImages: crawl.sitemapImages,
    screenshots: crawl.screenshots.map((screenshot) => ({
      ...screenshot,
      file: relativePath(outputRoot, screenshot.file),
    })),
  };
}

function publicReconciliation(reconciliation: ReconciliationResult): unknown {
  return {
    schemaVersion: 1,
    orderPolicy: reconciliation.orderPolicy,
    navigation: reconciliation.navigation,
    pages: reconciliation.pages.map((page) => ({
      slug: page.slug,
      path: page.path,
      title: page.title,
      kind: page.kind,
      xmlPlacementCount: page.xmlPlacementCount,
      livePlacementCount: page.livePlacementCount,
      liveOnlyImageIds: page.liveOnlyImageIds,
      xmlOnlyImageIds: page.xmlOnlyImageIds,
      placements: page.placements,
    })),
    metadataConflicts: reconciliation.metadataConflicts,
    orderDifferences: reconciliation.orderDifferences,
    missingLivePages: reconciliation.missingLivePages,
    liveOnlyPages: reconciliation.liveOnlyPages,
  };
}

export function buildReport(
  baseUrl: string,
  xmlPath: string,
  xmlSha: string,
  parsed: ReturnType<typeof parseXmlExport>,
  crawl: CrawlResult,
  reconciliation: ReconciliationResult,
  outputRoot: string,
): ExtractionReport {
  const outputPlacements = reconciliation.pages.reduce(
    (total, page) => total + page.placements.length,
    0,
  );
  const liveOnlyPlacements = reconciliation.pages.reduce(
    (total, page) => total + page.liveOnlyImageIds.length,
    0,
  );
  const xmlOnlyPlacements = reconciliation.pages.reduce(
    (total, page) => total + page.xmlOnlyImageIds.length,
    0,
  );
  const missingAltText = reconciliation.pages.reduce(
    (total, page) =>
      total +
      page.placements.filter((placement) => !placement.alt.trim()).length,
    0,
  );
  const warnings: string[] = [];
  if (parsed.stats.placementOnlyAssets > 0) {
    warnings.push(
      `${parsed.stats.placementOnlyAssets} XML placement assets have no attachment record.`,
    );
  }
  if (parsed.stats.attachmentOnlyAssets > 0) {
    warnings.push(
      `${parsed.stats.attachmentOnlyAssets} XML attachments are not placed on an exported page.`,
    );
  }
  if (reconciliation.orderDifferences.length > 0) {
    warnings.push(
      `${reconciliation.orderDifferences.length} pages have live/XML image-order differences; live order is selected and XML-only placements remain appended in XML order.`,
    );
  }
  if (crawl.errors.length > 0)
    warnings.push(`Live crawl reported ${crawl.errors.length} error(s).`);
  warnings.push(...crawl.warnings);
  return {
    generatedAt: new Date().toISOString(),
    baseUrl,
    sourceXml: relativePath(outputRoot, xmlPath),
    xmlSha256: xmlSha,
    crawl: {
      status: crawl.status,
      orderPolicy: reconciliation.orderPolicy,
      routes: crawl.routes.length,
      pages: crawl.pages.length,
      sitemapPages: crawl.sitemapPageCount,
      sitemapImageEntries: crawl.sitemapImageCount,
      sitemapUniqueAssets: new Set(
        crawl.sitemapImages.map((image) => image.imageId),
      ).size,
      errors: crawl.errors,
      warnings: crawl.warnings,
    },
    inventory: {
      xmlItems: parsed.stats.itemCount,
      xmlPages: parsed.stats.pageCount,
      xmlAttachments: parsed.stats.attachmentCount,
      xmlPlacements: parsed.stats.placementCount,
      uniqueAssets: reconciliation.assets.length,
      outputPages: reconciliation.pages.length,
      outputPlacements,
      liveOnlyPlacements,
      xmlOnlyPlacements,
    },
    metadata: {
      conflicts: reconciliation.metadataConflicts.length,
      missingAltText,
      pagesWithoutLiveData: reconciliation.missingLivePages,
    },
    screenshots: crawl.screenshots.map((screenshot) => ({
      ...screenshot,
      file: relativePath(outputRoot, screenshot.file),
    })),
    warnings,
  };
}

export async function runExtraction(
  options: CliOptions,
): Promise<ExtractionReport> {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const xml = await readFile(options.xmlPath, 'utf8');
  const parsed = parseXmlExport(xml);
  const baselineRoutes = parsed.pages.map((page) => page.path);
  const crawl = options.noCrawl
    ? skippedCrawl(baseUrl, baselineRoutes)
    : await crawlPublicSite({
        baseUrl,
        routes: baselineRoutes,
        screenshotDir: resolve(
          options.outputRoot,
          'migration/references/screenshots',
        ),
        captureScreenshots: options.screenshots,
      });
  const reconciliation = buildReconciliation(parsed, crawl);
  const contact = deriveContactDetails(parsed.pages, crawl.instagram);
  const siteContent = buildDraftSiteContent(parsed, reconciliation, contact);
  const xmlSha = sha256(xml);

  const recoveryDir = resolve(options.outputRoot, 'migration/recovery');
  const manifestDir = resolve(options.outputRoot, 'migration/manifests');
  const reportDir = resolve(options.outputRoot, 'migration/reports');
  await mkdir(recoveryDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    resolve(recoveryDir, 'squarespace-export-sanitised.xml'),
    parsed.sanitizedXml,
    'utf8',
  );
  await writeJson(
    resolve(recoveryDir, 'live-pages.json'),
    publicLivePages(crawl, options.outputRoot),
  );
  await writeJson(
    resolve(recoveryDir, 'reconciliation.json'),
    publicReconciliation(reconciliation),
  );
  await writeJson(resolve(manifestDir, 'assets.json'), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      baseUrl,
      xmlPath: relativePath(options.outputRoot, options.xmlPath),
      xmlSha256: xmlSha,
    },
    policy: {
      sourceProtocol: 'https',
      requestedWidths: [2500, 1500, 1000, 750, 500, 300, 100],
      preferredWidth: 2500,
      maxCommittedWidth: 2500,
      originalDownloads: 'excluded',
    },
    assets: reconciliation.assets,
  });
  const report = buildReport(
    baseUrl,
    options.xmlPath,
    xmlSha,
    parsed,
    crawl,
    reconciliation,
    options.outputRoot,
  );
  await writeJson(resolve(reportDir, 'extraction-report.json'), report);
  await writeJson(
    resolve(options.outputRoot, 'src/content/site.json'),
    siteContent,
  );
  return report;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runExtraction(options);
  console.log(
    JSON.stringify(
      {
        status: report.crawl.status,
        pages: report.inventory.outputPages,
        xmlPlacements: report.inventory.xmlPlacements,
        outputPlacements: report.inventory.outputPlacements,
        assets: report.inventory.uniqueAssets,
        screenshots: report.screenshots.length,
        warnings: report.warnings,
      },
      null,
      2,
    ),
  );
  const exitCode = extractionExitCode(report.crawl.status, options.noCrawl);
  if (exitCode !== 0) process.exitCode = exitCode;
}

export function extractionExitCode(
  status: ExtractionReport['crawl']['status'],
  noCrawl: boolean,
): number {
  if (status === 'complete') return 0;
  if (noCrawl && status === 'skipped') return 0;
  return 1;
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (import.meta.url === entrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { parseArgs };
