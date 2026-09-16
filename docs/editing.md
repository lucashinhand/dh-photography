# Editing the portfolio

## Copy and gallery order

Edit `src/content/site.json`. A page has a stable `slug`, title, description, safe `bodyHtml` and ordered `placements`. A placement references an `imageId` and retains its title, caption, alt text and tags. Reorder placements to reorder a gallery; do not reorder the shared photo dictionary to change display order.

The `photos` dictionary maps IDs to local large/thumbnail files and their actual dimensions. The same photo may appear in several galleries with different text. Do not delete its files until every placement is removed.

Gallery images use native `srcset` and `sizes` to select between those two existing files as their displayed width or screen density changes. Below-fold images stay lazy; supported browsers use `sizes="auto"` to measure their actual layout width, with explicit layout-size fallbacks. Keep the size hints in `GalleryGrid.astro` aligned with gallery margins, gaps and breakpoints if the CSS changes. Browsers may keep an already-downloaded large image when the window shrinks. The lightbox always uses the large copy.

Keep original handwritten metadata intact unless David requests a correction. Empty recovered metadata is documented in the migration report; do not invent names, locations or captions. Accessibility descriptions added later should be identified as editorial additions in the provenance notes.

Recovered body HTML supports public prose and links, not scripts, forms, embedded services or tracking. The contact page uses `email`, `phone` and `instagram` from the top-level content object.

## Replace a photograph

David’s originals stay outside git. For a new original or a replacement, use the same image-processing settings documented in `migration/README.md`: auto-orient, sRGB, WebP large up to 2500px/q85/effort4 without upscaling, then thumbnail from the large WebP up to 640px/q80/effort4. Strip metadata from both.

Keep both serving files under `public/images/`. Update the image record’s filenames and decoded dimensions, preserving the image ID when it is the same photograph so gallery order and captions remain intact. Record the replacement and checksum in provenance; remove superseded unreferenced files before committing. Do not commit an original JPEG alongside serving files.

Run the validation, build and browser tests from the README before opening a PR. The validator catches missing files, stale dimensions, embedded metadata, orphaned assets and broken built links. Review the rendered photograph and its thumbnail for orientation, colour, softness and cropping.

## Routes and base paths

Keep existing slugs when practical. The home gallery is available at `/` and `/portfolio/`; canonical metadata points to `/`. All internal URLs are generated relative to `SITE_BASE`. Never hard-code the temporary repository prefix into content or use a Squarespace image URL in a production page.

The [deployment runbook](deployment.md) explains how the same content is built for the project URL and the production domain.
