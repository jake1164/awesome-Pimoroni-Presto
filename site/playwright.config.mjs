import { defineConfig, devices } from '@playwright/test';
import { base } from './site-config.mjs';

// Tests run against the production build (`npm run build`) served by `astro preview`.
// Port 4321 is avoided because Windows can reserve it; override with PRESTO_E2E_PORT.
// A second site, built from a synthetic README into `.synthetic/`, serves e2e/all-category.spec.mjs.
const port = Number(process.env.PRESTO_E2E_PORT ?? 8765);
const syntheticPort = Number(process.env.PRESTO_E2E_SYNTHETIC_PORT ?? 8772);
const root = base.replace(/\/$/, '');
const urlFor = (number) => `http://127.0.0.1:${number}${root}/`;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'desktop',
      testIgnore: /all-category/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, baseURL: urlFor(port) },
    },
    {
      name: 'mobile',
      testIgnore: /all-category/,
      use: { ...devices['Pixel 7'], baseURL: urlFor(port) },
    },
    {
      name: 'synthetic',
      testMatch: /all-category\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, baseURL: urlFor(syntheticPort) },
    },
  ],
  webServer: [
    {
      command: `npm run preview -- --host 127.0.0.1 --port ${port}`,
      url: urlFor(port),
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node e2e/synthetic-readme.mjs && npm run build && npm run preview -- --host 127.0.0.1 --port ${syntheticPort}`,
      url: urlFor(syntheticPort),
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PRESTO_README: '.synthetic/README.md',
        PRESTO_CATALOG_FILE: '.synthetic/catalog.json',
        PRESTO_OUT_DIR: '.synthetic/dist',
      },
    },
  ],
});
