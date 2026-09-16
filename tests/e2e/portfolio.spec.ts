import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SiteContent } from '../../src/content/types';

const site = JSON.parse(
  readFileSync('src/content/site.json', 'utf8'),
) as SiteContent;
const base = process.env.SITE_BASE ?? '/dh-photography/';
const pathFor = (slug: string) => `${base}${slug ? `${slug}/` : ''}`;

test('every recovered route renders all ordered image placements', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const forbidden: string[] = [];
  page.on('request', (request) => {
    if (/squarespace(?:-cdn)?\.com/i.test(request.url()))
      forbidden.push(request.url());
  });
  for (const content of site.pages) {
    const response = await page.goto(pathFor(content.slug));
    expect(response?.status(), content.slug).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    const ids = await page
      .locator('[data-photo-id]')
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute('data-photo-id')),
      );
    expect(ids, content.slug).toEqual(
      content.placements.map((placement) => placement.imageId),
    );
    expect(
      await page
        .locator('body')
        .evaluate((body) => body.scrollWidth <= window.innerWidth + 1),
      content.slug,
    ).toBe(true);
    const canonical = await page
      .locator('link[rel="canonical"]')
      .getAttribute('href');
    expect(canonical).toContain(base);
  }
  expect(forbidden).toEqual([]);
});

test('gallery requests thumbnails until the accessible lightbox opens', async ({
  page,
}) => {
  const largeRequests: string[] = [];
  const largePaths = new Set(
    Object.values(site.photos).map(
      (photo) => `${base}${photo.large.replace(/^\//, '')}`,
    ),
  );
  page.on('request', (request) => {
    if (largePaths.has(new URL(request.url()).pathname))
      largeRequests.push(request.url());
  });
  await page.goto(pathFor(''));
  await expect(page.locator('[data-photo-id]').first()).toBeVisible();
  expect(largeRequests).toHaveLength(2);
  largeRequests.length = 0;
  await page.goto(pathFor('celebrity'));
  const menu = page.locator('details.site-nav__menu');
  await expect(menu).not.toHaveAttribute('open');
  await menu.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(menu).not.toHaveAttribute('open');
  const first = page.locator('[data-photo-id]').first();
  await expect(first.locator('img')).toBeVisible();
  await expect
    .poll(() =>
      first
        .locator('img')
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    )
    .toBe(true);
  expect(largeRequests).toEqual([]);
  // Wait for the React island to hydrate before activating the progressive link.
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0);
  await first.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Close image viewer' }),
  ).toBeFocused();
  const image = dialog.locator('img');
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true);
  const original = await image.getAttribute('src');
  await page.keyboard.press('ArrowRight');
  await expect(image).not.toHaveAttribute('src', original!);
  await page.keyboard.press('ArrowLeft');
  await expect(image).toHaveAttribute('src', original!);
  await dialog.getByRole('button', { name: 'Next image' }).focus();
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')),
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(first).toBeFocused();
  expect(largeRequests.length).toBeGreaterThan(0);
});

test('public contact links and reduced motion remain usable', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(pathFor('contact'));
  await expect(
    page.locator(`a[href="mailto:${site.email}"]`).first(),
  ).toBeVisible();
  if (site.phone)
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();
  await expect(page.locator('form')).toHaveCount(0);
  await page.goto(`${base}404.html`);
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator(`a[href="${base}"]`).first()).toBeVisible();
});

test('galleries and routes work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:4321${pathFor('fashion')}`);
  const link = page.locator('[data-photo-id]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/\.webp$/);
  expect(
    (await page.request.get(`http://127.0.0.1:4321${href}`)).status(),
  ).toBe(200);
  await context.close();
});
