<!-- plan-slug: david-hahn-photography-migration -->

# David Hahn Photography migration — revised plan

## 1. Review resolution and image policy

Adopt the review’s requirements for measured budgets, explicit CDN rendition selection and XML-order reconciliation. Your latest clarification supersedes the original image-storage and multi-format requirements: **commit only a large web image and a thumbnail per photograph.** David retains the originals.

The review’s size and CI concerns were valid risks, but its predicted 1.5–3 GB recovery size and inevitable CI failure were not established facts. A deterministic 30-image sample spanning all 17 image-bearing pages produced this revised projection:

| Committed asset    | Encoding                                         | Projected total |
| ------------------ | ------------------------------------------------ | --------------: |
| Large image        | WebP, maximum 2500px width, quality 85, effort 4 |        254.9 MB |
| Thumbnail          | WebP, maximum 640px width, quality 80, effort 4  |         59.1 MB |
| Combined           | At most two files per unique photograph          |    **314.0 MB** |
| Planning allowance | Combined × 1.2, plus 25 MB                       |    **401.8 MB** |

These are gallery-weighted estimates using 1,155 images before final reconciliation, not guaranteed totals. They provide substantial room below our 750 MB target and [GitHub Pages’ 1 GB published-site limit](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits).

- Generate the thumbnail from the committed large WebP, making thumbnail regeneration independent of downloaded originals.
- Auto-orient, preserve composition, convert to sRGB, strip embedded metadata and never upscale.
- Commit these serving assets; ignore raw image downloads and generated site output.
- Generate images during import, not during ordinary CI builds. No AVIF/JPEG matrix or image-cache dependency is needed.
- GCS is an optional future fallback, not part of this implementation. Local downloads may be manually archived to Drive.

## 2. Establish and capture the migration

Once Plan Mode ends:

- Create the overarching GitHub issue and `codex/photography-portfolio` branch. Use milestone checklist updates, small logical commits and branch pushes.
- Preserve existing untracked user files. Keep the raw XML ignored because it contains account metadata; commit a sanitised copy and sanitisation tooling.
- Build extraction, image-processing and validation scripts, with manifests, reports and representative screenshots under `migration/`.
- Parse namespace-qualified `content:encoded`. Use its ordered image lists as the **gallery membership and ordering baseline**.
- Crawl every public route through CLI Playwright, using sitemap, navigation, internal links, XML and public Squarespace data. Trigger lazy loading and inspect gallery interactions.
- Recover handwritten captions, tags, descriptions, alt text, public copy, contact details and SEO metadata. Compare live ordering against XML; record discrepancies rather than silently overwriting either source.
- Reconcile the 18 XML pages, 1,076 attachments, 1,089 XML image placements and 1,115 sitemap image entries. Counts describe different inventories and must not be treated as interchangeable.
- Capture desktop/mobile screenshots for every distinct layout.

The site is currently public, so no reactivation is required. If access disappears, finish preparation first and pause with the manual reactivation checklist. Reuse `migration/source/Squarespace-Wordpress-Export-09-16-2026.xml` unless a refreshed export is needed.

### Explicit image recovery rules

- Normalise all requested URLs to HTTPS, reject plaintext redirects and replace existing `format` parameters with exactly one selector.
- Request `?format=2500w`; after bounded retries, fall back through `1500w`, `1000w`, `750w`, `500w`, `300w`, then `100w`. These are [documented Squarespace rendition sizes](https://developers.squarespace.com/image-loader).
- Verify actual decoded dimensions and MIME type. Neither a filename nor the requested width proves what was returned.
- Record fallback use and undersized recoveries for review. Do not fetch larger originals.
- Track source URL, selected rendition, downloaded checksum/dimensions, transformation settings and committed asset checksums.
- Deduplicate image files while preserving every gallery placement and its associated metadata.
- Recalculate the projection after discovery, before bulk downloading. Track actual totals during import; stop before committing if projected repository or site size exceeds 750 MB. Reject individual files above 50 MB; do not introduce Git LFS or silently reduce quality.

Push a dedicated extraction checkpoint commit containing optimised assets, public content and the migration report. Request your report review before recommending Squarespace cancellation.

## 3. Build the portfolio

Use **Astro static generation, TypeScript, React for interactive components, Sharp for importing images and CLI Playwright for testing**.

- Generate complete route-specific HTML with functional navigation and galleries before JavaScript loads.
- Preserve `/`, `/portfolio`, gallery paths, About and Contact; document intentional replacements.
- Preserve recovered copy, tags, captions, gallery grouping and order. Keep authored accessibility descriptions distinguishable from original content.
- Use restrained typography, neutral colours, generous spacing and uncropped mixed-aspect-ratio galleries.
- Display thumbnails in gallery grids; load large images when opening the lightbox. Avoid eagerly loading full galleries of large files.
- Provide visible focus, keyboard navigation, labelled lightbox controls, focus containment/restoration, Escape dismissal, touch usability and reduced-motion support.
- Retain public email, phone and Instagram links; replace the Squarespace contact form with those direct links.
- Generate page titles, descriptions, canonical/social metadata, sitemap, robots and a custom 404 page.
- Centralise origin/base-path configuration for both `/dh-photography/` and eventual domain-root deployment.
- Keep all production assets local, with no Squarespace runtime dependency.

Structured content separates pages, unique images and ordered gallery placements. The committed large WebP is the editable web master; future originals can replace it through the import tooling.

## 4. Verification, delivery and launch

- Add reproducible dependency installation, formatting, linting, type checking, parser/reconciliation tests and production builds.
- Test every direct route, links, images, keyboard/lightbox behaviour, mobile/desktop layouts and both base-path configurations.
- Compare rendered galleries with screenshots and manifests; investigate unexplained image or placement differences.
- Verify that gallery loading uses thumbnails and that production network requests do not depend on Squarespace.
- Audit copyright, private account data, secrets, embedded metadata and actual repository/build sizes.
- Require a clean-checkout CI build without cached image derivatives. CI validates committed images and copies them into the site.
- Use Luna Max agents for bounded implementation, visual QA and independent final review, avoiding overlapping edits.
- Configure PR validation and main-only Pages deployment, including manual dispatch, official Pages actions, least-required permissions and the `github-pages` environment.
- Add the agreed David Hahn/Lucas Hahn copyright notice and no licence file.
- Document development, content editing, image replacement, deployment, rollback and domain cutover.
- Push the completed branch and open a reviewable PR with screenshots, recovery evidence and known limitations. Do not merge it.
- After approved merge, verify the temporary Pages URL. Follow the separate `davidhahnphotography.com.au` runbook for domain verification, apex/`www`, HTTPS and preservation of MX/email records.

DNS changes, domain attachment and Squarespace cancellation remain under your control.
