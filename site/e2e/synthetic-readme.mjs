import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes the synthetic README for e2e/all-category.spec.mjs. The Playwright web server builds the site from it
// into `.synthetic/` (see playwright.config.mjs), so the real catalog and `dist/` are never touched.
// One category is literally named "All" (slug `all`); badges are split so NEW and RECENT live in different categories.
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.synthetic');

const readme = `# Synthetic list

<!-- catalog:start -->

### All

- [All Alpha](https://example.org/all-alpha) — First project in a category named All. ![NEW](badges/new.svg)
- [All Beta](https://example.org/all-beta) — Second project in a category named All.

### Other

- [Other Gamma](https://example.org/other-gamma) — A project outside the All category. ![RECENT](badges/recent.svg)
- [Other Delta](https://example.org/other-delta) — Another project outside the All category.

<!-- catalog:end -->
`;

mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'README.md'), readme, 'utf8');
