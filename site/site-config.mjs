import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source for deployment identity and build paths, shared by Astro, the build scripts and the browser tests.
const repository = process.env.GITHUB_REPOSITORY ?? 'jake1164/awesome-Pimoroni-Presto';
const [owner, name] = repository.split('/');
const siteDirectory = path.dirname(fileURLToPath(import.meta.url));

export const siteOrigin = `https://${owner}.github.io`;
export const base = name === `${owner}.github.io` ? '/' : `/${name}`;
export const repositoryUrl = `https://github.com/${repository}`;

// Optional ways to support the list. They are plain links, never widgets, and the same two destinations appear in the
// README's "Support this project" section and in .github/FUNDING.yml; tests/gallery.test.mjs keeps the four in step.
export const sponsorsUrl = 'https://github.com/sponsors/jake1164';
export const coffeeUrl = 'https://buymeacoffee.com/jake1164s';

// Defaults are the real catalog and `dist/`. The overrides let the browser tests build a second site from a
// synthetic README without touching either.
export const catalogFile = process.env.PRESTO_CATALOG_FILE
  ? path.resolve(process.env.PRESTO_CATALOG_FILE)
  : path.join(siteDirectory, 'src', 'data', 'catalog.json');
export const outDir = process.env.PRESTO_OUT_DIR ? path.resolve(process.env.PRESTO_OUT_DIR) : path.join(siteDirectory, 'dist');

// Generated, disposable image-discovery results (see scripts/discover-images.mjs). Never committed; CI caches it.
export const imageCacheFile = process.env.PRESTO_IMAGE_CACHE
  ? path.resolve(process.env.PRESTO_IMAGE_CACHE)
  : path.join(siteDirectory, '.cache', 'project-images.json');

// Generated, disposable GitHub star counts (see scripts/fetch-stars.mjs). Never committed; CI caches it with the images.
export const starCacheFile = process.env.PRESTO_STARS_CACHE
  ? path.resolve(process.env.PRESTO_STARS_CACHE)
  : path.join(siteDirectory, '.cache', 'github-stars.json');

// Local development server. Host and port come from the environment, not from `npm run dev -- --port N`: npm's
// argument forwarding is unreliable on some Windows setups (the arguments get lost and Astro falls back to its default
// port 4321, which Windows may reserve). 8088 lies outside the usual Windows excluded port ranges.
// Windows PowerShell: `$env:PRESTO_DEV_PORT = '9000'; npm run dev`. POSIX shells: `PRESTO_DEV_PORT=9000 npm run dev`.
export const defaultDevHost = 'localhost';
export const defaultDevPort = 8088;

export function devServerOptions(env = process.env) {
  // Trimmed because cmd.exe's `set VAR=value && command` keeps the space before `&&` in the value.
  const host = env.PRESTO_DEV_HOST?.trim() || defaultDevHost;
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) throw new Error(`PRESTO_DEV_HOST must be a host name or IP address, not ${JSON.stringify(host)}`);
  const rawPort = env.PRESTO_DEV_PORT?.trim();
  const port = rawPort === undefined || rawPort === '' ? defaultDevPort : /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PRESTO_DEV_PORT must be a port number from 1 to 65535, not ${JSON.stringify(rawPort)}`);
  return { host, port };
}
