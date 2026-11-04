// Build step: discovers a card image for every project in the generated catalog and keeps a disposable cache.
//
//   node scripts/discover-images.mjs            update the cache (used by `npm run build` and `npm run dev`)
//   node scripts/discover-images.mjs --report   also print what was found, rejected and why
//   node scripts/discover-images.mjs --refresh  ignore cached results and look everything up again
//
// Two kinds of failure are kept apart:
//   * Recoverable lookup problems (an image or page is unavailable, a site answers 403/404, no suitable image, a
//     GitHub rate limit, the network is down, a README hint or URL that does not work) never fail the build. They
//     mean "show the category icon" and are reported as warnings.
//   * Pipeline failures (an invalid catalog, broken configuration, a cache that cannot be read or replaced,
//     output that cannot be written, or a programming error) stop with a non-zero exit status and a diagnostic.
//
// PRESTO_IMAGE_DISCOVERY=off skips all network access and uses only what the cache already holds.
// GITHUB_TOKEN (optional, never required) raises the GitHub API rate limit.
//
// The exit status is set through process.exitCode and the process is left to end by itself: calling
// process.exit() while sockets are closing can crash Node on Windows (a libuv assertion).

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { catalogFile, imageCacheFile } from '../site-config.mjs';
import { DEFAULT_ENDPOINTS, PipelineError, createHttp, sanitizeCache, updateCache, usableImages, validateCatalog } from '../src/lib/image-discovery.mjs';

const args = new Set(process.argv.slice(2));
const inActions = process.env.GITHUB_ACTIONS === 'true';
const warn = (message) => console.warn(inActions ? `::warning title=Project image::${message.replace(/\r?\n/g, ' ')}` : `  image discovery: ${message}`);

function configuration() {
  const endpoint = (name, fallback) => {
    const value = process.env[name] ?? fallback;
    try {
      return new URL(value).href;
    } catch {
      throw new PipelineError(`${name} is not a valid URL: ${JSON.stringify(value)}`);
    }
  };
  const budgetSeconds = Number(process.env.PRESTO_IMAGE_BUDGET_SECONDS ?? 240);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    throw new PipelineError(`PRESTO_IMAGE_BUDGET_SECONDS must be a positive number, not ${JSON.stringify(process.env.PRESTO_IMAGE_BUDGET_SECONDS)}`);
  }
  const discovery = process.env.PRESTO_IMAGE_DISCOVERY;
  if (discovery !== undefined && discovery !== '' && discovery !== 'off' && discovery !== 'on') {
    throw new PipelineError(`PRESTO_IMAGE_DISCOVERY must be "off" or "on", not ${JSON.stringify(discovery)}`);
  }
  // Endpoint overrides exist so the tests can point discovery at a local fixture server. Production never sets them.
  return {
    offline: discovery === 'off' || args.has('--offline'),
    refresh: args.has('--refresh') || process.env.PRESTO_IMAGE_REFRESH === '1',
    budgetSeconds,
    endpoints: {
      githubRaw: endpoint('PRESTO_GITHUB_RAW_URL', DEFAULT_ENDPOINTS.githubRaw),
      githubApi: endpoint('PRESTO_GITHUB_API_URL', DEFAULT_ENDPOINTS.githubApi),
      githubWeb: endpoint('PRESTO_GITHUB_WEB_URL', DEFAULT_ENDPOINTS.githubWeb),
    },
    allowPrivateHosts: process.env.PRESTO_IMAGE_ALLOW_LOCAL === '1',
  };
}

async function readCatalog() {
  let text;
  try {
    text = await readFile(catalogFile, 'utf8');
  } catch (error) {
    throw new PipelineError(`cannot read the generated catalog ${catalogFile} (${error.code ?? error.message}); run the catalog step first`);
  }
  let catalog;
  try {
    catalog = JSON.parse(text);
  } catch (error) {
    throw new PipelineError(`the generated catalog ${catalogFile} is not valid JSON (${error.message})`);
  }
  return validateCatalog(catalog);
}

// The cache is disposable: a missing, damaged or outdated file simply means "look everything up again". A file that
// cannot be read at all (a directory, no permission) is different: the build could not replace it either.
async function readCache() {
  let text;
  try {
    text = await readFile(imageCacheFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return sanitizeCache(null);
    throw new PipelineError(`cannot read the image cache ${imageCacheFile} (${error.code ?? error.message}); delete it or fix its permissions`);
  }
  try {
    return sanitizeCache(JSON.parse(text));
  } catch {
    warn(`the image cache ${imageCacheFile} is damaged; discarding it and looking images up again`);
    return sanitizeCache(null);
  }
}

async function writeCache(cache) {
  const temporary = `${imageCacheFile}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(imageCacheFile), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
    await rename(temporary, imageCacheFile);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw new PipelineError(`cannot write the image cache ${imageCacheFile} (${error.code ?? error.message})`);
  }
}

async function main() {
  const config = configuration();
  // Test fixtures only: lets the build reach local fixture servers. Only loopback is opened; private networks stay refused.
  if (config.allowPrivateHosts) console.log('PRESTO_IMAGE_ALLOW_LOCAL=1: loopback addresses are reachable (test fixtures only)');
  const catalog = await readCatalog();
  const previous = await readCache();
  const http = createHttp({
    githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '',
    githubApiOrigin: new URL(config.endpoints.githubApi).origin,
    deadline: Date.now() + config.budgetSeconds * 1000,
    allowPrivateHosts: config.allowPrivateHosts,
    log: warn,
  });
  const { cache, stats } = await updateCache(catalog, previous, {
    http,
    endpoints: config.endpoints,
    allowPrivateHosts: config.allowPrivateHosts,
    offline: config.offline,
    refresh: config.refresh,
    log: warn,
  });
  await writeCache(cache);

  // README directives that did not work are reported every build (not only when freshly looked up).
  for (const project of catalog.projects) {
    const directive = cache.entries[project.id]?.directive;
    if (directive?.outcome === 'failed') {
      const what = directive.mode === 'url' ? `image: ${directive.value}` : `image-hint: ${directive.value}`;
      warn(`"${project.title}": README \`<!-- ${what} -->\` was not used (${directive.reason}); ${directive.transient ? 'will retry at the next build' : 'using automatic discovery'}`);
    }
  }

  const usable = usableImages(cache, catalog.projects);
  const parts = [`${usable.size} of ${catalog.projects.length} projects have an image`];
  parts.push(`${stats.cached} from cache, ${stats.discovered} looked up, ${stats.forcedIcon} set to icon by README, ${stats.stale} kept from an earlier build, ${stats.unavailable} without a result`);
  parts.push(`${stats.requests} requests (${stats.apiRequests} GitHub API)`);
  if (config.offline) parts.push('discovery off, cache only');
  if (stats.networkUnavailable) parts.push('network unavailable');
  if (stats.rateLimited) parts.push('rate limited');
  if (stats.directiveProblems) parts.push(`${stats.directiveProblems} README image directive(s) not used`);
  console.log(`Project images: ${parts.join('; ')}`);

  if (args.has('--report')) {
    for (const project of catalog.projects) {
      const entry = cache.entries[project.id];
      const host = entry?.image ? new URL(entry.image.url).hostname : '';
      const state = usable.has(project.id) ? 'IMAGE' : entry?.status === 'found' ? 'GENERIC' : entry ? 'icon' : 'no-result';
      const rejected = (entry?.rejected ?? []).map((r) => `${r.reason} <${r.url}>`).join('; ');
      const directive = entry?.directive ? `${entry.directive.mode}${entry.directive.value ? `=${entry.directive.value}` : ''}:${entry.directive.outcome}${entry.directive.reason ? `(${entry.directive.reason})` : ''}` : '';
      console.log(`${state.padEnd(9)} | ${project.title} | ${project.url} | ${entry?.source ?? ''} | ${host} | ${entry?.image?.url ?? ''} | ${directive} | ${rejected}`);
    }
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof PipelineError) {
    console.error(inActions ? `::error title=Image discovery::${error.message}` : `Image discovery failed: ${error.message}`);
  } else {
    console.error(`Image discovery failed unexpectedly (a bug, not a lookup problem):\n${error?.stack ?? error}`);
  }
  process.exitCode = 1;
}
