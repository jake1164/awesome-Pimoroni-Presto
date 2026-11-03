import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { catalogFile } from '../site-config.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const siteDirectory = path.resolve(scriptDirectory, '..');
const repositoryRoot = path.resolve(siteDirectory, '..');
const output = catalogFile;
const readme = path.resolve(process.env.PRESTO_README ?? path.join(repositoryRoot, 'README.md'));
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3');
const pythonArguments = python === 'py' ? ['-3'] : [];
const artifactCatalog = process.env.PRESTO_CATALOG_ARTIFACT;

await mkdir(path.dirname(output), { recursive: true });

if (artifactCatalog) {
  // Artifact paths are resolved from the site directory, where npm runs this script.
  const source = path.resolve(siteDirectory, artifactCatalog);
  if (source !== output) await copyFile(source, output);
  console.log(`Using validated catalog artifact: ${artifactCatalog}`);
  process.exit(0);
}

const result = spawnSync(
  python,
  [...pythonArguments, 'tools/readme_catalog.py', '--readme', readme, '--format', 'text', '--output', output],
  { cwd: repositoryRoot, stdio: 'inherit', shell: false },
);

if (result.error) {
  console.error(`Unable to run the catalog generator with "${python}": ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
