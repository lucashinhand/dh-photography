import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('report refuses a failed import even when earlier site content remains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'portfolio-report-'));
  try {
    const inputs = {
      'src/content/site.json': { pages: [], photos: {} },
      'migration/reports/extraction-report.json': {
        crawl: { status: 'complete' },
      },
      'migration/recovery/reconciliation.json': {},
      'migration/recovery/live-pages.json': {},
      'migration/manifests/images.json': {
        status: 'failed',
        images: [],
        failures: ['interrupted download'],
      },
    };
    for (const [file, value] of Object.entries(inputs)) {
      const path = join(root, file);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, JSON.stringify(value));
    }
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('scripts/report-migration.ts'),
      ],
      { cwd: root, encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /image import is incomplete or failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
