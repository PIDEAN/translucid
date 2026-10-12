import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// README media from test data only: the config screenshot in docs/images and the frames + timelines of the
// animations (docs/media/.out). Run `pnpm readme:media`: build, capture, then render the GIFs with Remotion.
export default defineConfig({
  testDir: '.',
  testMatch: '*.media.ts',
  timeout: 180_000,
  workers: 1,
  reporter: [['list']],
  outputDir: '.out/results',
  webServer: [
    {
      // Answers translation requests with hand-written Chinese (zh-dictionary.json); never a real model.
      // The pages themselves are served by page.route() at made-up addresses (lib.ts).
      command: 'node docs/media/mock-translate.mjs',
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      url: 'http://localhost:5302/control?delay=0',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
