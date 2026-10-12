// The README's still screenshot (config) in docs/images, from test data only. The animations come from
// features.media.ts and the Remotion project in ./remotion. Run with `pnpm readme:media`.
import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { launch } from './lib';

const OUT = fileURLToPath(new URL('../images', import.meta.url));

test('readme screenshots', async () => {
  test.setTimeout(120_000);
  const { context, ext } = await launch();
  // A configured provider for the status line, entered the way a user would; nothing is ever sent.
  await ext.getByRole('button', { name: 'DeepSeek 详情' }).click();
  await ext.getByLabel('DeepSeek API Key').fill('demo-key-not-real');
  await ext.getByRole('button', { name: '保存', exact: true }).click();
  await expect(ext.getByText('所有更改已保存')).toBeVisible();

  // Config, providers collapsed.
  const app = await context.newPage();
  await app.setViewportSize({ width: 1280, height: 820 });
  await app.goto(ext.url());
  await app.waitForTimeout(800);
  await app.screenshot({ path: `${OUT}/config.png` });
  await context.close();
});
