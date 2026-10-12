import { defineConfig } from '@playwright/test';

// End-to-end tests: real Chromium with the built extension (dist/chrome-mv3)
// against local fixture pages. Run `pnpm e2e` (builds first).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'e2e/.results',
  webServer: [
    {
      command: 'pnpm exec vite --config e2e/fixtures/vite.config.ts',
      url: 'http://localhost:5300/static.html',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      // OpenAI-compatible mock: generation tests never call a real provider.
      command: 'node e2e/mock-llm.mjs',
      url: 'http://localhost:5301/control?delay=0',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
