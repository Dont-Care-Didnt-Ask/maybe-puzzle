import { defineConfig, devices } from '@playwright/test';

process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');

// Examples: PLAYWRIGHT_DIST=data/training/baseline/dist PLAYWRIGHT_PORT=8766
// PERF_PROFILE=before npx playwright test tests/performance.spec.js
const port = process.env.PLAYWRIGHT_PORT || '8765';
const basePath = process.env.PLAYWRIGHT_BASE_PATH || '/chess-puzzle-not-puzzle/';
const baseURL = `http://127.0.0.1:${port}${basePath}`;

export default defineConfig({
  testDir: './tests',
  testMatch: '*.spec.js',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve.mjs',
    url: baseURL,
    env: { DIST_DIR: process.env.PLAYWRIGHT_DIST || 'dist', BASE_PATH: basePath, PORT: port },
    reuseExistingServer: false,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
});
