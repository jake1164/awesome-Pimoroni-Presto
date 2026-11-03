import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Single source for deployment identity and build paths, shared by Astro, the build scripts and the browser tests.
const repository = process.env.GITHUB_REPOSITORY ?? 'jake1164/awesome-Pimoroni-Presto';
const [owner, name] = repository.split('/');
const siteDirectory = path.dirname(fileURLToPath(import.meta.url));

export const siteOrigin = `https://${owner}.github.io`;
export const base = name === `${owner}.github.io` ? '/' : `/${name}`;
export const repositoryUrl = `https://github.com/${repository}`;

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
