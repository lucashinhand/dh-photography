# Recovery tooling

The complete public crawl and image import are recorded in [report.md](report.md). Ordinary site builds use committed content and WebP assets; they do not contact Squarespace or encode images.

## Inputs and reproducibility

The original export remains local at `migration/source/Squarespace-Wordpress-Export-09-16-2026.xml`. It is ignored because it includes private account metadata. The public, sanitised equivalent is `recovery/squarespace-export-sanitised.xml`. Never add raw account/settings responses, browser profiles or cookies to this repository.

Install dependencies and Chromium using the root README. To repeat an extraction safely into a separate ignored directory:

```sh
npm run extract -- --xml migration/recovery/squarespace-export-sanitised.xml --output .cache/recovery-check
```

This crawls the public source with CLI Playwright and collects allowlisted public metadata. Add `--no-crawl` for XML-only parser verification; an offline result cannot replace the complete live capture. Review the new reports before replacing committed recovery data or site content. Extraction creates a draft photo dictionary; run the image importer against that draft before treating it as a finished portfolio.

Image import defaults to a budget-only preflight:

```sh
npm run images -- --preflight
npm run images -- --run
npm run migration:report
npm run validate
```

The importer uses `migration/manifests/assets.json`, updates `src/content/site.json`, and writes `migration/manifests/images.json`. Source bytes are cached in ignored `migration/downloads/`; resumptions verify checksums. Do not run extraction and import concurrently against the same content file. Do not refresh the established recovery in place without reviewing the resulting changes.

## Image policy

Each unique serving photograph has at most two WebP files: a large image at maximum 2500px width, quality 85, effort 4, and a thumbnail generated from that large image at maximum 640px width, quality 80, effort 4. Both are auto-oriented, converted to sRGB and stripped of embedded metadata without upscaling. David holds the camera originals separately.

All requests use HTTPS. Rendition probes start at `?format=2500w`, then use 1500w, 1000w, 750w, 500w, 300w and 100w after bounded retries. Actual MIME type and decoded dimensions are recorded, alongside source and serving checksums. The importer rejects plaintext redirects and oversized responses. Download and encoding concurrency are bounded independently.

Gallery placements remain separate from image records: duplicate content shares files without losing repeated placements, captions or order. Final galleries follow the live displayed order, explicitly approved by Lucas; XML ordering remains in the reconciliation evidence. Sitemap-only assets are retained without adding new gallery placements.

Targets are below 750,000,000 bytes for both recovery and published output, with no file above 50,000,000 bytes. There is no Git LFS, external bucket or runtime CDN dependency. The measured sample forecast and actual import totals are committed in the manifests/report.

## Review and publication

Run `npm run validate -- --build` after building to audit local assets, metadata, copyright, tracked-file privacy patterns, total sizes and generated links. Automated audits complement human review; inspect all newly committed recovery inputs for public suitability. Source references are under `references/`; rebuilt comparison screenshots are under `screenshots/`.

Human approval of the recovery and an approved PR merge are separate from domain/DNS changes or Squarespace cancellation. Follow the deployment runbook; do not cancel the old site merely because an import completed.
