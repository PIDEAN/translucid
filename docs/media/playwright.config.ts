import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// README media from test data only: screenshots in docs/images and the frames of the hero animation.
// Run `pnpm readme:media` (builds the extension, captures, then assembles docs/images/hero.gif).
export default defineConfig({
  testDir: '.',
  testMatch: '*.media.ts',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '.out/results',
  webServer: [
    {
      // The e2e fixture server: the extension's content scripts run on localhost pages.
      command: 'pnpm exec vite --config e2e/fixtures/vite.config.ts',
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      url: 'http://localhost:5300/static.html',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});
