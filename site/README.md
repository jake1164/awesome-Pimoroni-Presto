# Awesome Pimoroni Presto gallery

The Astro static site in this folder reads its only project inventory from the root `README.md` through `tools/readme_catalog.py`. Catalog JSON is generated into `site/src/data/catalog.json` for the build and is ignored/not committed. Do not edit it by hand.

## Requirements

- Node.js 20 or later and npm
- Python 3.10 or later (the repository parser uses only the standard library)

## Local development

From the repository root:

1. `cd site`
2. `npm install`
3. `npm run dev`

`npm run dev` generates the catalog from the root README, collects GitHub star counts and project images (both cached, see below), then starts Astro on **http://localhost:8088/awesome-Pimoroni-Presto/** (the site is served under the Pages base path). It needs no arguments.

**Why port 8088, and why no `--port` argument?** Astro's default port 4321 can fail with `EACCES` on Windows because that port may fall inside a reserved range (check with `netsh interface ipv4 show excludedportrange protocol=tcp`; on some machines 4232-4331 is reserved). On some Windows/npm setups `npm run dev -- --port N` also loses its arguments (npm's argument forwarding, often through PowerShell), and Astro silently falls back to 4321 and crashes. So the host and port are set in the Astro configuration instead (`server` in `astro.config.mjs`, values in `site-config.mjs`) and the scripts never depend on forwarded arguments. 8088 is outside the reserved ranges.

To use another host or port, set an environment variable for that one command:

| Shell | Command |
|---|---|
| Windows PowerShell | `$env:PRESTO_DEV_PORT = '9000'; npm run dev` |
| Windows cmd.exe | `set PRESTO_DEV_PORT=9000 && npm run dev` |
| macOS, Linux, Git Bash | `PRESTO_DEV_PORT=9000 npm run dev` |

`PRESTO_DEV_HOST` works the same way (default `localhost`; use `0.0.0.0` to reach the server from another device). Invalid values stop with a message that names the variable. The same settings apply to `npm run preview`. Explicit `astro dev --port N` flags still override them if you run Astro directly. If the port is already in use, Astro picks the next free one and prints it.

## Build and test

```sh
npm run build        # generate the catalog from README.md, then build site/dist
npm test             # unit and integration tests (needs the build first)
npm run test:browser # browser smoke tests against the production build
npm run test:readme-variants # builds the site from changed copies of README.md and runs the gallery tests on each (about 2 minutes)
```

The gallery tests derive every expectation from the generated catalog, so a README-only contribution (projects added or removed, a category added or gone, a category named All, no NEW/RECENT badges) never needs a test change. `test:readme-variants` proves it: it works on temporary copies and never touches the real README, catalog or `dist/`. It picks categories from the README it is given instead of naming any; set `PRESTO_VARIANT_SOURCE` to a README path to derive the variants from a different README.

`npm run preview` serves the production build on the same host and port as `npm run dev` (http://localhost:8088/awesome-Pimoroni-Presto/ unless `PRESTO_DEV_HOST` / `PRESTO_DEV_PORT` say otherwise).

The browser tests use Playwright and need a browser once per machine: `npx playwright install chromium` (on Linux CI add `--with-deps`). They start `astro preview` themselves (with `node` directly, never through `npm run preview -- --port`, so they do not depend on npm argument forwarding) on port 8765; set `PRESTO_E2E_PORT` to use another port. They verify, in a real browser against `dist/`, that the page loads without JavaScript errors or third-party requests, and that search, category and NEW/RECENT filters, sorting, reset, the empty state and the Ctrl/⌘K and Escape shortcuts work. Expected counts come from the generated catalog and nothing assumes how many projects carry a NEW or RECENT badge, so README entries, category changes and badge rollover (including a README with no badges at all) do not require changing a test.

A second group of suites, `e2e/all-category.spec.mjs`, `e2e/images.spec.mjs` and `e2e/stars.spec.mjs`, runs against a separate site that `e2e/synthetic-site.mjs` builds from a synthetic README (`e2e/synthetic-readme.mjs`, output in the ignored `.synthetic/` folder, served on port 8772 or `PRESTO_E2E_SYNTHETIC_PORT`). The first checks that a README category literally named `All` stays independent of the unfiltered "All" control. The second checks automatic images: the synthetic README points at fixture repositories on a local stand-in for GitHub (port 8773 or `PRESTO_E2E_FIXTURE_PORT`), so image discovery runs for real, with no network access and no manifest. It covers a project whose README image is found, projects with no usable image, an image that disappears after the build, and very large and very tall images. The third checks GitHub star counts: the stand-in GitHub also answers the star API, with a count, a real zero, a server error, a malformed body or a 404 depending on the fixture repository, so the suite covers compact counts, links, deleted and unavailable repositories (no count, never zero), files and folders that resolve to one repository, gists, profiles and issues without a count, keyboard access and GitHub-stars sorting together with the other filters. The build honours these optional environment variables for this: `PRESTO_README` (README to parse), `PRESTO_CATALOG_FILE` (generated catalog path) and `PRESTO_OUT_DIR` (build output folder), plus `PRESTO_IMAGE_CACHE` and `PRESTO_STARS_CACHE` (generated caches). They default to the real README, `src/data/catalog.json`, `dist/` and `.cache/`.

To build from an already-validated catalog (as CI does), set `PRESTO_CATALOG_ARTIFACT` to its path, for example `PRESTO_CATALOG_ARTIFACT=src/data/catalog.json npm run build`.

The build runs the parser against the current root README and stops on invalid input. After that, a separate step reads GitHub star counts (see **GitHub star counts**) and another looks for a card image for each project (see **Project images**); lookup problems in either can never stop the build. The page's only third-party requests are the project images themselves (system fonts, no scripts, analytics or trackers). Cards without an image use a category-aware outline icon, with a generic grid icon for any category the site does not recognise.

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

**Network safety.** Project URLs come from README contributions, so the build treats every one as untrusted. All requests of the image and star steps (project pages, README files and images, the GitHub API, every redirect hop) go through one client (`createHttp`, with `src/lib/safe-network.mjs`). For each attempt it accepts only `http` and `https` URLs without credentials, resolves the host name itself, and refuses the request unless **every** resolved address is public: loopback, private (RFC 1918), shared (100.64/10), link-local (including cloud metadata at 169.254.169.254), multicast, unspecified, documentation and other reserved IPv4 ranges, and for IPv6 anything outside global unicast, with IPv4-mapped, NAT64 and 6to4 addresses judged by the IPv4 address they carry. The connection then goes only to those validated addresses (the host name is not resolved a second time, so DNS rebinding cannot redirect it), while the Host header, SNI and certificate check still use the original host name. Redirects (at most 5), time (15 s per request), response size and the number of requests are bounded. A refused request is a build warning (`request refused, ...`), the project simply keeps its category icon, and the build still succeeds. `PRESTO_IMAGE_ALLOW_LOCAL=1` is for the test fixture servers only: it additionally admits loopback addresses and nothing else, and the build prints a notice when it is set.

Malformed data from the outside (an invalid character reference such as `&#1114112;`, a redirect `Location` that is not a URL, a badly percent-encoded GitHub path) is treated as unusable input: that lookup is skipped with a warning naming the project and the URL, and the card shows its icon. Real build failures (an invalid catalog, broken configuration, an unwritable cache, a programming error) still stop with a non-zero exit status. Relative image links in a page are resolved against the page that actually answered, after redirects.

**Limits.** This is a heuristic, not a judgement. It can pick a representative image that is not the best one, pick a photo of something a README shows next to the project, or miss a good image because its file name gives no clue (a README that only links to an image *folder*, for example). It cannot see what is in a picture, so it cannot tell whether a photo shows third-party artwork or personal information. Sites that block automated requests (some return HTTP 403) simply get the icon. To get a good card, an author puts a photo or screenshot of the project near the top of the project's README, with a descriptive file name and alt text.

### How images are served

The page uses the **original image URL**; nothing is downloaded into the repository or hosted by the gallery. Each card has a fixed-height preview box with the category icon already in it. The `<img>` is positioned over the icon with `loading="lazy"`, `decoding="async"`, explicit `width`/`height`, `referrerpolicy="no-referrer"` and `object-fit: contain`, so an image of any size or shape cannot change the card. If it fails to load, a small script hides it and the icon stays. Cards without an image look identical in size and behaviour.

**Remote hosting and privacy.** These images are not first-party resources. A visitor's browser requests them from GitHub, Pimoroni, the forum CDN or whichever host the author uses, so that host sees the visitor's IP address and browser details (but not the gallery URL, because of `no-referrer`). Images stay the authors' property; the gallery only embeds what they already publish. The gallery page itself loads no fonts and no third-party scripts, except Google Analytics after a visitor opts in on the live site (see **Analytics and privacy**); on every other origin, and for every visitor who has not opted in, the browser tests fail if anything other than an image is requested from another origin. A remote image can change or disappear after the build, see below.

### Cache

Discovery results are kept in `site/.cache/project-images.json` (override with `PRESTO_IMAGE_CACHE`). It is **generated and disposable**: ignored by Git, never edited, safe to delete at any time, and not a source of truth. Compared with the alternatives (re-discovering every build, or committing results), a plain JSON file restored by a CI cache was the simplest reliable option: it needs no service, and the build is correct without it.

- Entries are keyed by the stable project ID and carry a fingerprint of the project URL, the README directive (type and value) and the discovery rules version. A changed URL, a changed, added or removed directive, a new rules version or a damaged file means rediscovery for that project. `image: none` is applied directly from the catalog and wins over anything cached.
- A result that could only be partly checked (the README's hint or URL failed temporarily, so the fallback image is shown) is used for rendering but looked up again at every build, and it never replaces an earlier complete result for the same directive.
- Found images are trusted for 7 days and "no image" results for 3 days; after that the project is looked up again. Build output, `node scripts/discover-images.mjs --refresh` (all projects) and deleting the file all give the same result.
- Every build rewrites the file for the current catalog only, so a project removed from the README disappears from the cache; the page also reads cache entries only for projects in the catalog, so a removed project cannot leave a card.
- CI restores `site/.cache` with `actions/cache` (see `.github/workflows/pages.yml`). A cache miss only costs more requests.
- **Weekly refresh.** The Pages workflow also runs every Monday at 04:17 UTC on the default branch, with `PRESTO_IMAGE_REFRESH=1` so every image is looked up again (the restored cache is still used when a lookup fails). It runs the same catalog validation, unit tests and browser tests as a push and then deploys like a push; star counts older than 24 hours (everything restored from last week's cache) are looked up in the same build. There is no "skip the deployment if nothing changed" check: an earlier version compared the built `index.html` with the live page, but star counts make the page differ almost every week, and the comparison needed the network, the Pages URL and byte-identical output, which is one more thing that can be wrong for little gain. Nothing generated is committed, the built-in `GITHUB_TOKEN` is the only credential and permissions stay read-only apart from the deploy job's Pages permissions. GitHub pauses scheduled workflows after 60 days without repository activity. Scheduled runs only start from the default branch (`main`), so the schedule is inactive until this workflow is merged there. Pushes, scheduled runs and manual runs on `main` share one concurrency group and never cancel each other (a newer waiting run replaces an older waiting one, which is harmless because each builds the latest `main`). The restored cache is best-effort: GitHub evicts caches not used for 7 days, which only costs extra lookups (and the stale-count fallback) for one build.

### When something goes wrong

Two kinds of failure are kept apart.

**Recoverable lookup problems never fail the build**, and the worst outcome is an icon: an image or page is unavailable, a site answers 403 or 404, a repository has no suitable image, GitHub rate-limits discovery, the network is down, or a README hint or URL cannot be used. Each is reported as a warning.

**Pipeline failures stop the build** with exit status 1 and a message: the generated catalog is invalid (wrong schema version, missing or malformed projects or directives), a configuration variable is invalid (for example `PRESTO_GITHUB_RAW_URL` or `PRESTO_IMAGE_BUDGET_SECONDS`), the cache file cannot be read or replaced (it is a directory, or has no permission), the cache cannot be written, or an unexpected exception shows a programming error. A merely damaged cache file is not one of these: it is disposable, so it is discarded with a warning and rebuilt. The script never calls `process.exit()`; it sets `process.exitCode` and lets the process end by itself, because exiting while sockets are closing can crash Node on Windows.

- **Temporary failure** (timeout after 15 s, network error, HTTP 5xx, 429): two retries with backoff. A project that still cannot be looked up keeps its previous cache entry, or has no entry and shows the icon, and is tried again at the next build. A failure is never cached as "no image".
- **Network down:** after four consecutive network failures the remaining lookups are skipped, so an offline build is fast and uses what the cache holds. `PRESTO_IMAGE_DISCOVERY=off` skips the network entirely. A total time budget (`PRESTO_IMAGE_BUDGET_SECONDS`, default 240) bounds a slow build.
- **GitHub rate limits:** README and image files come from `raw.githubusercontent.com`, which does not use the API quota. Only the documentation-folder step uses the API. Without a token the API allows 60 calls an hour; discovery stops using it when 5 remain (or on a 403/429 with no quota) and retries those projects at the next build. CI passes the built-in `GITHUB_TOKEN`, which raises the limit; locally a `GITHUB_TOKEN` or `GH_TOKEN` is optional. The token is only ever sent to `api.github.com`. No personal token is required.
- **An upstream image changes** (same URL, new picture): visitors see the new picture immediately, because the URL is unchanged. **A different image becomes the best choice** (README rewritten): the card changes after the cached result expires and the site is rebuilt.
- **An upstream image disappears or breaks after the build:** the browser fails to load it, the script hides it, and the card shows its category icon (the browser's console logs the failed request). The next build after the cache expires rejects the dead URL and picks another image or none. A rebuild is needed for the card to change; nothing is repaired at visit time. The weekly scheduled workflow re-checks every image and rebuilds the site, so a dead image is replaced within a week.
- **A wrong or unwanted image:** change the project's README entry (`image-hint`, `image: URL` or `image: none`), or improve the project's own README. Changing a directive changes the project's cache identity, so the next build uses it immediately; removing it restores automatic discovery.

### Maintainer commands

```sh
npm run images:report            # update the cache and print, per project: result, source, host, image URL, rejected candidates and reasons
node scripts/discover-images.mjs --report --refresh   # ignore the cache and look everything up again
PRESTO_IMAGE_DISCOVERY=off npm run build   # build from the cache only, no network (POSIX shells; see the table above for PowerShell and cmd)
```

If you change the rules in `src/lib/image-discovery.mjs`, raise `DISCOVERY_VERSION` so old caches are discarded. The unit tests (`tests/images.test.mjs`, `tests/directives.test.mjs`, `tests/network-safety.test.mjs` and `tests/discovery-robustness.test.mjs`) cover URL normalisation, candidate rules, header parsing, hint and override priority and fallback, forced icons, cache identity and invalidation, pruning, offline and rate-limit behaviour, and non-zero exit statuses for pipeline failures, destination safety (protected local servers must receive zero requests), malformed input and redirect handling, against local fixture servers; they never use the network. The README directive grammar is tested by `tests/test_image_directives.py`. The endpoint variables `PRESTO_GITHUB_RAW_URL`, `PRESTO_GITHUB_API_URL`, `PRESTO_GITHUB_WEB_URL` and `PRESTO_IMAGE_ALLOW_LOCAL` exist only to point discovery at that fixture.

## GitHub star counts

**Adding a project needs README.md only.** Cards for projects that link to a GitHub repository show a small star icon and the repository's star count, such as `★ 1.2k`. Nothing is entered by contributors, and the counts are never part of the README or of the generated catalog, so project IDs and the catalog do not depend on them.

### What is looked up

`scripts/fetch-stars.mjs` runs in `npm run build` and `npm run dev` after the catalog is generated and before images, and `src/lib/github-stars.mjs` holds the rules. A project link counts as a repository when it is:

- `github.com/<owner>/<repo>` (also `www.`, a trailing `/`, `.git`, a query or fragment), or
- a **file or folder inside** a repository: `.../blob/<ref>/<path>` or `.../tree/<ref>/<path>`, or
- its **releases**: `.../releases`, `.../releases/tag/<tag>` or `.../releases/latest`.

These resolve to the repository, and the count is the repository's.

Not repositories, so no count: gists (`gist.github.com`), profiles and organizations, issues, pull requests, wikis, discussions, release downloads and other repository sub-pages, GitHub feature pages (`orgs/`, `sponsors/`, `topics/`, `marketplace/`, ...), other sites (including `*.github.io` and `raw.githubusercontent.com`), and malformed names. Case does not matter (`Owner/Repo` and `owner/repo` are one repository, as on GitHub). Several projects can point into one repository (for example the repository and two examples inside it); each repository is requested **once** per build.

For each repository the build calls GitHub's REST API (`GET /repos/<owner>/<repo>`) and reads `stargazers_count`. A renamed or transferred repository is followed through GitHub's redirect and linked under its current name. The browser never calls GitHub; the count is in the page when it is built.

### Cache, refresh and failures

Counts are kept in `site/.cache/github-stars.json` (override with `PRESTO_STARS_CACHE`), next to the image cache. It is **generated and disposable**: ignored by Git, safe to delete, keyed by `owner/repo` (not by project ID), pruned to the current catalog on every build and written in sorted order.

- **24 hours.** A count looked up in the last 24 hours is reused; an older one is looked up again. CI restores `site/.cache` (see the Pages workflow), so pushes within a day make no star requests, and the weekly scheduled build finds everything expired and refreshes it. `--refresh` (`node scripts/fetch-stars.mjs --refresh`) or `PRESTO_STARS_REFRESH=1` looks everything up again.
- **A failure never erases a valid count.** If a refresh fails (rate limit, network down, HTTP 5xx, timeout, a response without a valid `stargazers_count`), the earlier cached count is kept and tried again at the next build. A kept count is shown for at most 30 days; after that the card shows no count (the page also refuses to render a count older than that, even if the cache was not refreshed, for example `astro build` run on its own).
- **Unknown is never zero.** A card shows a count only when one is known. Without one (never looked up, API unavailable, malformed answer, deleted repository) there is no star icon and no placeholder. A repository that really has 0 stars shows `0`.
- **Deleted repositories.** A 404, 410 or 451 answer marks the repository as missing for 24 hours (any earlier count is dropped) and it shows no count. The project link itself is not changed.
- **Rate limits.** Without a token the API allows 60 calls an hour; the build stops asking when 5 remain (or on a 403/429 with no quota) and uses the cache. About 35 repositories are looked up on a cold cache, one call each, so a cold local build without a token fits, and warm builds need none. The stars step runs before image discovery; discovery sees the remaining quota and stops early if needed, and retries at the next build.
- **Never required, never leaked.** `GITHUB_TOKEN` or `GH_TOKEN` is optional and only raises the limit; it is sent to the API origin only. CI passes the built-in `GITHUB_TOKEN`, which needs no permission beyond `contents: read`. No personal token or secret is needed.
- **Lookup problems never fail the build**, they print warnings (workflow annotations in GitHub Actions). The step stops the build only for pipeline failures: an invalid catalog, an invalid setting (`PRESTO_GITHUB_STARS`, `PRESTO_GITHUB_API_URL`, `PRESTO_STARS_BUDGET_SECONDS`), or a cache file that cannot be read or replaced. A damaged cache file is just discarded. `PRESTO_GITHUB_STARS=off` makes no request at all and uses what the cache holds (offline builds). The script sets `process.exitCode` rather than calling `process.exit()`, for the same Windows reason as image discovery.

### How counts appear

- Each card with a known count shows a compact outline star and the number in its footer, next to the category, in the same muted style. Counts of 1,000 or more are abbreviated by truncation: `1.2k`, `15.2k`, `999.9k`, `1.2M` (never rounded up to a larger unit). Cards without a known count look exactly as before.
- The star and count are one link to the repository on GitHub (opens in a new tab with `rel="noopener noreferrer"`), reachable with the keyboard and at least 44 px tall. Its accessible name contains the visible text and the exact number: *"1.2k (1,234) GitHub stars for <project>. Opens the repository on GitHub."*; the tooltip says *"1,234 stars on GitHub"*. The icon is hidden from assistive technology. It is deliberately a plain star labelled "GitHub", not a heart: the community hearts feature is deferred and star counts are not votes on this gallery.
- **Sorting.** *Sort by → GitHub stars* lists projects with a known count first, highest first, then projects without one (including every non-GitHub project). Ties are broken by title, then by project ID, so the order is always the same. It works with search, category and NEW/RECENT filters like the other sorts. The option is only offered when at least one count is known. The default sort (*Name*) is unchanged.

### Maintainer commands

```sh
node scripts/fetch-stars.mjs --report     # or: npm run stars:report. One line per project: count, not-found, unknown or n/a
node scripts/fetch-stars.mjs --refresh    # look every repository up again
PRESTO_GITHUB_STARS=off npm run build     # build from the cache only, no network (POSIX shells; see the table above for PowerShell and cmd)
```

Arguments are passed to `node` directly because `npm run <script> -- <args>` is not reliable on every Windows setup. The unit tests (`tests/stars.test.mjs`) cover URL classification and repository extraction (files, directories, duplicates, gists, profiles, issues, malformed URLs), valid, missing, malformed and unavailable answers, API failures, rate limits, a down network, cache hits, expiry at exactly 24 hours, recovery from damaged caches, sorting with missing counts, card rendering of the built page, README-only additions and a catalog that is byte-identical with or without star data, against a local fixture server; they never use the network. `tests/dev-server.test.mjs` covers the Windows-safe development startup.

## Analytics and privacy

The live site can measure how it is used with Google Analytics 4 (measurement ID `G-K5XSTX64R3`). It is off unless the visitor turns it on, and it runs only on the live page. Google Analytics is not anonymous: it uses cookies and pseudonymous identifiers and may collect browser and device information. The banner says so, in those words.

**Consent.** The first visit shows a banner (Allow analytics / No thanks). Until "Allow analytics" is pressed the page makes no Google request, loads no Google script, sets no cookie and creates no `dataLayer`. "Privacy / Analytics settings" at the bottom of the page reopens the banner so the choice can be changed at any time. A missing, malformed or unknown stored value is treated as "no consent".

**Where it runs.** Only on the exact page `https://jake1164.github.io/awesome-Pimoroni-Presto/` (constants in `src/scripts/analytics.js`, checked against `site-config.mjs` by `tests/analytics.test.mjs`). `localhost`, `astro preview`, nested paths such as `/awesome-Pimoroni-Presto/preview/`, `/index.html`, sibling paths, forks, other hosts and the automated tests never load Google, whatever is stored in the browser, and the banner and settings control stay hidden there.

**What Google is told about the page.** `page_location` is pinned to the canonical page URL (no query string, no fragment) and `page_referrer` to the referrer's origin (`https://example.org/`, or nothing). Google's library also has an automatic "site search" feature that reads the address bar's query string itself (it ignores `page_location`), so when analytics is about to load the page removes the query string from the address bar (the fragment stays). The gallery uses no query parameters; the side effect is that campaign tags such as `utm_source` are not seen by Google either. Custom event parameters never hold free text or addresses (table below).

**Several tabs, one choice.** The choice lives in `localStorage` (`presto-analytics-consent`: `granted` or `denied`). Every open tab re-reads it when the browser's `storage` event arrives, when the tab becomes visible again, and before it sends any custom event. Withdrawing in one tab therefore switches the others off as soon as they receive the event (browsers deliver it asynchronously, so not before): their events stop, `ga-disable` is set, consent is updated, their cookies are removed and their banner and status update. Granting in another tab switches a waiting tab on without loading the library twice or sending a second page view.

**Events** (all sent only while analytics is on and consent stands in storage; events requested earlier are dropped, never queued or replayed):

| Event | Parameters | When |
| --- | --- | --- |
| `page_view` | `page_location`, `page_referrer` (sanitized, see above) | once per page load, when analytics first turns on |
| `search_used` | none | once when a search starts (empty to non-empty); never the text |
| `category_selected` | `category`: the category slug, or `_all` | the selected category changes |
| `sort_changed` | `sort_by`: `name`, `category` or `stars` | the sort changes |
| `badge_filter_changed` | `badge`: `NEW` or `RECENT`; `enabled`: `true` or `false` | a badge filter is toggled |
| `project_opened` | `project_id`: the stable catalog ID; `category`: slug | the "Visit project" link or a link inside the project's description (a live demo, a forum thread) is used by click, keyboard or middle click; never the address |
| `support_click` | `support_type`: `star`, `github_sponsors` or `buy_me_a_coffee`; `placement`: `header` or `footer` | a support link is used |

A project's GitHub star count link is not a project open and not support. Clicks are not hearts or votes, and counts are events, not unique visitors.

**Withdrawing.** Declining after allowing stops collection from that page: our events stop, Google's documented opt-out switch `window['ga-disable-G-K5XSTX64R3']` is set (Consent Mode alone would still let the loaded library send cookieless pings), consent is updated to denied, and the first-party `_ga`, `_ga_K5XSTX64R3` (the ID without `G-`), `_gid` and `_gat*` cookies are deleted. Allowing again in the same page load resumes events without loading the library again or sending a second page view. After a reload a withdrawn choice loads nothing.

**When the browser will not store the choice.** Withdrawal always switches the current page off first. It is then written to `localStorage`; if that fails while an earlier "granted" is still readable, a per-tab denial is written to `sessionStorage` instead; and the page says which of these held, never more:

| What could be stored | What the visitor is told | After a reload |
| --- | --- | --- |
| `localStorage` accepted the denial | "Analytics declined" | stays off, in every tab |
| writes failed, but the old grant could be removed | "off ... would not save this choice, so you may be asked again" | the banner asks again |
| writes and removal failed, `sessionStorage` accepted a denial | "off for this browser session ... an earlier allow may apply again in a new session" | stays off in this tab; other tabs and later sessions read the old grant |
| nothing could be stored | "off on this page only ... an earlier allow may apply again when you reload or return" | the old grant applies again, and the page then says "Analytics allowed" so the visitor can withdraw again |

The last two rows are limits of the browser, not of the page: with every write blocked nothing can revoke an earlier grant for later page loads. Nothing is stored on a server, and no extra cookie is used for the choice.

**Limits.** Data Google has already received is not recalled by withdrawing. Google's library holds events for a few seconds before sending them, so an event generated just before withdrawing may still be sent in the seconds that follow; nothing generated after the withdrawal is. A loaded library stays in memory until the page is reloaded (it is silenced, not unloaded). Automatic events of the GA4 data stream cannot all be switched off in code; see **Required GA4 Console Configuration**.

### Required GA4 Console Configuration

Code in this repository controls what the page sends; **Google Analytics settings control what Google's own library collects by itself**. (Menu names are from the GA4 Admin area at the time of writing and may move; they were not checked against the live property.)

**Status as reported by the owner (2026-11-04; not independently verified, and the site had not been deployed):** Enhanced measurement is disabled and data retention is 14 months for `G-K5XSTX64R3`. Steps 2 and 3 (Google signals, advertising features, data sharing) and step 5 (verification on the deployed site) are still to be done or confirmed. With the real `gtag.js` and every Google request answered locally, the browser tests then saw no `scroll`, `view_search_results` or outbound `click`; that shows the library's behaviour, not the console setting itself.

| Controlled by | What |
| --- | --- |
| This code | consent and its withdrawal, the production-only page gate, canonical `page_location`, origin-only `page_referrer`, the query string removed before the library loads, the seven events above and their parameters, no advertising consent, no Google signals, `send_page_view: false` with one explicit `page_view` |
| The GA4 console | Enhanced measurement events (scroll, outbound click, site search, downloads, video, forms), data retention, Google signals, data sharing, reporting identity, any product links |
| Neither (always on in GA4) | `user_engagement`, `first_visit`, `session_start` and Google's own device, browser and approximate-location dimensions |

1. **Disable Enhanced measurement.** Admin > Data collection and modification > Data streams > the web stream for `G-K5XSTX64R3` > Enhanced measurement: switch off Scrolls, Outbound clicks, **Site search**, Video engagement, File downloads and Form interactions, and under Page views > advanced settings switch off "Page changes based on browser history events" (the page sends its own `page_view`). Simplest: turn the master Enhanced measurement toggle off. Why: the library reads these settings from Google when it loads, so they apply to the live site; during development real `gtag.js` produced `view_search_results` (with the raw `q` value), `scroll`, outbound `click` and `user_engagement` events that this repository's code cannot all suppress. The query string is now removed before the library loads, which stops site search from seeing it, but the setting should be off regardless.
2. **Review automatic collection and reporting.** Admin > Data collection and modification > Data collection: leave Google signals data collection **off**; leave "Advanced settings to allow for ads personalization" **off**; consider switching off granular location and device data collection. Admin > Data display > Reporting identity: choose "Device-based" so the reports do not depend on Google signals.
3. **Disable advertising features.** Admin > Product links: no Google Ads link. Admin > Data collection and modification > Data sharing settings: switch off every optional sharing toggle you do not need (Google products and services, modeling contributions, technical support, account specialists).
4. **Set data retention.** Admin > Data collection and modification > Data retention: the shortest setting is 2 months and the longest is 14 months; the owner reported choosing 14 months. Keep "Reset user data on new activity" off.
5. **Verify after deployment.** On the live site allow analytics, use the gallery (search, filter, sort, open a project and a description link, press each support link), then check Reports > Realtime (event count by event name) and, with the Google Analytics Debugger browser extension, Admin > DebugView. Expected: `page_view`, `user_engagement` and the custom events in the table above and nothing else; in particular **no** `scroll`, `click`, `view_search_results`, `file_download`, `video_*` or `form_*`; `page_location` shows only `https://jake1164.github.io/awesome-Pimoroni-Presto/`; no search text, query value or project address appears in any parameter. Then withdraw consent and confirm no new events arrive.
6. **Record the result.** Once verified, record the date and what was seen in the master plan, and run `PRESTO_E2E_REQUIRE_CLEAN_GA=1 PRESTO_E2E_REAL_GTAG=1 npm run test:browser` (needs the network; every Google request is still answered locally): it fails if the real library still emits any automatic event other than `user_engagement`, because the library carries the stream's current settings.

**Tests.** `tests/analytics.test.mjs` tests the consent logic against fake browsers (several tabs share a fake `localStorage`). `e2e/analytics.spec.mjs` runs on desktop and mobile Chromium with every Google request intercepted (nothing reaches Google): by default a deterministic stand-in for `gtag.js`; `PRESTO_E2E_REAL_GTAG=1 npm run test:browser` fetches Google's real `gtag.js` instead (needs the network; slower because the library batches events), and the Google requests are still answered locally. The suite uses two real tabs of one browser context for the cross-tab cases and patches `Storage` for the storage-failure cases. `PRESTO_E2E_FRESH_SERVERS=1` makes Playwright refuse to reuse a preview server already listening on the port; combine it with `PRESTO_E2E_PORT`, `PRESTO_E2E_SYNTHETIC_PORT` and `PRESTO_E2E_FIXTURE_PORT` for an isolated run.

## GitHub Pages

The production build sets the base URL from `GITHUB_REPOSITORY` (defaulting to this repository), so project Pages routes and assets use `/awesome-Pimoroni-Presto/`. Before enabling publication, configure the repository Pages source as **GitHub Actions**.

`.github/workflows/pages.yml` runs on pull requests, pushes to `main`, manual dispatch and a weekly schedule (Mondays 04:17 UTC). It first reuses the README catalog validation workflow, then builds the site from the validated catalog artifact and runs the unit and browser tests. Pull requests only validate. The deploy job runs only for `main` (push, manual run or schedule) (never a pull request or other branch) and only after validation, build and tests pass. It is not a deployment record: confirm repository Pages settings and run the workflow only after owner approval.

## Dependency audit

`npm audit` reports 5 findings (1 low, 3 high, 1 critical). All are in the Astro 5 development/build tree (`astro`, `esbuild`, `sharp`, `zod`, `zod-to-ts`); `npm audit --omit=dev` reports 0, because Astro is a development dependency and none of it is shipped: the output is plain static HTML, CSS and one small script.

**The build tree does run in CI, including for pull requests.** `.github/workflows/pages.yml` installs the dependencies (`npm ci`) and runs the Astro build and the tests on every pull request as well as on `main`, so a vulnerable build dependency executes on contributor-influenced input before the owner has merged anything. What limits the impact: pull-request runs have read-only repository permissions and no deployment rights, the deploy job runs only for `main`, and nothing is published until the owner merges. The README text reaches the build only as JSON produced by the repository parser and is rendered as escaped text.

The advisories, by exposure:

- **Zod, memory exhaustion (high, fixed in Zod 4.6.6, reached through `astro` and `zod-to-ts`).** Validating very large constrained collections can exhaust memory. Astro uses Zod at build time for its own configuration and content-collection schemas. This site does not use content collections and does not pass README-derived data through a Zod schema, so a README change cannot reach it. A pull request that changes the site code, `package.json` or the lockfile could, but such a pull request can already run arbitrary code in its own CI job, which is why the safeguards above (read-only token, no secrets, `main`-only deploy, owner review before merge) matter more than this advisory. The practical effect is a possible CI job failure or timeout (the build job is limited to 20 minutes), not a change to the published site.
- **Astro rendering advisories (critical).** These concern `define:vars`, spread attributes, view transitions, server islands, slot names, MDX/JSX rendering and image optimization, none of which this site uses, and the build-time Astro advisories matter only if untrusted content is rendered through them. The site renders README-derived text only through Astro's escaping text nodes.
- **`sharp` (high), `esbuild` (low).** Nothing in the site build or in image discovery uses `sharp`: project images are loaded from their original URLs and are never processed here. The `esbuild` advisory affects its development server on Windows; CI does not run it, but a Windows contributor running `npm run dev` locally is exposed to it.

The only suggested fix is a semver-major upgrade to Astro 7. That should be done as its own reviewed change, with a full rebuild and browser test run, not with `npm audit fix --force`. Until then these findings remain open build-time risk for the owner to accept or schedule; they are not a runtime risk to people visiting the site.
