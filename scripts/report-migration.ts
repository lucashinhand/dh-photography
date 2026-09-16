import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SiteContent } from '../src/content/types.js';

const site = JSON.parse(
  await readFile('src/content/site.json', 'utf8'),
) as SiteContent;
const extraction = JSON.parse(
  await readFile('migration/reports/extraction-report.json', 'utf8'),
);
const reconciliation = JSON.parse(
  await readFile('migration/recovery/reconciliation.json', 'utf8'),
);
const images = JSON.parse(
  await readFile('migration/manifests/images.json', 'utf8'),
);
const live = JSON.parse(
  await readFile('migration/recovery/live-pages.json', 'utf8'),
);
if (
  images.status !== 'complete' ||
  images.failures?.length ||
  !images.images?.length
) {
  throw new Error(
    'Cannot report successful recovery: image import is incomplete or failed.',
  );
}
const placements = site.pages.flatMap((page) => page.placements);
const missing = placements.filter(
  (placement) => !site.photos[placement.imageId],
);
const imageIds = new Set(placements.map((placement) => placement.imageId));
const titleCount = placements.filter((item) => item.title).length;
const captionCount = placements.filter((item) => item.caption).length;
const tagCount = placements.filter((item) => item.tags.length).length;
const altCount = placements.filter((item) => item.alt).length;
const records: Array<{
  selectedUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  photoIds: string[];
  large: { path: string };
}> = images.images;
const fallbacks = records.filter(
  (image) => new URL(image.selectedUrl).searchParams.get('format') !== '2500w',
);
const duplicates = records.filter((image) => image.photoIds.length > 1);
const small = records.filter((image) => image.sourceWidth < 1000);
const lines = [
  '# Migration report',
  '',
  `Capture generated: ${extraction.generatedAt}. Image import generated: ${images.generatedAt}.`,
  '',
  '## Recovery summary',
  '',
  '| Measure | Result |',
  '| --- | ---: |',
  `| XML published pages | ${extraction.inventory.xmlPages} |`,
  `| XML attachment records | ${extraction.inventory.xmlAttachments} |`,
  `| XML ordered image placements | ${extraction.inventory.xmlPlacements} |`,
  `| Sitemap image entries | ${extraction.crawl.sitemapImageEntries} |`,
  `| Sitemap unique assets | ${extraction.crawl.sitemapUniqueAssets} |`,
  `| Captured public pages | ${live.pages.length} |`,
  `| Output pages | ${site.pages.length} |`,
  `| Output image placements | ${placements.length} |`,
  `| Placed source image IDs | ${imageIds.size} |`,
  `| Imported source IDs | ${Object.keys(site.photos).length} |`,
  `| Unique serving photographs | ${records.length} |`,
  `| Missing placed images | ${missing.length} |`,
  `| Duplicate-content groups | ${duplicates.length} |`,
  `| Lower CDN rendition fallbacks | ${fallbacks.length} |`,
  `| Serving image bytes | ${images.servingBytes} (${(images.servingBytes / 1_000_000).toFixed(1)} MB) |`,
  '',
  'Counts refer to different inventories: attachment records, source IDs, unique image bytes and repeated gallery placements are not interchangeable. XML order is retained as the comparison baseline; the final galleries follow the live website’s displayed order. Live-only placements, if any, are retained and listed in reconciliation.',
  '',
  '## Page reconciliation',
  '',
  '| Route | XML placements | Live placements | Final placements | Live-only | XML-only |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
];
for (const page of reconciliation.pages) {
  const result = site.pages.find((item) => item.slug === page.slug);
  lines.push(
    `| /${page.slug}/ | ${page.xmlPlacementCount} | ${page.livePlacementCount} | ${result?.placements.length ?? 0} | ${page.liveOnlyImageIds.length} | ${page.xmlOnlyImageIds.length} |`,
  );
}
lines.push(
  '',
  '## Handwritten metadata',
  '',
  `Among final placements, ${titleCount} have recovered titles, ${captionCount} have captions, ${tagCount} have tags and ${altCount} have recovered alt text.`,
  '',
  'The XML does not export per-photo tags/captions. Live DOM and allowlisted public gallery JSON supplement it. Missing metadata is left empty in source content; the UI uses a neutral gallery/position label when no title or alt text was recovered. It does not invent people, locations or captions.',
  '',
  `${reconciliation.metadataConflicts.length} metadata conflicts and ${reconciliation.orderDifferences.length} page-order differences are recorded in [reconciliation.json](recovery/reconciliation.json). Review those records alongside the visual references.`,
  '',
  '## Files and provenance',
  '',
  '- [Sanitised XML](recovery/squarespace-export-sanitised.xml): public page/attachment content with account metadata removed.',
  '- [Live page capture](recovery/live-pages.json): allowlisted public content; not a dump of account/settings JSON.',
  '- [Asset inventory](manifests/assets.json): HTTPS source URLs, gallery relationships and rendition candidates.',
  '- [Image results](manifests/images.json): decoded dimensions, MIME type, source/serving checksums, aliases and local files.',
  '- [Extraction report](reports/extraction-report.json): crawl status, inventory and warnings.',
  '- [Sample budget](manifests/budget-projection.json): the pre-capture estimate; actual totals above supersede it.',
  '',
  '## Visual references',
  '',
);
for (const screenshot of extraction.screenshots ?? []) {
  lines.push(
    `- [${screenshot.slug} · ${screenshot.viewport}](${String(screenshot.file).replace(/^migration\//, '')})`,
  );
}
lines.push(
  '',
  '## Manual review and limitations',
  '',
  `- Crawl status: **${extraction.crawl.status}**. Crawl errors: ${extraction.crawl.errors.length}.`,
  `- ${small.length} downloaded source images are less than 1000 pixels wide; no image was upscaled. Their dimensions are preserved in the image results. Portrait width alone does not indicate low quality.`,
  `- ${Object.keys(site.photos).filter((id) => !imageIds.has(id)).length} sitemap-only source IDs were recovered but are not placed in the current XML or live galleries. They remain available in the manifests and image assets for manual review; they have not been inserted into David’s curated galleries.`,
  '- David retains the originals. This recovery intentionally preserves web-serving copies, not camera originals or a separate archival collection.',
  '- The Squarespace form is replaced by public email, telephone and Instagram links.',
  '- The homepage remains available at both / and /portfolio/, with / as the canonical route.',
  '- Raw downloads and unsanitised XML remain local and ignored. Committed WebP files contain no EXIF/IPTC/XMP metadata.',
  '- Human review of this report and the recovered galleries is pending. Do not treat this report as approval to cancel Squarespace.',
  '- Production-domain attachment, DNS changes, live Pages verification after merge and cancellation remain separate launch checkpoints.',
  '',
);
for (const warning of extraction.warnings ?? []) lines.push(`- ${warning}`);
for (const error of extraction.crawl.errors ?? [])
  lines.push(`- Crawl error: ${error}`);
for (const image of fallbacks)
  lines.push(
    `- Lower rendition: ${image.large.path} (${new URL(image.selectedUrl).searchParams.get('format')}).`,
  );
for (const id of new Set(missing.map((item) => item.imageId)))
  lines.push(`- Missing placed image: ${id}.`);
lines.push('');
await writeFile('migration/report.md', lines.join('\n'));

async function bytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === 'downloads' ||
      entry.name === 'private' ||
      entry.name.startsWith('Squarespace-Wordpress-Export-')
    )
      continue;
    const path = join(directory, entry.name);
    total += entry.isDirectory() ? await bytes(path) : (await stat(path)).size;
  }
  return total;
}
console.log(
  JSON.stringify(
    {
      report: 'migration/report.md',
      missing: missing.length,
      imageBytes: images.servingBytes,
      publicMigrationBytes: await bytes('migration'),
    },
    null,
    2,
  ),
);
if (missing.length || extraction.crawl.status !== 'complete')
  process.exitCode = 1;
