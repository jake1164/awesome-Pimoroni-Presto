import { defineConfig, devices } from '@playwright/test';
import { base } from './site-config.mjs';

// Tests run against the production build (`npm run build`) served by `astro preview`.
// Port 4321 is avoided because Windows can reserve it; override with PRESTO_E2E_PORT.
// A second site, built from a synthetic README into `.synthetic/` with a local stand-in for GitHub (no network),
// serves e2e/all-category.spec.mjs and e2e/images.spec.mjs.
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
      testIgnore: /all-category|images\.spec/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, baseURL: urlFor(port) },
    },
    {
      name: 'mobile',
      testIgnore: /all-category|images\.spec/,
      use: { ...devices['Pixel 7'], baseURL: urlFor(port) },
    },
    {
      name: 'synthetic',
      testMatch: /(all-category|images)\.spec\.mjs/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 }, baseURL: urlFor(syntheticPort) },
    },
    {
      name: 'synthetic-mobile',
      testMatch: /images\.spec\.mjs/,
      use: { ...devices['Pixel 7'], baseURL: urlFor(syntheticPort) },
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
      // Builds the synthetic site (README, local stand-in for GitHub, discovery, Astro) and serves it; see the script.
      command: 'node e2e/synthetic-site.mjs',
      url: urlFor(syntheticPort),
      reuseExistingServer: false,
      timeout: 180_000,
      env: { PRESTO_E2E_SYNTHETIC_PORT: String(syntheticPort) },
    },
  ],
});
