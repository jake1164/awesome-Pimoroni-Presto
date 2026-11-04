# Contributing

Thanks for your interest in contributing to **Awesome Pimoroni Presto**!

## How to add an item
1. Make sure it’s **relevant to Pimoroni Presto** (tutorials, code, projects, updates, community resources).
2. Prefer **original sources** (official docs, creator repos) and include a useful one‑line description.
3. Open a PR that adds your link to the appropriate section in `README.md`.
4. Keep alphabetical ordering within sections when possible.
5. Avoid duplicates and dead links.

## README entry format
`README.md` is the only file you need to edit; the website is generated from it. Everything between the `<!-- catalog:start -->` and `<!-- catalog:end -->` comments is the catalog:

- **Categories** are `### Category name` headings. To add, rename, reorder or remove a category, edit the headings (no code or configuration changes are needed). Add it to the **Contents** list too so it shows up in the README's navigation.
- **Projects** are single lines directly under their category:

  ```markdown
  - [Project name](https://example.org/project) — A one-line description with an optional [link](https://example.org/more). ![NEW](badges/new.svg)
  ```

  - Start with `- [title](URL)`; the URL must be `http` or `https` with a plain ASCII host. Write an internationalized host in its punycode (`xn--`) form; backslashes and invalid `%` escapes are rejected.
  - The description is optional. It follows an em dash (—), an en dash (–) or a hyphen and a space, stays on the same line, and may contain only plain text and `[text](https://...)` links (no HTML or images).
  - An optional badge goes at the end of the line, after the description (see below), and an optional image comment goes last of all (see **Project images**).
- **Not supported** inside the markers: wrapped or indented lines, nested or numbered lists, HTML comments other than the one image comment, other prose, horizontal rules, and headings other than `###`. The check names the line to fix.
- **Duplicates** are detected by canonical URL, so differences in GitHub owner/repo case, `.git`, a trailing slash, `http` versus `https` or `www.` on github.com, and `#fragment` are ignored.
- **Changing a project's URL** gives it a new identity on the website, so any data attached to the old one (such as future hearts) must be migrated by the maintainer. Please mention it in your PR.
- Text outside the markers is ordinary README content, but entries placed there would not be published, so the check **fails** on any list item (bulleted or numbered, at any indentation) outside the markers that begins with an `http(s)` link or carries a badge. Prose links, tables, quotes, relative or `#anchor` links, bullets that begin with text (for example `- Docs: [site](https://...)`), and code blocks are fine. Markers or entries shown inside a fenced code block are treated as examples; keep such fences at the top level (not inside a list item) and always close them.

## Project images
You only ever edit `README.md`. When the website is built it picks a photo or screenshot for your project's card automatically from your project's own README or page; if it finds nothing suitable, the card shows a category icon. There is nothing to upload and no approval step. A photo of a Presto running your project, or a screenshot, near the top of your own README (with a descriptive file name and alt text) gives the best result. Badges, logos, banners, diagrams and generic product photos are ignored.

To guide or override the choice, end your entry with **one** HTML comment (after any badge):

```markdown
- [Project](https://github.com/owner/repo) — Description. <!-- image-hint: screenshots/ -->
- [Project](https://github.com/owner/repo) — Description. <!-- image: https://example.com/photo.jpg -->
- [Project](https://github.com/owner/repo) — Description. <!-- image: none -->
```

- `image-hint: path` – look first at a file (`images/presto.jpg`) or folder (`screenshots/`) in your own GitHub repository, relative to the repository (or to the linked folder for a `/tree/branch/folder` link). Plain relative paths only: no `..`, no leading `/`, no URLs.
- `image: https://…` – prefer this one image (https only).
- `image: none` – always show the category icon.

Without a comment, discovery is fully automatic. Use at most one comment per entry; unknown or malformed ones fail the README check with the line to fix. If a hint or URL cannot be used, the site falls back to automatic selection (or the icon) and still builds. An unwanted or wrong image is corrected by changing your entry, or your own README, never site files. Details and limits: [site/README.md](site/README.md#project-images). The pull request template repeats these examples.

## GitHub star counts
If your project links to a GitHub repository (the repository itself, or a file or folder in it), its card shows the repository's star count automatically; the website reads it from GitHub when it is built and refreshes it at least weekly. You do not enter, update or approve anything, and the count never appears in `README.md`. Links to gists, profiles, issues or other sites simply show no count. Details: [site/README.md](site/README.md#github-star-counts).

## Suggest a project or report a problem
- **Suggest a project:** open a pull request that adds one line to `README.md` (see above). If you would rather not edit the file, [open an issue](https://github.com/jake1164/awesome-Pimoroni-Presto/issues) with the link and a one-line description, and the maintainer can add it.
- **Report a problem** (a dead link, a wrong description, an unwanted or wrong card image, a problem on the website): [open an issue](https://github.com/jake1164/awesome-Pimoroni-Presto/issues) that says what you saw and where. A pull request is even better, because the list, descriptions and card images are all corrected by editing the project's line in `README.md`; the website is rebuilt from it automatically.
- Please do not put personal information in an issue or pull request.

## Badges
We use simple badges to help readers spot new items. An entry has at most one:

- `![NEW](badges/new.svg)` – added in the current cycle
- `![RECENT](badges/recent.svg)` – was NEW last cycle

## Code of Conduct
Be respectful and constructive. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/).

## License
By contributing, you agree that your contributions are released under the terms of the repository’s [CC0 1.0](LICENSE).
