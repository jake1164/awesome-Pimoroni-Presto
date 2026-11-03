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

A second group of suites, `e2e/all-category.spec.mjs` and `e2e/images.spec.mjs`, runs against a separate site that `e2e/synthetic-site.mjs` builds from a synthetic README (`e2e/synthetic-readme.mjs`, output in the ignored `.synthetic/` folder, served on port 8772 or `PRESTO_E2E_SYNTHETIC_PORT`). The first checks that a README category literally named `All` stays independent of the unfiltered "All" control. The second checks automatic images: the synthetic README points at fixture repositories on a local stand-in for GitHub (port 8773 or `PRESTO_E2E_FIXTURE_PORT`), so image discovery runs for real, with no network access and no manifest. It covers a project whose README image is found, projects with no usable image, an image that disappears after the build, and very large and very tall images. The build honours three optional environment variables for this: `PRESTO_README` (README to parse), `PRESTO_CATALOG_FILE` (generated catalog path) and `PRESTO_OUT_DIR` (build output folder). They default to the real README, `src/data/catalog.json` and `dist/`.

To build from an already-validated catalog (as CI does), set `PRESTO_CATALOG_ARTIFACT` to its path, for example `PRESTO_CATALOG_ARTIFACT=src/data/catalog.json npm run build`.

The build runs the parser against the current root README and stops on invalid input. After that, a separate step looks for a card image for each project (see **Project images**); that step can never stop the build. The page's only third-party requests are the project images themselves (system fonts, no scripts, analytics or trackers). Cards without an image use a category-aware outline icon, with a generic grid icon for any category the site does not recognise.

## Project images

**Adding a project needs README.md only.** The gallery finds a card image by itself during the build, and uses the category icon when it cannot. There is no image manifest, no image files in this repository, no licence metadata and no approval step. Nothing in `site/` has to change when a project is added, changed or removed. The same README entry can optionally guide or override the choice (next section).

### README image directives (optional)

An entry may end with **one** HTML comment, after the description and any badge. `tools/readme_catalog.py` (the Phase 1 parser, not a second parser) validates it and exports it as `image` on that project in the generated catalog: `{"mode": "hint", "value": "screenshots/"}`, `{"mode": "url", "value": "https://..."}` or `{"mode": "none"}`. The key is absent for entries without a directive. A directive never appears in `description` and never changes the project ID.

| README entry ends with | Catalog | Effect |
|---|---|---|
| nothing | no `image` key | Automatic discovery (default). |
| `<!-- image-hint: screenshots/ -->` | `mode: hint` | Look at this folder or file in the project's own GitHub repository first; if nothing usable, continue with automatic discovery. |
| `<!-- image: https://example.com/p.jpg -->` | `mode: url` | Prefer this image; if it is invalid or unavailable, report it and continue with automatic discovery. |
| `<!-- image: none -->` | `mode: none` | Category icon. No lookup, no remote image, even if one was cached. |

Hint rules (GitHub repository projects only; checked both by the parser and again at build time):

- Resolved relative to the repository root, or to the linked directory for `.../tree/<branch>/<dir>` projects. It never reaches above that base.
- A trailing `/` means a directory: that one directory is listed through the GitHub API (not recursive), and at most five of its image files (up to 50 are ranked) are checked, using the usual rules, so a `logo.png` in the folder is still skipped. Without a trailing `/` it is one file name or path with an image extension, fetched directly (an explicit file is trusted over the keyword rules, but still has to be a real, reasonably sized image).
- Plain relative segments only (letters, digits, `._-+@()` and single inner spaces; at most 6 segments, 200 characters). `..`, `.`, empty segments, a leading `/`, backslashes, `%`, `?`, `#`, URLs and schemes are errors, as is a name that is neither a directory (`/`) nor an image file.
- A directory listing needs the GitHub API. If it is rate limited the hint is retried at the next build and automatic discovery is used meanwhile.

Explicit URL rules: `https` only, no credentials, no localhost or private addresses (redirects included), real `image/*` content, at most 4 MiB, at least 240x120, neither banner-shaped nor a tall strip. The keyword rules (logo, badge, ...) do not apply to a URL the author chose. If it fails for a definite reason (404, not an image, too small) discovery continues automatically and the build prints a warning (a workflow annotation in GitHub Actions); if it fails temporarily the result is used but retried at the next build.

Errors in a directive (unknown name, empty or malformed value, a second directive, an `http:` URL, an unsafe or ambiguous hint, a comment that is not last on the line, a hint on a non-GitHub project) fail the README check with the line number. Case and spacing: `image: none` must be lower case; spaces inside the comment are free.

### How discovery works

`scripts/discover-images.mjs` runs in `npm run build` (and `npm run dev`) after the catalog is generated, and `src/lib/image-discovery.mjs` holds the rules. For every project in the generated catalog it looks only at the project's own URL:

- **GitHub repository** (`github.com/<owner>/<repo>`, optionally `/tree/<branch>`): the repository README is read from `raw.githubusercontent.com` (default branch via `HEAD`, or the branch in the URL). Images are taken from Markdown images, reference-style images, HTML `<img>` tags and plain links to image files. Relative paths (`docs/shot.png`, `./a.png`, `/docs/a.png`) are resolved against the README's own location and may not leave the repository; GitHub `blob/`, `raw/` and `raw.github.com` links become raw file URLs. If the README yields nothing, image files in documentation folders (`docs/`, `images/`, `screenshots/`, ... at most three levels deep) are tried when their names say "screenshot", "photo", "demo", "preview" and so on (this uses one GitHub API call per project), and finally a social-preview image the owner uploaded to the repository.
- **A directory inside a repository** (`.../tree/<branch>/<path>`): the same, but only from that directory's own README and files, never the parent repository's.
- **Any other web page:** `og:image` / `twitter:image` and, as a second choice, images in the page's `<main>` or `<article>`. A page image needs an explicit photo/screenshot cue (see below); a share image does not.
- **Not attempted:** links to a single file (`.../blob/...`), release or issue pages, and GitHub profile pages.

The choice is deterministic. Candidates are ranked, then the best ones are fetched and checked:

1. a photograph of the device running the project (file name, alt text or folder says photo/device/running, or a camera-style name such as `IMG_1234` or `20250721_013544`),
2. a screenshot, demo or animation (screenshot/demo/preview/UI words, a `screenshots/` folder, or a GIF),
3. any other project-specific image (an author-chosen share image, or an unlabelled README image).

A mention of "presto" in the name or alt text adds weight and earlier README position breaks ties. Never selected: badges and shields, logos, icons and favicons, avatars, sponsor/donate buttons, QR codes, diagrams, wiring and pinout pictures, generated GitHub social cards, Pimoroni shop product photos, a site's default share image (the front page's `og:image`), chat-service branding, video thumbnails unless nothing else exists, and any image shared by three or more projects (a logo, not a project picture). Each candidate is then downloaded far enough to prove it is a PNG, JPEG, GIF, WebP or SVG with `image/*` content type, at most 4 MiB, at least 240x120 pixels, and neither banner-shaped (wider than 3.5:1) nor a tall strip. At most five candidates are tried per project. URLs must be public `https` URLs (insecure `http` is upgraded; credentials, expiring signed links, localhost and private addresses are refused, including on redirects).

**Limits.** This is a heuristic, not a judgement. It can pick a representative image that is not the best one, pick a photo of something a README shows next to the project, or miss a good image because its file name gives no clue (a README that only links to an image *folder*, for example). It cannot see what is in a picture, so it cannot tell whether a photo shows third-party artwork or personal information. Sites that block automated requests (some return HTTP 403) simply get the icon. To get a good card, an author puts a photo or screenshot of the project near the top of the project's README, with a descriptive file name and alt text.

### How images are served

The page uses the **original image URL**; nothing is downloaded into the repository or hosted by the gallery. Each card has a fixed-height preview box with the category icon already in it. The `<img>` is positioned over the icon with `loading="lazy"`, `decoding="async"`, explicit `width`/`height`, `referrerpolicy="no-referrer"` and `object-fit: contain`, so an image of any size or shape cannot change the card. If it fails to load, a small script hides it and the icon stays. Cards without an image look identical in size and behaviour.

**Remote hosting and privacy.** These images are not first-party resources. A visitor's browser requests them from GitHub, Pimoroni, the forum CDN or whichever host the author uses, so that host sees the visitor's IP address and browser details (but not the gallery URL, because of `no-referrer`). Images stay the authors' property; the gallery only embeds what they already publish. The gallery page itself has no scripts, fonts or analytics from other origins; the browser tests fail if anything other than an image is requested from another origin. A remote image can change or disappear after the build, see below.

### Cache

Discovery results are kept in `site/.cache/project-images.json` (override with `PRESTO_IMAGE_CACHE`). It is **generated and disposable**: ignored by Git, never edited, safe to delete at any time, and not a source of truth. Compared with the alternatives (re-discovering every build, or committing results), a plain JSON file restored by a CI cache was the simplest reliable option: it needs no service, and the build is correct without it.

- Entries are keyed by the stable project ID and carry a fingerprint of the project URL, the README directive (type and value) and the discovery rules version. A changed URL, a changed, added or removed directive, a new rules version or a damaged file means rediscovery for that project. `image: none` is applied directly from the catalog and wins over anything cached.
- A result that could only be partly checked (the README's hint or URL failed temporarily, so the fallback image is shown) is used for rendering but looked up again at every build, and it never replaces an earlier complete result for the same directive.
- Found images are trusted for 7 days and "no image" results for 3 days; after that the project is looked up again. Build output, `npm run images:report -- --refresh` (all projects) and deleting the file all give the same result.
- Every build rewrites the file for the current catalog only, so a project removed from the README disappears from the cache; the page also reads cache entries only for projects in the catalog, so a removed project cannot leave a card.
- CI restores `site/.cache` with `actions/cache` (see `.github/workflows/pages.yml`). A cache miss only costs more requests.
- **Weekly refresh.** The Pages workflow also runs every Monday at 04:17 UTC on the default branch, with `PRESTO_IMAGE_REFRESH=1` so every image is looked up again (the restored cache is still used when a lookup fails). It runs the same catalog validation, unit tests and browser tests as a push. After the tests, it fetches the live page and compares it with the freshly built `index.html` (all cards, links and image URLs are in that file, and asset names carry content hashes): if they are byte-identical the deployment is skipped, otherwise (or if the live page cannot be fetched) it deploys. Pushes and manual runs always deploy. Nothing generated is committed, the built-in `GITHUB_TOKEN` is the only credential and permissions stay read-only apart from the deploy job's Pages permissions. The tradeoff: comparing `index.html` is simple and compares what visitors actually get, but it cannot see whether a remote image changed *content* at an unchanged URL (nothing in the page changes then either), and GitHub pauses scheduled workflows after 60 days without repository activity.

### When something goes wrong

Two kinds of failure are kept apart.

**Recoverable lookup problems never fail the build**, and the worst outcome is an icon: an image or page is unavailable, a site answers 403 or 404, a repository has no suitable image, GitHub rate-limits discovery, the network is down, or a README hint or URL cannot be used. Each is reported as a warning.

**Pipeline failures stop the build** with exit status 1 and a message: the generated catalog is invalid (wrong schema version, missing or malformed projects or directives), a configuration variable is invalid (for example `PRESTO_GITHUB_RAW_URL` or `PRESTO_IMAGE_BUDGET_SECONDS`), the cache file cannot be read or replaced (it is a directory, or has no permission), the cache cannot be written, or an unexpected exception shows a programming error. A merely damaged cache file is not one of these: it is disposable, so it is discarded with a warning and rebuilt. The script never calls `process.exit()`; it sets `process.exitCode` and lets the process end by itself, because exiting while sockets are closing can crash Node on Windows.

- **Temporary failure** (timeout after 15 s, network error, HTTP 5xx, 429): two retries with backoff. A project that still cannot be looked up keeps its previous cache entry, or has no entry and shows the icon, and is tried again at the next build. A failure is never cached as "no image".
- **Network down:** after four consecutive network failures the remaining lookups are skipped, so an offline build is fast and uses what the cache holds. `PRESTO_IMAGE_DISCOVERY=off` skips the network entirely. A total time budget (`PRESTO_IMAGE_BUDGET_SECONDS`, default 240) bounds a slow build.
- **GitHub rate limits:** README and image files come from `raw.githubusercontent.com`, which does not use the API quota. Only the documentation-folder step uses the API. Without a token the API allows 60 calls an hour; discovery stops using it when 5 remain (or on a 403/429 with no quota) and retries those projects at the next build. CI passes the built-in `GITHUB_TOKEN`, which raises the limit; locally a `GITHUB_TOKEN` or `GH_TOKEN` is optional. The token is only ever sent to `api.github.com`. No personal token is required.
- **An upstream image changes** (same URL, new picture): visitors see the new picture immediately, because the URL is unchanged. **A different image becomes the best choice** (README rewritten): the card changes after the cached result expires and the site is rebuilt.
- **An upstream image disappears or breaks after the build:** the browser fails to load it, the script hides it, and the card shows its category icon (the browser's console logs the failed request). The next build after the cache expires rejects the dead URL and picks another image or none. A rebuild is needed for the card to change; nothing is repaired at visit time. The Pages workflow currently runs only on pushes to `main` and manual runs (there is no schedule), so images are re-checked whenever the site is next deployed.
- **A wrong or unwanted image:** change the project's README entry (`image-hint`, `image: URL` or `image: none`), or improve the project's own README. Changing a directive changes the project's cache identity, so the next build uses it immediately; removing it restores automatic discovery.

### Maintainer commands

```sh
npm run images:report            # update the cache and print, per project: result, source, host, image URL, rejected candidates and reasons
npm run images:report -- --refresh   # ignore the cache and look everything up again
PRESTO_IMAGE_DISCOVERY=off npm run build   # build from the cache only, no network
```

If you change the rules in `src/lib/image-discovery.mjs`, raise `DISCOVERY_VERSION` so old caches are discarded. The unit tests (`tests/images.test.mjs` and `tests/directives.test.mjs`) cover URL normalisation, candidate rules, header parsing, hint and override priority and fallback, forced icons, cache identity and invalidation, pruning, offline and rate-limit behaviour, and non-zero exit statuses for pipeline failures, against a local fixture server; they never use the network. The README directive grammar is tested by `tests/test_image_directives.py`. The endpoint variables `PRESTO_GITHUB_RAW_URL`, `PRESTO_GITHUB_API_URL`, `PRESTO_GITHUB_WEB_URL` and `PRESTO_IMAGE_ALLOW_LOCAL` exist only to point discovery at that fixture.

## GitHub Pages

The production build sets the base URL from `GITHUB_REPOSITORY` (defaulting to this repository), so project Pages routes and assets use `/awesome-Pimoroni-Presto/`. Before enabling publication, configure the repository Pages source as **GitHub Actions**.

`.github/workflows/pages.yml` runs on pull requests, pushes to `main` and manual dispatch. It first reuses the README catalog validation workflow, then builds the site from the validated catalog artifact and runs the unit and browser tests. Pull requests only validate. The deploy job runs only for `main` (never a pull request or other branch) and only after validation, build and tests pass. It is not a deployment record: confirm repository Pages settings and run the workflow only after owner approval.

## Dependency audit

`npm audit` reports 5 findings (1 low, 3 high, 1 critical). All are in the Astro 5 development/build tree (`astro`, `esbuild`, `sharp`, `zod`, `zod-to-ts`); `npm audit --omit=dev` reports 0, because Astro is a development dependency and none of it is shipped: the output is plain static HTML, CSS and one small script.

**The build tree does run in CI, including for pull requests.** `.github/workflows/pages.yml` installs the dependencies (`npm ci`) and runs the Astro build and the tests on every pull request as well as on `main`, so a vulnerable build dependency executes on contributor-influenced input before the owner has merged anything. What limits the impact: pull-request runs have read-only repository permissions and no deployment rights, the deploy job runs only for `main`, and nothing is published until the owner merges. The README text reaches the build only as JSON produced by the repository parser and is rendered as escaped text.

The advisories, by exposure:

- **Zod, memory exhaustion (high, fixed in Zod 4.6.6, reached through `astro` and `zod-to-ts`).** Validating very large constrained collections can exhaust memory. Astro uses Zod at build time for its own configuration and content-collection schemas. This site does not use content collections and does not pass README-derived data through a Zod schema, so a README change cannot reach it. A pull request that changes the site code, `package.json` or the lockfile could, but such a pull request can already run arbitrary code in its own CI job, which is why the safeguards above (read-only token, no secrets, `main`-only deploy, owner review before merge) matter more than this advisory. The practical effect is a possible CI job failure or timeout (the build job is limited to 20 minutes), not a change to the published site.
- **Astro rendering advisories (critical).** These concern `define:vars`, spread attributes, view transitions, server islands, slot names, MDX/JSX rendering and image optimization, none of which this site uses, and the build-time Astro advisories matter only if untrusted content is rendered through them. The site renders README-derived text only through Astro's escaping text nodes.
- **`sharp` (high), `esbuild` (low).** Nothing in the site build or in image discovery uses `sharp`: project images are loaded from their original URLs and are never processed here. The `esbuild` advisory affects its development server on Windows; CI does not run it, but a Windows contributor running `npm run dev` locally is exposed to it.

The only suggested fix is a semver-major upgrade to Astro 7. That should be done as its own reviewed change, with a full rebuild and browser test run, not with `npm audit fix --force`. Until then these findings remain open build-time risk for the owner to accept or schedule; they are not a runtime risk to people visiting the site.
