# Awesome Pimoroni Presto gallery

The Astro static site in this folder reads its only project inventory from the root `README.md` through `tools/readme_catalog.py`. Catalog JSON is generated into `site/src/data/catalog.json` for the build and is ignored/not committed. Do not edit it by hand.

## Requirements

- Node.js 20 or later and npm
- Python 3.10 or later (the repository parser uses only the standard library)

## Local development

From the repository root:

1. `cd site`
2. `npm install`
3. `npm run dev -- --host 127.0.0.1 --port 8765`

`npm run dev` generates the catalog from the root README, then starts Astro. Host and port are ordinary Astro CLI arguments and are not hard-coded. Astro's default port 4321 can fail with `EACCES` on Windows because that port may fall inside a reserved range (check with `netsh interface ipv4 show excludedportrange protocol=tcp`); pick a port outside those ranges, such as 8765. The site is served under the Pages base path, for example `http://127.0.0.1:8765/awesome-Pimoroni-Presto/`.

## Build and test

```sh
npm run build        # generate the catalog from README.md, then build site/dist
npm test             # unit and integration tests (needs the build first)
npm run test:browser # browser smoke tests against the production build
```

`npm run preview -- --host 127.0.0.1 --port 8765` serves the production build.

The browser tests use Playwright and need a browser once per machine: `npx playwright install chromium` (on Linux CI add `--with-deps`). They start `astro preview` themselves on port 8765; set `PRESTO_E2E_PORT` to use another port. They verify, in a real browser against `dist/`, that the page loads without JavaScript errors or third-party requests, and that search, category and NEW/RECENT filters, sorting, reset, the empty state and the Ctrl/⌘K and Escape shortcuts work. Expected counts come from the generated catalog and nothing assumes how many projects carry a NEW or RECENT badge, so README entries, category changes and badge rollover (including a README with no badges at all) do not require changing a test.

A second suite, `e2e/all-category.spec.mjs`, runs against a separate site that Playwright builds from a synthetic README (`e2e/synthetic-readme.mjs`, output in the ignored `.synthetic/` folder, served on port 8772 or `PRESTO_E2E_SYNTHETIC_PORT`). It checks that a README category literally named `All` stays independent of the unfiltered "All" control. The build honours three optional environment variables for this: `PRESTO_README` (README to parse), `PRESTO_CATALOG_FILE` (generated catalog path) and `PRESTO_OUT_DIR` (build output folder). They default to the real README, `src/data/catalog.json` and `dist/`.

To build from an already-validated catalog (as CI does), set `PRESTO_CATALOG_ARTIFACT` to its path, for example `PRESTO_CATALOG_ARTIFACT=src/data/catalog.json npm run build`.

The build runs the parser against the current root README and stops on invalid input. It never fetches project information or images from external APIs, and the page makes no third-party requests (system fonts only). No project screenshots are currently included in the repository; cards therefore use category-aware outline icons, with a generic grid icon for any category the site does not recognise. Optional image metadata is not required to add a README entry.

## GitHub Pages

The production build sets the base URL from `GITHUB_REPOSITORY` (defaulting to this repository), so project Pages routes and assets use `/awesome-Pimoroni-Presto/`. Before enabling publication, configure the repository Pages source as **GitHub Actions**.

`.github/workflows/pages.yml` runs on pull requests, pushes to `main` and manual dispatch. It first reuses the README catalog validation workflow, then builds the site from the validated catalog artifact and runs the unit and browser tests. Pull requests only validate. The deploy job runs only for `main` (never a pull request or other branch) and only after validation, build and tests pass. It is not a deployment record: confirm repository Pages settings and run the workflow only after owner approval.

## Dependency audit

`npm audit` reports 5 findings (1 low, 3 high, 1 critical). All are in the Astro 5 development/build tree (`astro`, `esbuild`, `sharp`, `zod`, `zod-to-ts`); `npm audit --omit=dev` reports 0, because Astro is a development dependency and none of it is shipped: the output is plain static HTML, CSS and one small script.

**The build tree does run in CI, including for pull requests.** `.github/workflows/pages.yml` installs the dependencies (`npm ci`) and runs the Astro build and the tests on every pull request as well as on `main`, so a vulnerable build dependency executes on contributor-influenced input before the owner has merged anything. What limits the impact: pull-request runs have read-only repository permissions and no deployment rights, the deploy job runs only for `main`, and nothing is published until the owner merges. The README text reaches the build only as JSON produced by the repository parser and is rendered as escaped text.

The advisories, by exposure:

- **Zod, memory exhaustion (high, fixed in Zod 4.6.6, reached through `astro` and `zod-to-ts`).** Validating very large constrained collections can exhaust memory. Astro uses Zod at build time for its own configuration and content-collection schemas. This site does not use content collections and does not pass README-derived data through a Zod schema, so a README change cannot reach it. A pull request that changes the site code, `package.json` or the lockfile could, but such a pull request can already run arbitrary code in its own CI job, which is why the safeguards above (read-only token, no secrets, `main`-only deploy, owner review before merge) matter more than this advisory. The practical effect is a possible CI job failure or timeout (the build job is limited to 20 minutes), not a change to the published site.
- **Astro rendering advisories (critical).** These concern `define:vars`, spread attributes, view transitions, server islands, slot names, MDX/JSX rendering and image optimization, none of which this site uses, and the build-time Astro advisories matter only if untrusted content is rendered through them. The site renders README-derived text only through Astro's escaping text nodes.
- **`sharp` (high), `esbuild` (low).** `sharp` is used only for image optimization, which the site does not use. The `esbuild` advisory affects its development server on Windows; CI does not run it, but a Windows contributor running `npm run dev` locally is exposed to it.

The only suggested fix is a semver-major upgrade to Astro 7. That should be done as its own reviewed change, with a full rebuild and browser test run, not with `npm audit fix --force`. Until then these findings remain open build-time risk for the owner to accept or schedule; they are not a runtime risk to people visiting the site.
