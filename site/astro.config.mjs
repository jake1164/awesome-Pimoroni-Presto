import { defineConfig } from 'astro/config';
import { base, catalogFile, outDir, siteOrigin } from './site-config.mjs';

export default defineConfig({
  site: siteOrigin,
  base,
  output: 'static',
  outDir,
  vite: { resolve: { alias: { '@catalog': catalogFile } } },
});
