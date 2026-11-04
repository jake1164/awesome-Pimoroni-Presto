<!--
Thanks for contributing! For a new project you normally edit only README.md. You do not need to touch
generated files, the website code, or any image data, and you do not need to run the test suites:
a check runs on your pull request and points at the exact README line if something needs fixing.
Delete anything below that does not apply.
-->

## What does this change?

<!-- e.g. "Adds <project name> to Games" -->

## Adding a project

The project list lives in `README.md`; the website is built from it automatically. Please:

- Add a project that is genuinely related to **Pimoroni Presto**.
- Put it in the most appropriate **existing category**, keeping that section's order (alphabetical where it already is) and formatting.
- Use the existing entry format on a single line: `- [Project title](https://link) — A short, useful description of what it does.`
- Give it a descriptive title and link **directly to the project** (repository, page or documentation).
- Check it is not already listed, and do not edit generated catalog files.

## Optional: project image

The website picks a photo or screenshot for each project's card automatically; if it finds none, the card shows a category icon. You can leave it at that. To guide or override the choice, add **one** comment at the very end of your entry (after any badge). Copy one of these:

```markdown
- [Project](https://github.com/owner/repo) — Description.
- [Project](https://github.com/owner/repo) — Description. <!-- image-hint: screenshots/ -->
- [Project](https://github.com/owner/repo) — Description. <!-- image: https://example.com/photo.jpg -->
- [Project](https://github.com/owner/repo) — Description. <!-- image: none -->
```

1. **No comment:** the image is found automatically from your project's README.
2. **`image-hint: path`** searches a preferred file or folder in your GitHub repository first (`screenshots/` or `images/presto.jpg`, relative to the repository).
3. **`image: https://…`** prefers one specific image (https only).
4. **`image: none`** shows the category icon.

Hints and overrides are optional. A real photo of a Presto running the project, or a screenshot, is best. If an image turns out wrong, fix it with a README-only change. If a hint or image cannot be used, the site falls back to automatic selection or the icon and still builds.

## Checklist

- [ ] The project is relevant to Pimoroni Presto.
- [ ] It is in the correct category.
- [ ] It is not a duplicate.
- [ ] The link works.
- [ ] The description is useful.
- [ ] The README formatting matches the other entries.
- [ ] Any image comment follows one of the forms above (or I did not add one).
