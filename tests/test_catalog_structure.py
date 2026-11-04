"""Catalog boundaries, dynamic categories, and handling of content outside the markers."""

from __future__ import annotations

import unittest

from support import (
    END,
    START,
    CatalogTestCase,
    build_readme,
    catalog_region,
    entry,
    project_ids,
    replace_once,
    sample_readme,
)


class DynamicCategoryTests(CatalogTestCase):
    def test_categories_are_discovered_in_readme_order_with_slugs(self) -> None:
        catalog = self.parse(sample_readme())
        self.assertEqual(catalog["categories"], [{"slug": "alpha", "name": "Alpha"}, {"slug": "beta", "name": "Beta"}])
        self.assertEqual(
            [(p["category"], p["category_slug"], p["title"]) for p in catalog["projects"]],
            [("Alpha", "alpha", "One"), ("Alpha", "alpha", "Two"), ("Beta", "beta", "Three")],
        )

    def test_any_category_names_and_counts_are_accepted(self) -> None:
        names = ["Hardware Mods", "C#", "Café & Bar", "日本語 Projects", "Q&A: What's New?", "100% Open"]
        text = build_readme([(name, [entry(f"P{i}", f"https://example.org/{i}")]) for i, name in enumerate(names)])
        catalog = self.parse(text)
        self.assertEqual([c["name"] for c in catalog["categories"]], names)
        self.assertEqual(len({c["slug"] for c in catalog["categories"]}), len(names))
        self.assertEqual(catalog["categories"][1]["slug"], "c")
        self.assertEqual(catalog["categories"][2]["slug"], "café-bar")

        single = self.parse(build_readme([("Only", [entry()])]))
        self.assertEqual(len(single["categories"]), 1)
        many = self.parse(
            build_readme([(f"Category {i}", [entry(f"P{i}", f"https://example.org/{i}")]) for i in range(40)])
        )
        self.assertEqual(len(many["categories"]), 40)
        self.assertEqual(len(many["projects"]), 40)

    def test_add_rename_remove_and_reorder_categories_by_editing_only_the_readme(self) -> None:
        base = sample_readme()
        original = self.parse(base)

        added = replace_once(base, END, "### Gamma\n\n" + entry("Four", "https://example.org/four") + "\n\n" + END)
        added_catalog = self.parse(added)
        self.assertEqual([c["name"] for c in added_catalog["categories"]], ["Alpha", "Beta", "Gamma"])
        self.assertEqual(len(added_catalog["projects"]), len(original["projects"]) + 1)

        renamed = self.parse(replace_once(base, "### Beta", "### Beta Renamed"))
        self.assertEqual([c["slug"] for c in renamed["categories"]], ["alpha", "beta-renamed"])
        self.assertEqual(project_ids(renamed), project_ids(original))

        removed = self.parse(replace_once(base, "### Beta\n\n" + entry("Three", "https://github.com/owner/three", "third", "NEW") + "\n", ""))
        self.assertEqual([c["name"] for c in removed["categories"]], ["Alpha"])
        self.assertEqual(len(removed["projects"]), 2)

        beta_first = build_readme(
            [
                ("Beta", [entry("Three", "https://github.com/owner/three", "third", "NEW")]),
                ("Alpha", [entry("One", "https://example.org/one", "first"), entry("Two", "https://example.org/two")]),
            ]
        )
        reordered = self.parse(beta_first)
        self.assertEqual([c["name"] for c in reordered["categories"]], ["Beta", "Alpha"])
        self.assertEqual({p["id"] for p in reordered["projects"]}, {p["id"] for p in original["projects"]})

    def test_empty_category_is_kept_in_the_category_list(self) -> None:
        catalog = self.parse(build_readme([("Full", [entry()]), ("Empty", [])]))
        self.assertEqual([c["name"] for c in catalog["categories"]], ["Full", "Empty"])
        self.assertEqual({p["category"] for p in catalog["projects"]}, {"Full"})

    def test_heading_closing_sequence_follows_commonmark(self) -> None:
        catalog = self.parse(build_readme([("C#", [entry()])]).replace("### C#", "### Games ###", 1))
        self.assertEqual(catalog["categories"][0]["name"], "Games")
        catalog = self.parse(build_readme([("C#", [entry()])]))
        self.assertEqual(catalog["categories"][0]["name"], "C#")

    def test_category_errors(self) -> None:
        duplicate = build_readme([("Same", [entry("A", "https://example.org/a")]), ("Same", [entry("B", "https://example.org/b")])])
        self.assertInvalid(duplicate, "duplicate catalog category `Same`")
        collision = build_readme([("Games!", [entry("A", "https://example.org/a")]), ("Games?", [entry("B", "https://example.org/b")])])
        self.assertInvalid(collision, "produce the same slug `games`")
        self.assertInvalid(build_readme([("!!!", [entry()])]), "must contain a letter or digit")
        self.assertInvalid(build_readme([("   ", [entry()])]).replace("###    ", "###", 1), "category name must not be empty")
        self.assertInvalid(build_readme([("X" * 121, [entry()])]), "category name is longer than")
        self.assertInvalid(build_readme([("<b>Bold</b>", [entry()])]), "raw HTML")
        self.assertInvalid(build_readme([("[Linked](https://example.org)", [entry()])]), "links are not supported in category headings")

    def test_catalog_must_contain_categories_and_projects(self) -> None:
        self.assertInvalid(f"# T\n\n{START}\n\n{END}\n", "no `### Category` headings")
        self.assertInvalid(build_readme([("Empty", [])]), "no project entries")
        self.assertInvalid(
            f"{START}\n\n{entry()}\n\n### Late\n\n{entry('B', 'https://example.org/b')}\n{END}\n",
            "must follow a `### Category` heading",
            line=3,
        )

    def test_headings_inside_the_catalog_must_be_category_level(self) -> None:
        for marker in ("##", "####", "#"):
            with self.subTest(marker=marker):
                text = replace_once(sample_readme(), "### Beta", f"{marker} Beta")
                self.assertInvalid(text, "only `###` category headings are allowed")

    def test_contents_list_is_not_required_or_validated(self) -> None:
        for contents in (True, False):
            with self.subTest(contents=contents):
                catalog = self.parse(build_readme([("Brand New", [entry()])], contents=contents))
                self.assertEqual(catalog["categories"][0]["name"], "Brand New")

    def test_heading_and_bullet_whitespace_variants_are_supported(self) -> None:
        text = (
            f"{START}\n\n###\tTabbed Name ###  \n\n-\t[One](https://example.org/one)\t—  first   \n"
            "*   [Two](https://example.org/two)\n###   Spaced   \n+ [Three](https://example.org/three) ![NEW](badges/new.svg)\n\n"
            f"{END}\n"
        )
        catalog = self.parse(text)
        self.assertEqual([c["name"] for c in catalog["categories"]], ["Tabbed Name", "Spaced"])
        self.assertEqual([p["title"] for p in catalog["projects"]], ["One", "Two", "Three"])
        self.assertEqual(catalog["projects"][0]["description"], "first")

    def test_minimal_catalog_is_one_category_with_one_project(self) -> None:
        catalog = self.parse(f"{START}\n### Only\n- [Solo](https://example.org/solo)\n{END}")
        self.assertEqual(len(catalog["categories"]), 1)
        self.assertEqual(len(catalog["projects"]), 1)


class MarkerTests(CatalogTestCase):
    def test_missing_or_misordered_markers_are_reported(self) -> None:
        no_markers = sample_readme().replace(START + "\n", "", 1).replace(END + "\n", "", 1)
        self.assertInvalid(no_markers, "could not find `<!-- catalog:start -->`")
        self.assertInvalid(sample_readme().replace(START + "\n", "", 1), "appears before `<!-- catalog:start -->`")
        self.assertInvalid(sample_readme().replace(END + "\n", "", 1), "has no matching `<!-- catalog:end -->`")
        swapped = replace_once(replace_once(sample_readme(), START, "@@"), END, START).replace("@@", END)
        self.assertInvalid(swapped, "appears before `<!-- catalog:start -->`")
        self.assertInvalid(replace_once(sample_readme(), "### Beta", START + "\n\n### Beta"), "found `<!-- catalog:start -->` again")
        two_regions = sample_readme() + "\n" + START + "\n### X\n- [A](https://example.org/x)\n" + END + "\n"
        self.assertInvalid(two_regions, "only one catalog region is supported")
        self.assertInvalid(sample_readme() + "\n" + END + "\n", "only one catalog region is supported")

    def test_marker_whitespace_is_tolerated_and_fenced_examples_are_ignored(self) -> None:
        loose = sample_readme().replace(START, "<!--catalog:start-->").replace(END, "<!--   catalog:end   -->")
        self.assertEqual(len(self.parse(loose)["projects"]), 3)
        fenced_example = "```markdown\n" + START + "\n- [Fake](https://example.org/fake)\n" + END + "\n```\n\n"
        text = fenced_example + sample_readme()
        catalog = self.parse(text)
        self.assertEqual(len(catalog["projects"]), 3)

    def test_line_numbers_match_github_for_crlf_cr_and_bom_files(self) -> None:
        text = replace_once(sample_readme(), entry("Two", "https://example.org/two"), "- [Two](not-a-url)")
        expected_line = text.split("\n").index("- [Two](not-a-url)") + 1
        for variant in (text, text.replace("\n", "\r\n"), chr(0xFEFF) + text, text.replace("\n", "\r")):
            with self.subTest(variant=repr(variant[:12])):
                self.assertInvalid(variant, "must use http or https", line=expected_line)


class UnsupportedContentTests(CatalogTestCase):
    def mutate_entry(self, replacement: str) -> str:
        return replace_once(sample_readme(), entry("Two", "https://example.org/two"), replacement)

    def test_content_that_could_be_silently_lost_is_rejected(self) -> None:
        wrapped = entry("Two", "https://example.org/two", "first line") + "\n  wrapped description"
        cases = {
            "wrapped description": (wrapped, "unsupported content in the catalog"),
            "lazy continuation": (wrapped.replace("\n  ", "\n"), "unsupported content in the catalog"),
            "nested list": ("  " + entry("Two", "https://example.org/two"), "indented/nested list items"),
            "html comment": ("<!-- note -->", "unsupported content in the catalog"),
            "blockquote": ("> quote", "unsupported content in the catalog"),
            "prose": ("Intro sentence.", "unsupported content in the catalog"),
            "fence": ("```\ncode\n```", "unsupported content in the catalog"),
            "table": ("| a | b |", "unsupported content in the catalog"),
            "numbered": ("1. [Two](https://example.org/two)", "numbered lists are not supported"),
            "horizontal rule": ("---", "horizontal rules"),
            "star rule": ("***", "horizontal rules"),
            "setext underline": ("=====", "Setext"),
            "setext heading": ("Games\n-----", "Setext headings are unsupported"),
            "indented heading": ("  ### Games", "indented headings are unsupported"),
        }
        for name, (replacement, message) in cases.items():
            with self.subTest(name=name):
                self.assertInvalid(self.mutate_entry(replacement), message)

    def test_blank_and_whitespace_only_lines_are_ignored(self) -> None:
        text = replace_once(sample_readme(), entry("One", "https://example.org/one", "first"), "\n   \n\t\n" + entry("One", "https://example.org/one", "first"))
        self.assertEqual(len(self.parse(text)["projects"]), 3)




class FenceTests(CatalogTestCase):
    """CommonMark fenced-code rules decide which markers and entries are only examples."""

    EXAMPLE = (
        START + "\n### Example A\n\n- [Ex1](https://example.org/ex1)\n- [Ex2](https://example.org/ex2)\n"
        "### Example B\n\n- [Ex3](https://example.org/ex3)\n" + END + "\n"
    )

    def assertRealCatalog(self, text: str) -> None:
        catalog = self.parse(text)
        self.assertEqual([p["title"] for p in catalog["projects"]], ["One", "Two", "Three"], "example catalog was used")
        self.assertEqual([c["name"] for c in catalog["categories"]], ["Alpha", "Beta"])

    def test_indented_fence_line_inside_an_example_does_not_close_it(self) -> None:
        # Codex H1 reconstruction: an example (containing a four-space-indented fence line) precedes the
        # real README, and another fence line follows it. Only the real catalog may be published.
        text = "```markdown\n    ```\n" + self.EXAMPLE + "```\n\n" + sample_readme() + "```\n"
        self.assertRealCatalog(text)

    def test_backtick_fence_info_string_cannot_contain_backticks(self) -> None:
        self.assertRealCatalog("```not a fence``` here\n\n" + sample_readme())
        self.assertRealCatalog("``` js `x`\n\n" + sample_readme())
        self.assertRealCatalog("~~~ js `x`\n" + self.EXAMPLE + "~~~\n\n" + sample_readme())  # tilde info may contain backticks

    def test_closing_fences_follow_commonmark(self) -> None:
        cases = {
            "trailing text does not close": "```\n``` text\n" + self.EXAMPLE + "```\n\n",
            "shorter fence does not close": "````markdown\n```\n" + self.EXAMPLE + "```\n````\n\n",
            "other character does not close": "~~~\n```\n" + self.EXAMPLE + "```\n~~~\n\n",
            "four-space indent does not close": "```\n    ```\n" + self.EXAMPLE + "```\n\n",
            "tab indent does not close": "```\n\t```\n" + self.EXAMPLE + "```\n\n",
            "longer fence closes": "```\n" + self.EXAMPLE + "`````\n\n",
            "three-space indent closes": "```\n" + self.EXAMPLE + "   ```   \n\n",
            "indented opener": "   ```markdown\n" + self.EXAMPLE + "   ```\n\n",
            "fence inside a list item": "- item\n  ```markdown\n  " + START + "\n  - [Fake](https://example.org/fake)\n  " + END + "\n  ```\n\n",
        }
        for name, example in cases.items():
            with self.subTest(name=name):
                self.assertRealCatalog(example + sample_readme())

    def test_four_space_indented_backticks_are_not_a_fence(self) -> None:
        self.assertRealCatalog("    ```\n\n" + sample_readme())

    def test_unclosed_fence_runs_to_the_end_of_the_document(self) -> None:
        self.assertInvalid("```markdown\n" + sample_readme(), "could not find `<!-- catalog:start -->`")
        self.assertRealCatalog(sample_readme() + "\n```markdown\n- [Fake](https://example.org/fake)\n")

    def test_entries_in_fences_outside_the_catalog_are_examples_not_lost_projects(self) -> None:
        after = "```markdown\n- [Example](https://example.org/example) — shown ![NEW](badges/new.svg)\n```\n\n~~~\n1. [Example](https://example.org/e2)\n~~~\n"
        self.assertEqual(len(self.parse(build_readme([("Alpha", [entry()])], after=after))["projects"]), 1)

    def test_locate_catalog_ignores_fenced_markers(self) -> None:
        text = "```\n" + self.EXAMPLE + "```\n\n" + sample_readme()
        lines = text.split("\n")
        start, end = catalog_region(lines)
        self.assertEqual((lines[start], lines[end]), (START, END))
        self.assertGreater(start, len(self.EXAMPLE.split("\n")))


class OutsideCatalogTests(CatalogTestCase):
    """Project-shaped list items outside the markers fail closed; other content is left alone."""

    def with_outside(self, outside: str) -> str:
        return build_readme([("Alpha", [entry()])], after="### Hardware Mods\n\n" + outside + "\n\n")

    def test_ordinary_content_outside_the_catalog_is_valid(self) -> None:
        outside = (
            "See [the docs](https://example.org/docs) and [source](https://github.com/owner/repo).\n\n"
            "- [Relative guide](CONTRIBUTING.md)\n- [Anchor](#about)\n- [Mail](mailto:someone@example.org)\n"
            "- Docs: [site](https://example.org/x)\n- Plain bullet about [a site](https://example.org/y) text\n"
            "1. Numbered with [a link](https://example.org/z)\n\n"
            "> A quote with [a link](https://example.org/quote)\n> - [Quoted entry](https://example.org/q)\n\n"
            "| Table | Link |\n|---|---|\n| a | [b](https://example.org/b) |\n\n"
            "    - [Entry in an indented code block](https://example.org/code)\n\n"
            "<p><a href=\"https://example.org/html\">html link</a></p>\n\n"
            "```markdown\n- [Example Project](https://example.org/example) — in a fence ![NEW](badges/new.svg)\n```\n\n"
            "- Literal \\![NEW](badges/new.svg) is escaped, not a badge\n"
        )
        catalog = self.parse(self.with_outside(outside))
        self.assertEqual(len(catalog["projects"]), 1)

    def test_project_shaped_items_outside_the_catalog_are_errors(self) -> None:
        cases = {
            "bare bullet": "- [Omitted](https://example.org/omitted)",
            "star bullet": "* [Omitted](https://example.org/omitted) — d",
            "plus bullet": "+ [Omitted](https://example.org/omitted)",
            "one-space indent": " - [Omitted](https://example.org/omitted)",
            "two-space indent (Codex M1)": "  - [Omitted](https://example.org/review-indented) — should diagnose",
            "three-space indent": "   - [Omitted](https://example.org/omitted)",
            "numbered dot": "1. [Omitted](https://example.org/omitted)",
            "numbered paren": "2) [Omitted](https://example.org/omitted)",
            "uppercase scheme": "- [Omitted](HTTPS://example.org/omitted)",
            "http scheme": "- [Omitted](http://example.org/omitted)",
            "space before URL": "- [Omitted]( https://example.org/omitted)",
            "with description and badge": "- [Omitted](https://example.org/omitted) — d ![RECENT](badges/recent.svg)",
            "nested under a bullet": "- Related\n    - [Omitted](https://example.org/omitted)",
            "nested under a numbered item": "1. Related\n   - [Omitted](https://example.org/omitted)",
            "after blank line inside a list": "- Related\n\n    - [Omitted](https://example.org/omitted)",
        }
        for name, outside in cases.items():
            with self.subTest(name=name):
                text = self.with_outside(outside)
                lines = text.split("\n")
                error = self.assertInvalid(text, "project entry is outside")
                self.assertIn("Omitted", lines[error.line - 1])

    def test_indented_code_is_only_code_outside_a_list(self) -> None:
        code = "Paragraph.\n\n    - [Code](https://example.org/code)"
        self.assertEqual(len(self.parse(self.with_outside(code))["projects"]), 1)
        in_list = "- Item\n\n    - [Nested](https://example.org/nested)"
        self.assertInvalid(self.with_outside(in_list), "project entry is outside")
        # a paragraph ends the list, so indented lines after it are code again
        after_paragraph = "- Item\n\nParagraph.\n\n    - [Code](https://example.org/code)"
        self.assertEqual(len(self.parse(self.with_outside(after_paragraph))["projects"]), 1)

    def test_entries_touching_a_marker_are_errors(self) -> None:
        bare = entry("Stray", "https://example.org/stray")
        after_end = build_readme([("Alpha", [entry()])]).replace(END + "\n", END + "\n\n" + bare + "\n", 1)
        self.assertInvalid(after_end, "project entry is outside")
        before_start = build_readme([("Alpha", [entry()])]).replace(START, bare + "\n\n" + START, 1)
        self.assertInvalid(before_start, "project entry is outside")
        in_contents = build_readme([("Alpha", [entry()])]).replace("- [Anything](#anything)", bare, 1)
        self.assertInvalid(in_contents, "project entry is outside")

    def test_catalog_badges_on_list_items_outside_the_catalog_are_errors(self) -> None:
        for outside in (
            entry("Elsewhere", "https://example.org/elsewhere", "x", "RECENT"),
            "- Text-led bullet ![NEW](badges/new.svg)",
            "- Text-led bullet ![new](BADGES/NEW.svg)",
        ):
            with self.subTest(outside=outside):
                self.assertInvalid(self.with_outside(outside), "project entry is outside|NEW/RECENT badge is outside")

    def test_no_diagnostics_depend_on_the_surrounding_headings(self) -> None:
        # the same misplaced entry is rejected under any heading, in any position after the catalog
        for heading in ("## Notes", "#### Deep", "Setext\n------", ""):
            with self.subTest(heading=heading):
                text = build_readme([("Alpha", [entry()])], after=heading + "\n\n- [Lost](https://example.org/lost)\n\n")
                self.assertInvalid(text, "project entry is outside")


if __name__ == "__main__":
    unittest.main()
