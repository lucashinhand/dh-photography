import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const previewOrigin = (
  process.env.PREVIEW_ORIGIN || 'http://127.0.0.1:4321'
).replace(/\/$/, '');
const base = process.env.SITE_BASE || '/dh-photography/';
const outputDir = process.env.SCREENSHOT_DIR || 'migration/screenshots/rebuilt';
const routes = [
  ['home', ''],
  ['celebrity', 'celebrity'],
  ['about', 'about'],
  ['contact', 'contact'],
] as const;
const viewports = [
  ['desktop', { width: 1440, height: 1000 }],
  ['mobile', { width: 390, height: 844 }],
] as const;

async function loadLazyImages(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((image) => {
      image.loading = 'eager';
    });
    window.scrollTo(0, 0);
  });
  await page.waitForFunction(
    () => Array.from(document.images).every((image) => image.complete),
    undefined,
    { timeout: 30000 },
  );
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images).map((image) =>
        image.decode().catch(() => undefined),
      ),
    ),
  );
}

await mkdir(outputDir, { recursive: true });
const browser = await chromium.launch();

try {
  for (const [name, slug] of routes) {
    for (const [variant, viewport] of viewports) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const path = `${base.replace(/\/$/, '')}/${slug ? `${slug}/` : ''}`;
      await page.goto(`${previewOrigin}${path}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.locator('h1').waitFor();
      await loadLazyImages(page);

      const imageStatus = await page
        .locator('img')
        .evaluateAll((images: HTMLImageElement[]) => ({
          total: images.length,
          loaded: images.filter(
            (image) => image.complete && image.naturalWidth > 0,
          ).length,
          broken: images.filter(
            (image) => image.complete && image.naturalWidth === 0,
          ).length,
        }));
      if (imageStatus.broken > 0 || imageStatus.loaded !== imageStatus.total) {
        throw new Error(
          `${name}-${variant} image load failure: ${JSON.stringify(imageStatus)}`,
        );
      }

      const output = `${outputDir}/${name}-${variant}.jpg`;
      await page.screenshot({
        path: output,
        fullPage: true,
        type: 'jpeg',
        quality: 75,
      });
      console.log(
        `${name}-${variant}: ${imageStatus.loaded} images -> ${output}`,
      );
      if (name === 'home') {
        await page.screenshot({
          path: `${outputDir}/home-${variant}-viewport.jpg`,
          type: 'jpeg',
          quality: 85,
        });
        await page.waitForFunction(
          () => !document.querySelector('astro-island[ssr]'),
        );
        await page.locator('[data-photo-id]').first().click();
        await page.getByRole('dialog').waitFor();
        await page
          .getByRole('dialog')
          .locator('img')
          .evaluate((image: HTMLImageElement) => image.decode());
        await page.screenshot({
          path: `${outputDir}/lightbox-${variant}.jpg`,
          type: 'jpeg',
          quality: 85,
        });
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}
