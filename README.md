# David Hahn Photography

A static portfolio for Sydney photographer David Hahn, recovered from his Squarespace website. Astro renders every page as HTML; a small React lightbox adds keyboard and touch interaction. All serving photographs are local WebP files.

## Develop

Use Node.js 24 and npm:

```sh
npm ci
npm run dev
```

The default project path is `/dh-photography/`. Open the URL printed by Astro with that path. For a domain-root preview:

```sh
SITE_BASE=/ SITE_ORIGIN=https://davidhahnphotography.com.au npm run dev
```

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run validate
npm run build
npx playwright install chromium
npm run test:e2e
```

`npm run preview` serves the production build. CI validates both project and domain-root paths without accessing Squarespace or encoding the image library.

## Content and photographs

- `src/content/site.json` contains page copy, ordered gallery placements and image records.
- `public/images/` contains the committed web masters and thumbnails. David retains the originals.
- `migration/` contains sanitised recovery inputs, provenance, the migration report and visual references.
- `scripts/` contains extraction, image import and validation tools.
- `docs/` contains the approved plan, editing guidance and deployment/cutover runbook.

Read [editing guidance](docs/editing.md), [migration notes](migration/README.md), the [migration report](migration/report.md), and [deployment runbook](docs/deployment.md). The [tracking issue](https://github.com/lucashinhand/dh-photography/issues/1) records outstanding migration and launch checkpoints.

## Copyright

Photography and site content © 2026 David Hahn.
Website source code © 2026 Lucas Hahn.

All rights reserved. No permission is granted to copy, reproduce,
modify, distribute, publish, or commercially use the photography,
content, branding, or source code without prior written permission.

Third-party dependencies remain subject to their respective licences.
