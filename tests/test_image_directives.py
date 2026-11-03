"""Optional image directives: ``<!-- image-hint: ... -->``, ``<!-- image: ... -->``, ``<!-- image: none -->``.

Directives are metadata at the very end of a project entry. They must never change a
project's description or identity, and malformed ones must fail with a useful message.
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from support import (
    ROOT,
    CatalogError,
    CatalogTestCase,
    build_readme,
    entry,
    parse_readme,
    project_ids,
    replace_once,
    sample_readme,
)

REPO = "https://github.com/owner/repo"
BASE = f"- [Tool]({REPO}) — A useful tool."


def readme_with(line: str, *others: str) -> str:
    return build_readme([("Alpha", [line, *others])])


class DirectiveTests(CatalogTestCase):
    def project(self, line: str) -> dict:
        return self.parse(readme_with(line))["projects"][0]

    def test_no_directive_means_no_image_key_and_unchanged_output(self) -> None:
        project = self.project(BASE)
        self.assertNotIn("image", project)
        self.assertEqual(
            set(project),
            {"id", "category", "category_slug", "title", "url", "description", "description_parts", "badges"},
        )

    def test_all_three_directive_forms(self) -> None:
        cases = {
            "<!-- image-hint: screenshots/ -->": {"mode": "hint", "value": "screenshots/"},
            "<!-- image-hint: images/presto.jpg -->": {"mode": "hint", "value": "images/presto.jpg"},
            "<!-- image-hint: demo.gif -->": {"mode": "hint", "value": "demo.gif"},
            "<!-- image: https://example.com/project.jpg -->": {"mode": "url", "value": "https://example.com/project.jpg"},
            "<!-- image: none -->": {"mode": "none"},
        }
        for directive, expected in cases.items():
            with self.subTest(directive=directive):
                self.assertEqual(self.project(f"{BASE} {directive}")["image"], expected)

    def test_directive_does_not_change_description_badges_or_identity(self) -> None:
        plain = self.project(f"{BASE} ![NEW](badges/new.svg)")
        for directive in ("<!-- image: none -->", "<!-- image-hint: shots/ -->", "<!-- image: https://e.org/a.png -->"):
            with self.subTest(directive=directive):
                project = self.project(f"{BASE} ![NEW](badges/new.svg) {directive}")
                self.assertEqual(project["id"], plain["id"])
                for key in ("description", "description_parts", "badges", "title", "url", "category"):
                    self.assertEqual(project[key], plain[key], key)
                self.assertNotIn("<!--", project["description"])
                self.assertNotIn("image", project["description"].lower().replace("an image", ""))

    def test_directive_after_badge_without_description_and_with_tight_spacing(self) -> None:
        self.assertEqual(self.project(f"- [T]({REPO}) <!-- image: none -->")["description"], "")
        self.assertEqual(self.project(f"- [T]({REPO}) ![RECENT](badges/recent.svg)<!--image:none-->")["image"], {"mode": "none"})
        self.assertEqual(self.project(f"{BASE}   <!--   image-hint:   docs/   -->   ")["image"]["value"], "docs/")
        self.assertEqual(self.project(f"{BASE} <!-- image: none -->")["description_parts"], [{"text": "A useful tool."}])

    def test_directive_is_allowed_on_entries_with_links_in_the_description(self) -> None:
        project = self.project(f"- [T]({REPO}) — See the [docs](https://example.org/docs). <!-- image: none -->")
        self.assertEqual(project["description_parts"][1], {"text": "docs", "url": "https://example.org/docs"})
        self.assertEqual(project["image"], {"mode": "none"})

    def test_image_url_is_validated_like_other_urls_and_canonicalised(self) -> None:
        self.assertEqual(
            self.project(f"{BASE} <!-- image: HTTPS://Example.COM:443/a%2fb.JPG?x=1#frag -->")["image"]["value"],
            "https://example.com/a%2Fb.JPG?x=1",
        )

    def test_hint_is_allowed_on_tree_directory_links(self) -> None:
        project = self.project(f"- [T]({REPO}/tree/main/examples/x) — d <!-- image-hint: shots/ -->")
        self.assertEqual(project["image"], {"mode": "hint", "value": "shots/"})

    def test_hint_may_contain_inner_spaces_and_unicode_letters(self) -> None:
        self.assertEqual(self.project(f"{BASE} <!-- image-hint: My Photos/été.png -->")["image"]["value"], "My Photos/été.png")


class DirectiveErrorTests(CatalogTestCase):
    def invalid(self, line: str, pattern: str) -> CatalogError:
        error = self.assertInvalid(readme_with(line), pattern)
        self.assertIsNotNone(error.line)
        return error

    def test_unknown_malformed_and_empty_directives(self) -> None:
        cases = {
            "<!-- images: none -->": "unknown directive `images`",
            "<!-- Image: none -->": "unknown directive `Image`",
            "<!-- note -->": "unrecognized HTML comment",
            "<!-- -->": "unrecognized HTML comment",
            "<!-- image none -->": "unrecognized HTML comment",
            "<!-- image: -->": "needs a value",
            "<!-- image-hint: -->": "needs a path",
            "<!-- image: None -->": "lower case",
            "<!-- image: NONE -->": "lower case",
            "<!-- image: none": "unterminated HTML comment",
            "<!-- image: none ->": "unterminated HTML comment",
        }
        for directive, pattern in cases.items():
            with self.subTest(directive=directive):
                self.invalid(f"{BASE} {directive}", pattern)

    def test_duplicate_and_conflicting_directives(self) -> None:
        self.invalid(f"{BASE} <!-- image: none --> <!-- image: none -->", "duplicate `image` directive")
        self.invalid(f"{BASE} <!-- image-hint: a/ --><!-- image-hint: b/ -->", "duplicate `image-hint` directive")
        self.invalid(f"{BASE} <!-- image: https://e.org/a.png --> <!-- image: none -->", "duplicate `image` directive")
        self.invalid(f"{BASE} <!-- image-hint: a/ --> <!-- image: none -->", "conflicting image directives")
        self.invalid(f"{BASE} <!-- image: none --> <!-- image-hint: a/ -->", "conflicting image directives")

    def test_unsupported_image_url_schemes_and_forms(self) -> None:
        cases = {
            "http://example.org/a.png": "only https",
            "ftp://example.org/a.png": "`ftp:` URLs",
            "javascript:alert(1)": "`javascript:` URLs",
            "data:image/png;base64,AAAA": "`data:` URLs",
            "file:///etc/passwd": "`file:` URLs",
            "//example.org/a.png": "not an absolute URL",
            "images/a.png": "not an absolute URL",
            "example.org/a.png": "not an absolute URL",
            "https://user:pw@example.org/a.png": "credentials",
            "https://example.org/a b.png": "whitespace",
            "https://example.org/a\\b.png": "backslash",
            "https://example.org/%zz.png": "invalid percent escape",
            "https:///a.png": "host",
        }
        for value, pattern in cases.items():
            with self.subTest(value=value):
                self.invalid(f"{BASE} <!-- image: {value} -->", pattern)

    def test_unsafe_or_ambiguous_hints(self) -> None:
        cases = {
            "../secret/": "unsafe",
            "a/../b/": "unsafe",
            "..": "unsafe",
            "a/./b/": "unsafe",
            "a//b/": "unsafe",
            "./a/": "unsafe",
            "/etc/": "leading `/`",
            "C:\\x\\": "not a URL",
            "a\\b/": "unsupported character",
            "a%2e%2e/": "unsupported character",
            "a?x=1/": "unsupported character",
            "a#b/": "unsupported character",
            "a;b/": "unsupported character",
            "a|b/": "unsupported character",
            "https://example.org/a.png": "not a URL",
            "javascript:alert(1)": "not a URL",
            "//example.org/a/": "not a URL",
            "shots": "ambiguous",
            "docs/readme.txt": "ambiguous",
            "a/b/c/d/e/f/g/": "more than 6 path segments",
            "x" * 201 + "/": "longer than 200",
            " lead/": None,
        }
        for value, pattern in cases.items():
            if pattern is None:
                continue
            with self.subTest(value=value):
                self.invalid(f"{BASE} <!-- image-hint: {value} -->", pattern)

    def test_hint_requires_a_github_project(self) -> None:
        self.invalid("- [T](https://example.org/t) — d <!-- image-hint: shots/ -->", "only applies to GitHub")

    def test_error_names_the_line_of_the_entry(self) -> None:
        text = readme_with(entry("Good", "https://example.org/good", "ok"), f"{BASE} <!-- image: nope -->")
        error = self.assertInvalid(text, "only https URLs")
        self.assertEqual(text.splitlines()[error.line - 1], f"{BASE} <!-- image: nope -->")


class DirectivePlacementTests(CatalogTestCase):
    """Comments in unusual positions: only a trailing image directive is accepted."""

    def invalid(self, line: str, pattern: str) -> None:
        self.assertInvalid(readme_with(line), pattern)

    def test_comment_must_be_the_last_thing_on_the_line(self) -> None:
        placement = "raw HTML comments are not supported except as the image directive at the very end"
        self.invalid(f"- [T]({REPO}) — a <!-- image: none --> b", placement)
        self.invalid(f"{BASE} <!-- image: none --> ![NEW](badges/new.svg)", placement)
        self.invalid(f"- [T]({REPO}) <!-- image: none --> — description", placement)
        self.invalid(f"- [T]({REPO}) — a [docs](https://e.org/<!-- image: none -->)", placement)
        self.invalid(f"- [T]({REPO}) — [docs <!-- image: none -->](https://e.org/d)", placement)

    def test_comment_inside_title_or_destination_is_still_rejected(self) -> None:
        self.assertInvalid(readme_with(f"- [T <!-- image: none -->]({REPO}) — d"), "raw HTML")

    def test_escaped_comment_is_literal_description_text(self) -> None:
        project = parse_readme(readme_with(f"- [T]({REPO}) — shows \\<!-- image: none --> literally"))["projects"][0]
        self.assertEqual(project["description"], "shows <!-- image: none --> literally")
        self.assertNotIn("image", project)

    def test_directive_only_counts_inside_the_catalog(self) -> None:
        # A fenced example outside the markers is ordinary README content.
        before = "```markdown\n- [Example](https://github.com/o/r) — d <!-- image: none -->\n```\n"
        catalog = parse_readme(build_readme([("Alpha", [BASE])], before=before))
        self.assertEqual(len(catalog["projects"]), 1)
        # An unfenced entry outside the markers is still rejected, directive or not.
        self.assertInvalid(
            build_readme([("Alpha", [BASE])], after=f"- [Other]({REPO}2) — d <!-- image: none -->\n"),
            "project entry is outside",
        )

    def test_plain_html_comments_elsewhere_in_the_readme_are_unaffected(self) -> None:
        text = build_readme([("Alpha", [BASE])], before="<!-- a note for editors -->\n\nIntro <!-- inline -->.\n")
        self.assertEqual(len(parse_readme(text)["projects"]), 1)


class DirectiveIdentityTests(CatalogTestCase):
    def test_ids_do_not_depend_on_directives_and_additions_and_removals_are_readme_only(self) -> None:
        plain = parse_readme(sample_readme())
        ids = project_ids(plain)
        with_directives = replace_once(
            sample_readme(), "- [Three](https://github.com/owner/three) — third ![NEW](badges/new.svg)",
            "- [Three](https://github.com/owner/three) — third ![NEW](badges/new.svg) <!-- image-hint: docs/ -->",
        )
        with_directives = replace_once(
            with_directives, "- [One](https://example.org/one) — first",
            "- [One](https://example.org/one) — first <!-- image: https://example.org/one.png -->",
        )
        directed = parse_readme(with_directives)
        self.assertEqual(project_ids(directed), ids)
        self.assertEqual([p["description"] for p in directed["projects"]], [p["description"] for p in plain["projects"]])

        added = replace_once(
            with_directives, "### Beta\n",
            "### Beta\n\n- [Fresh](https://github.com/owner/fresh) — new <!-- image: none -->",
        )
        after_add = parse_readme(added)
        self.assertEqual(len(after_add["projects"]), 4)
        self.assertTrue(ids.items() <= project_ids(after_add).items())
        self.assertEqual([p for p in after_add["projects"] if p["title"] == "Fresh"][0]["image"], {"mode": "none"})

        removed = replace_once(added, "- [Fresh](https://github.com/owner/fresh) — new <!-- image: none -->\n", "")
        self.assertEqual(project_ids(parse_readme(removed)), project_ids(directed))

    def test_changing_or_removing_a_directive_keeps_the_same_project_id(self) -> None:
        ids = set()
        for directive in ("", " <!-- image: none -->", " <!-- image-hint: a/ -->", " <!-- image: https://e.org/a.png -->"):
            ids.add(parse_readme(readme_with(BASE + directive))["projects"][0]["id"])
        self.assertEqual(len(ids), 1)

    def test_output_is_deterministic_with_directives(self) -> None:
        text = readme_with(f"{BASE} <!-- image: none -->")
        self.assertEqual(parse_readme(text), parse_readme(text))

    def test_schema_version_is_unchanged_and_generator_version_marks_the_extension(self) -> None:
        catalog = parse_readme(sample_readme())
        self.assertEqual(catalog["schema_version"], 1)
        self.assertEqual(catalog["generator_version"], "1.2.0")


class DocumentationExampleTests(CatalogTestCase):
    """The copyable examples in the docs and the pull request template must be accepted by the parser."""

    DOCUMENTS = (
        ROOT / "CONTRIBUTING.md",
        ROOT / ".github" / "PULL_REQUEST_TEMPLATE.md",
    )

    def examples(self, path: Path) -> list[str]:
        text = path.read_text(encoding="utf-8")
        return [line.strip() for line in text.splitlines() if line.strip().startswith("- [Project](")]

    def test_every_documented_entry_example_parses(self) -> None:
        for path in self.DOCUMENTS:
            found = self.examples(path)
            self.assertGreaterEqual(len(found), 3, f"{path.name} should show the directive examples")
            for line in found:
                with self.subTest(document=path.name, example=line):
                    readme = build_readme([("Alpha", [line])])
                    self.assertEqual(len(parse_readme(readme)["projects"]), 1)

    def test_documents_show_all_three_directive_forms_consistently(self) -> None:
        forms = ("<!-- image-hint: screenshots/ -->", "<!-- image: https://example.com/photo.jpg -->", "<!-- image: none -->")
        for path in self.DOCUMENTS:
            text = path.read_text(encoding="utf-8")
            for form in forms:
                with self.subTest(document=path.name, form=form):
                    self.assertIn(form, text)

    def test_pull_request_template_covers_the_required_topics(self) -> None:
        template = (ROOT / ".github" / "PULL_REQUEST_TEMPLATE.md").read_text(encoding="utf-8")
        for needle in ("README.md", "Adding a project", "image-hint", "image: none", "Checklist", "relevant", "duplicate"):
            self.assertIn(needle, template)
        self.assertNotIn("unittest", template)  # contributors are not asked to run the suites


class DirectiveCliTests(unittest.TestCase):
    def run_cli(self, text: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            readme = Path(directory) / "README.md"
            readme.write_text(text, encoding="utf-8", newline="")
            return subprocess.run(
                [sys.executable, str(ROOT / "tools" / "readme_catalog.py"), "--readme", str(readme), *arguments],
                cwd=directory, capture_output=True, text=True, encoding="utf-8", check=False,
            )

    def test_bad_directive_fails_with_a_github_annotation_naming_the_line(self) -> None:
        text = readme_with(f"{BASE} <!-- image: http://example.org/a.png -->")
        result = self.run_cli(text, "--format", "github", "--output", "out.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stdout + result.stderr, r"::error file=.*line=\d+.*only https URLs")

    def test_good_directive_exports_image_metadata(self) -> None:
        text = readme_with(f"{BASE} <!-- image-hint: screenshots/ -->")
        result = self.run_cli(text, "--format", "text", "--output", "out.json")
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
