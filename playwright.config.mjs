import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: 'list',
  outputDir: 'data/e2e-results',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
});
