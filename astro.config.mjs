import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

import { siteBase, siteOrigin } from './src/lib/deployment.ts';

export default defineConfig({
  site: siteOrigin,
  base: siteBase,
  output: 'static',
  trailingSlash: 'always',
  integrations: [react()],
});
