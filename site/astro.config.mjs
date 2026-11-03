import { defineConfig } from 'astro/config';
import { base, catalogFile, imageCacheFile, outDir, siteOrigin } from './site-config.mjs';

export default defineConfig({
  site: siteOrigin,
  base,
  output: 'static',
  outDir,
  vite: { resolve: { alias: { '@catalog': catalogFile, '@image-cache': imageCacheFile } } },
});
