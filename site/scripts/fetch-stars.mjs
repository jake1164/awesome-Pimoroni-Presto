// Build step: reads the GitHub star count of every project that links into a GitHub repository and keeps a
// disposable cache (24 hours).
//
//   node scripts/fetch-stars.mjs            update the cache (used by `npm run build` and `npm run dev`)
//   node scripts/fetch-stars.mjs --report   also print one line per project
//   node scripts/fetch-stars.mjs --refresh  ignore the cache and look every repository up again
//
// Like image discovery, two kinds of failure are kept apart:
//   * Recoverable lookup problems (rate limit, network down, GitHub unavailable, a deleted repository, a malformed
//     answer) never fail the build. The previous cached count is kept, or the card shows no count. They are
//     reported as warnings.
//   * Pipeline failures (an invalid catalog, broken configuration, a cache that cannot be read or replaced, a
//     programming error) stop with a non-zero exit status and a diagnostic.
//
// PRESTO_GITHUB_STARS=off makes no request and uses only what the cache holds.
// GITHUB_TOKEN or GH_TOKEN (optional, never required) raises the GitHub API rate limit; it is sent to the API only.
// PRESTO_STARS_REFRESH=1 is the same as --refresh. PRESTO_STARS_BUDGET_SECONDS bounds a slow build (default 120).
//
// The exit status is set through process.exitCode and the process ends by itself: process.exit() while sockets
// are closing can crash Node on Windows (a libuv assertion).

import { readFile } from 'node:fs/promises';
import { catalogFile, starCacheFile } from '../site-config.mjs';
import { DEFAULT_ENDPOINTS, PipelineError, createHttp, validateCatalog } from '../src/lib/image-discovery.mjs';
import { classifyGithubUrl, readStarsCache, starsFor, updateStars, writeStarsCache } from '../src/lib/github-stars.mjs';

const args = new Set(process.argv.slice(2));
const inActions = process.env.GITHUB_ACTIONS === 'true';
const warn = (message) => console.warn(inActions ? `::warning title=GitHub stars::${message.replace(/\r?\n/g, ' ')}` : `  github stars: ${message}`);

function configuration() {
  const apiValue = process.env.PRESTO_GITHUB_API_URL ?? DEFAULT_ENDPOINTS.githubApi;
  let githubApi;
  try {
    githubApi = new URL(apiValue).href;
  } catch {
    throw new PipelineError(`PRESTO_GITHUB_API_URL is not a valid URL: ${JSON.stringify(apiValue)}`);
  }
  const budgetSeconds = Number(process.env.PRESTO_STARS_BUDGET_SECONDS ?? 120);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    throw new PipelineError(`PRESTO_STARS_BUDGET_SECONDS must be a positive number, not ${JSON.stringify(process.env.PRESTO_STARS_BUDGET_SECONDS)}`);
  }
  const mode = process.env.PRESTO_GITHUB_STARS;
  if (mode !== undefined && mode !== '' && mode !== 'off' && mode !== 'on') {
    throw new PipelineError(`PRESTO_GITHUB_STARS must be "off" or "on", not ${JSON.stringify(mode)}`);
  }
  return {
    offline: mode === 'off' || args.has('--offline'),
    refresh: args.has('--refresh') || process.env.PRESTO_STARS_REFRESH === '1',
    budgetSeconds,
    endpoints: { ...DEFAULT_ENDPOINTS, githubApi }, // overridden only by the tests, which point it at a local fixture
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
  try {
    return validateCatalog(JSON.parse(text));
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    throw new PipelineError(`the generated catalog ${catalogFile} is not valid JSON (${error.message})`);
  }
}

async function main() {
  const config = configuration();
  // Test fixtures only: lets the build reach local fixture servers. Only loopback is opened; private networks stay refused.
  if (config.allowPrivateHosts) console.log('PRESTO_IMAGE_ALLOW_LOCAL=1: loopback addresses are reachable (test fixtures only)');
  const catalog = await readCatalog();
  const previous = await readStarsCache(starCacheFile, { warn });
  const http = createHttp({
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
    githubApiOrigin: new URL(config.endpoints.githubApi).origin,
    deadline: Date.now() + config.budgetSeconds * 1000,
    allowPrivateHosts: config.allowPrivateHosts,
    log: warn,
  });
  const { cache, stats } = await updateStars(catalog, previous, { http, endpoints: config.endpoints, offline: config.offline, refresh: config.refresh, log: warn });
  await writeStarsCache(starCacheFile, cache);

  const parts = [`${stats.withCount} of ${stats.repositories} GitHub repositories have a star count (${stats.projectsWithRepository} of ${stats.projects} projects link into one)`];
  parts.push(`${stats.cached} from cache, ${stats.fetched} looked up, ${stats.stale} kept from an earlier build, ${stats.missing} not found, ${stats.unavailable} unavailable`);
  parts.push(`${stats.requests} requests`);
  if (config.offline) parts.push('lookups off, cache only');
  if (stats.networkUnavailable) parts.push('network unavailable');
  if (stats.rateLimited) parts.push('rate limited');
  console.log(`GitHub stars: ${parts.join('; ')}`);

  if (args.has('--report')) {
    for (const project of catalog.projects) {
      const { repository, reason } = classifyGithubUrl(project.url);
      const stars = starsFor(cache, project);
      const state = !repository ? 'n/a' : stars ? String(stars.count) : cache.entries[repository.key]?.status === 'missing' ? 'not-found' : 'unknown';
      console.log(`${state.padEnd(9)} | ${project.title} | ${project.url} | ${repository ? repository.key : reason}`);
    }
  }
}

try {
  await main();
  process.exitCode = 0;
} catch (error) {
  if (error instanceof PipelineError) {
    console.error(inActions ? `::error title=GitHub stars::${error.message}` : `GitHub star lookup failed: ${error.message}`);
  } else {
    console.error(`GitHub star lookup failed unexpectedly (a bug, not a lookup problem):\n${error?.stack ?? error}`);
  }
  process.exitCode = 1;
}
