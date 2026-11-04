import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Writes the synthetic README for e2e/all-category.spec.mjs and e2e/images.spec.mjs. e2e/synthetic-site.mjs builds the site from it
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
- [Fixture With Image](https://github.com/fixture/with-image) — README-only project whose README embeds a picture.
- [Fixture No Image](https://github.com/fixture/no-image) — README-only project with no picture at all.
- [Fixture Rejected Image](https://github.com/fixture/rejected-image) — Its only README pictures are missing or too small.
- [Fixture Runtime Missing](https://github.com/fixture/runtime-missing) — Picture is valid at build time, then disappears.
- [Fixture Large Image](https://github.com/fixture/large-image) — Very large picture.
- [Fixture Tall Image](https://github.com/fixture/tall-image) — Very tall picture.
- [Fixture Hinted](https://github.com/fixture/hinted) — README picture, but the entry prefers a screenshots folder. <!-- image-hint: shots/ -->
- [Fixture Hint Fallback](https://github.com/fixture/hint-fallback) — The hinted folder does not exist, so the README picture is used. <!-- image-hint: nowhere/ -->
- [Fixture Forced Icon](https://github.com/fixture/forced-icon) — Has a README picture but the entry asks for the icon. <!-- image: none -->
- [Fixture With Image File](https://github.com/fixture/with-image/blob/main/README.md) — A file in a repository that another entry already lists: one star lookup serves both.
- [Fixture No Image Folder](https://github.com/fixture/no-image/tree/main/docs) — A folder in a repository that another entry already lists.
- [Fixture Gist](https://gist.github.com/someone/0123456789abcdef) — A gist is not a repository: no star count.
- [Fixture Profile](https://github.com/fixture) — A profile page is not a repository: no star count.
- [Fixture Issue](https://github.com/fixture/with-image/issues/1) — An issue is not a repository page: no star count.

<!-- catalog:end -->
`;

mkdirSync(directory, { recursive: true });
writeFileSync(path.join(directory, 'README.md'), readme, 'utf8');
