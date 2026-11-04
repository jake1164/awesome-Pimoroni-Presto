import { defineConfig } from 'astro/config';
import { base, catalogFile, devServerOptions, imageCacheFile, outDir, siteOrigin, starCacheFile } from './site-config.mjs';

export default defineConfig({
  site: siteOrigin,
  base,
  output: 'static',
  outDir,
  // `astro dev` and `astro preview` listen here unless a command-line flag says otherwise (see site-config.mjs).
  server: devServerOptions(),
  vite: { resolve: { alias: { '@catalog': catalogFile, '@image-cache': imageCacheFile, '@star-cache': starCacheFile } } },
});
