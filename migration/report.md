# Migration report

Capture generated: 2026-09-16T08:25:15.417Z. Image import generated: 2026-09-16T08:44:06.103Z.

## Recovery summary

| Measure                       |               Result |
| ----------------------------- | -------------------: |
| XML published pages           |                   18 |
| XML attachment records        |                 1076 |
| XML ordered image placements  |                 1089 |
| Sitemap image entries         |                 1115 |
| Sitemap unique assets         |                 1100 |
| Captured public pages         |                   18 |
| Output pages                  |                   18 |
| Output image placements       |                 1089 |
| Placed source image IDs       |                 1089 |
| Imported source IDs           |                 1100 |
| Unique serving photographs    |                 1049 |
| Missing placed images         |                    0 |
| Duplicate-content groups      |                   50 |
| Lower CDN rendition fallbacks |                    0 |
| Serving image bytes           | 335068550 (335.1 MB) |

Counts refer to different inventories: attachment records, source IDs, unique image bytes and repeated gallery placements are not interchangeable. XML order is retained as the comparison baseline; the final galleries follow the live website’s displayed order. Live-only placements, if any, are retained and listed in reconciliation.

## Page reconciliation

| Route                 | XML placements | Live placements | Final placements | Live-only | XML-only |
| --------------------- | -------------: | --------------: | ---------------: | --------: | -------: |
| /portfolio/           |             66 |              66 |               66 |         0 |        0 |
| /celebrity/           |            104 |             104 |              104 |         0 |        0 |
| /fashion/             |             53 |              53 |               53 |         0 |        0 |
| /real-life/           |             87 |              87 |               87 |         0 |        0 |
| /actors/              |             51 |              51 |               51 |         0 |        0 |
| /musicians/           |             36 |              36 |               36 |         0 |        0 |
| /reality-tv/          |             51 |              51 |               51 |         0 |        0 |
| /corporate/           |             43 |              43 |               43 |         0 |        0 |
| /food/                |             54 |              54 |               54 |         0 |        0 |
| /country/             |             51 |              51 |               51 |         0 |        0 |
| /logie-awards/        |             29 |              29 |               29 |         0 |        0 |
| /travel/              |             57 |              57 |               57 |         0 |        0 |
| /catalogue/           |            115 |             115 |              115 |         0 |        0 |
| /interiors-exteriors/ |             57 |              57 |               57 |         0 |        0 |
| /property/            |             38 |              38 |               38 |         0 |        0 |
| /conference/          |            184 |             184 |              184 |         0 |        0 |
| /about/               |             13 |              13 |               13 |         0 |        0 |
| /contact/             |              0 |               0 |                0 |         0 |        0 |

## Handwritten metadata

Among final placements, 419 have recovered titles, 2 have captions, 0 have tags and 1089 have recovered alt text.

The XML does not export per-photo tags/captions. Live DOM and allowlisted public gallery JSON supplement it. Missing metadata is left empty in source content; the UI uses a neutral gallery/position label when no title or alt text was recovered. It does not invent people, locations or captions.

0 metadata conflicts and 16 page-order differences are recorded in [reconciliation.json](recovery/reconciliation.json). Review those records alongside the visual references.

## Files and provenance

- [Sanitised XML](recovery/squarespace-export-sanitised.xml): public page/attachment content with account metadata removed.
- [Live page capture](recovery/live-pages.json): allowlisted public content; not a dump of account/settings JSON.
- [Asset inventory](manifests/assets.json): HTTPS source URLs, gallery relationships and rendition candidates.
- [Image results](manifests/images.json): decoded dimensions, MIME type, source/serving checksums, aliases and local files.
- [Extraction report](reports/extraction-report.json): crawl status, inventory and warnings.
- [Sample budget](manifests/budget-projection.json): the pre-capture estimate; actual totals above supersede it.

## Visual references

- [portfolio · desktop](references/screenshots/gallery-desktop-portfolio.jpg)
- [portfolio · mobile](references/screenshots/gallery-mobile-portfolio.jpg)
- [contact · desktop](references/screenshots/text-desktop-contact.jpg)
- [contact · mobile](references/screenshots/text-mobile-contact.jpg)
- [about · desktop](references/screenshots/mixed-desktop-about.jpg)
- [about · mobile](references/screenshots/mixed-mobile-about.jpg)

## Manual review and limitations

- Crawl status: **complete**. Crawl errors: 0.
- 180 downloaded source images are less than 1000 pixels wide; no image was upscaled. Their dimensions are preserved in the image results. Portrait width alone does not indicate low quality.
- 11 sitemap-only source IDs were recovered but are not placed in the current XML or live galleries. They remain available in the manifests and image assets for manual review; they have not been inserted into David’s curated galleries.
- David retains the originals. This recovery intentionally preserves web-serving copies, not camera originals or a separate archival collection.
- The Squarespace form is replaced by public email, telephone and Instagram links.
- The homepage remains available at both / and /portfolio/, with / as the canonical route.
- Raw downloads and unsanitised XML remain local and ignored. Committed WebP files contain no EXIF/IPTC/XMP metadata.
- Human review of this report and the recovered galleries is pending. Squarespace will be retained in a dormant state, as confirmed by Lucas.
- Production-domain attachment, DNS changes and live Pages verification after merge remain separate launch checkpoints.

- 13 XML placement assets have no attachment record.
- 16 pages have live/XML image-order differences; Live display order is used; XML order is retained for comparison.
