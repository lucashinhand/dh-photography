# Verification record

Verified locally on 16 September 2026 with Node 24, CLI Chromium/Playwright, Astro and Sharp. The recovery checkpoint is `47624906e4567f4fb4d9f5718bed63424367dc62`; subsequent commits contain presentation and verification improvements.

## Automated checks

- Formatting, ESLint, Astro diagnostics and TypeScript pass (one non-blocking unused-parameter hint in crawler code).
- 27 unit tests pass: XML parsing/sanitisation/reconciliation, public metadata allowlisting, incomplete-crawl reporting, HTTPS redirects, image orientation/metadata, raw and encoded deduplication, verified resumption, failed-import reports, import interruption/retry recovery, encoded file-size limits, safe URL schemes and content loading.
- Project build (`/dh-photography/`, `https://lucashahn.dev`): 20 generated HTML routes, 336,530,758 bytes including all serving assets; asset, provenance and built-link audit passes.
- Domain-root build (`/`, `https://davidhahnphotography.com.au`): 20 generated HTML routes, 336,471,538 bytes; same audit passes. This was a local test, not domain attachment or deployment.
- Eight Playwright tests pass for each configuration, split across desktop and mobile. They check all 18 recovered routes and exact ordered placements, absence of Squarespace requests, thumbnail-first loading, native menu toggling, keyboard lightbox controls and focus restoration, contact links, reduced motion, 404 and JavaScript-disabled gallery access.
- The final recovery contains 1,100 source IDs, 1,049 unique serving photographs, 2,098 WebP files and 1,089 placements. Checksums, dimensions, aliases and live ordering match the committed manifests. Zero missing images or unexplained placement differences.
- Images contain no EXIF/IPTC/XMP metadata. Raw downloads and the account-bearing export remain ignored. All tracked and non-ignored publishable files, including root files, are included in the size/privacy audit. Synthetic oversized-root-file and local-path probes were correctly rejected. Recovery screenshot paths are repository-relative. Text is audited for common secret patterns and private recovery paths; sanitised XML author fields are checked. Copyright notices are present and there is no licence file.
- Repository payload is approximately 363 MB including references/screenshots; serving assets are 335,068,550 bytes. Every committed file is below 50 MB; both payloads are below the 750 MB target.

## Visual comparison

[Original references](../references/screenshots/) and [rebuilt views](../screenshots/rebuilt/) cover homepage, gallery, About, Contact and lightbox on desktop/mobile. The capture script explicitly loads and checks every image before full-page screenshots: home 66/66, celebrity 104/104 and About 13/13, with zero broken images.

The rebuilt homepage starts with the two Married at First Sight group images, following approved live order. Justified rows preserve full compositions and image sequence; mobile stacks photographs. Navigation uses short recovered labels, the gallery menu starts closed, and contact content stacks without horizontal clipping. Recovered contact prose is retained alongside actionable contact links.

Run `node --import tsx scripts/capture-screenshots.ts` against a running project-path preview to regenerate the screenshots. `PREVIEW_ORIGIN`, `SITE_BASE` and `SCREENSHOT_DIR` can override the target and output directory. Do not run project and domain builds concurrently in one checkout: they share `dist/`.

## Remaining human and launch checkpoints

Lucas has been asked to review the recovery report. That approval remains pending. The PR must remain unmerged until approved; live Pages verification follows that merge. Domain attachment, DNS updates and Squarespace cancellation are separate manual decisions documented in the deployment runbook.
