"""Validation of the live README, independent of its current content.

Nothing here names a specific project, title, URL, category, count, or badge
state. The live README is checked against invariants, and README-only
contribution scenarios are applied to it structurally (in memory), so ordinary
edits such as adding, renaming, reordering, or removing entries, or rotating
badges, never require test changes.

The scenarios derive everything from the supported grammar (not from today's
wording), pick collision-free names, and skip operations whose preconditions are
absent (for example, removing a category from a one-category catalog). They also
run against synthetic catalogs with a minimal shape, colliding names, and
tab-separated syntax, so a future live README of any valid shape is covered.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import unittest
from pathlib import Path

from support import (
    END,
    FIXTURES,
    ROOT,
    START,
    CatalogError,
    CatalogTestCase,
    build_readme,
    catalog_region,
    entry,
    normalize_url,
    parse_readme,
    project_ids,
    readme_catalog,
    render_catalog,
)

README_PATH = Path(os.environ.get("PRESTO_README_PATH", ROOT / "README.md"))
TOP_LEVEL_KEYS = {"schema_version", "generator_version", "identity_version", "categories", "projects"}
PROJECT_KEYS = {"id", "category", "category_slug", "title", "url", "description", "description_parts", "badges"}


class LiveReadmeInvariantTests(CatalogTestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = README_PATH.read_text(encoding="utf-8")
        cls.catalog = parse_readme(cls.text)

    def test_top_level_schema(self) -> None:
        catalog = self.catalog
        self.assertEqual(set(catalog), TOP_LEVEL_KEYS)
        self.assertEqual(catalog["schema_version"], 1)
        self.assertRegex(catalog["generator_version"], r"^\d+\.\d+\.\d+$")
        self.assertEqual(catalog["identity_version"], 1)
        self.assertGreaterEqual(len(catalog["categories"]), 1)
        self.assertGreaterEqual(len(catalog["projects"]), 1)

    def test_categories_are_well_formed_and_unique(self) -> None:
        categories = self.catalog["categories"]
        for category in categories:
            self.assertEqual(set(category), {"slug", "name"})
            self.assertTrue(category["name"].strip() and category["slug"])
            self.assertRegex(category["slug"], r"^[\w-]+$")
        self.assertEqual(len({c["name"] for c in categories}), len(categories))
        self.assertEqual(len({c["slug"] for c in categories}), len(categories))

    def test_projects_are_well_formed_unique_and_in_readme_order(self) -> None:
        categories = {c["name"]: (index, c["slug"]) for index, c in enumerate(self.catalog["categories"])}
        projects = self.catalog["projects"]
        last_category_index = 0
        for project in projects:
            with self.subTest(url=project["url"]):
                self.assertEqual(set(project), PROJECT_KEYS)
                for field in ("id", "category", "category_slug", "title", "url", "description"):
                    self.assertIsInstance(project[field], str)
                self.assertIsInstance(project["description_parts"], list)
                self.assertIsInstance(project["badges"], list)
                self.assertRegex(project["id"], r"^presto_[0-9a-f]{64}$")
                self.assertEqual(
                    project["id"], "presto_" + hashlib.sha256(project["url"].encode("utf-8")).hexdigest()
                )
                self.assertRegex(project["url"], r"^https?://")
                self.assertEqual(normalize_url(project["url"]), project["url"], "URL must be canonical")
                self.assertTrue(project["title"].strip())
                self.assertLessEqual(len(project["badges"]), 1)
                self.assertTrue(set(project["badges"]) <= set(readme_catalog.BADGES))
                index, slug = categories[project["category"]]
                self.assertEqual(project["category_slug"], slug)
                self.assertGreaterEqual(index, last_category_index, "projects must follow category order")
                last_category_index = index
                self.assertEqual(project["description"], "".join(p["text"] for p in project["description_parts"]))
                for part in project["description_parts"]:
                    self.assertTrue(part["text"])
                    self.assertLessEqual(set(part), {"text", "url"})
                    if "url" in part:
                        self.assertRegex(part["url"], r"^https?://")
        for field in ("id", "url"):
            values = [project[field] for project in projects]
            self.assertEqual(len(values), len(set(values)), f"duplicate project {field}")

    def test_serialization_is_deterministic_and_round_trips(self) -> None:
        rendered = render_catalog(self.catalog)
        self.assertEqual(rendered, render_catalog(parse_readme(self.text)))
        self.assertEqual(json.loads(rendered), self.catalog)
        self.assertTrue(rendered.endswith("\n"))

    def test_catalog_badge_assets_exist(self) -> None:
        for badge in {badge for project in self.catalog["projects"] for badge in project["badges"]}:
            with self.subTest(badge=badge):
                self.assertTrue((ROOT / readme_catalog.BADGES[badge]).is_file())


def _slug(name: str) -> str:
    return re.sub(r"[^\w]+", "-", name.casefold()).strip("-_")


class ReadmeOnlyScenarios:
    """README-only contribution scenarios, derived from the supported grammar.

    Subclasses provide ``readme_text()``. Mix in with ``CatalogTestCase``.
    """

    counter = 0

    @classmethod
    def readme_text(cls) -> str:
        raise NotImplementedError

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        cls.text = cls.readme_text().replace("\r\n", "\n")
        cls.original = parse_readme(cls.text)

    def setUp(self) -> None:
        self.lines = self.text.split("\n")
        self.start, self.end = catalog_region(self.lines)

    # -- grammar-derived helpers (no assumptions about names, counts, or whitespace) --------------------
    @classmethod
    def next_number(cls) -> int:
        ReadmeOnlyScenarios.counter += 1
        return ReadmeOnlyScenarios.counter

    def new_url(self) -> str:
        return f"https://example.invalid/readme-only/{self.next_number()}"

    def new_category_name(self) -> str:
        taken = {c["slug"] for c in self.original["categories"]}
        while True:
            name = f"Added Test Category {self.next_number()}"
            if _slug(name) not in taken:
                return name

    def headings(self) -> list[int]:
        return [i for i in range(self.start + 1, self.end) if re.match(r"^###(?:[ \t]|$)", self.lines[i])]

    def project_lines(self) -> list[int]:
        return [
            i
            for i in range(self.start + 1, self.end)
            if self.lines[i].strip() and i not in set(self.headings())
        ]

    def mutated(self, lines: list[str]) -> str:
        text = "\n".join(lines)
        self.assertNotEqual(text, self.text, "mutation did not change the README")
        return text

    def insert_before_end(self, new_lines: list[str]) -> str:
        return self.mutated(self.lines[: self.end] + new_lines + self.lines[self.end :])

    # -- scenarios ----------------------------------------------------------------------------------
    def test_add_a_project_to_the_last_category(self) -> None:
        url = self.new_url()
        catalog = self.parse(self.insert_before_end([entry("Added project", url, "Added by README only."), ""]))
        self.assertEqual(len(catalog["projects"]), len(self.original["projects"]) + 1)
        added = catalog["projects"][-1]
        self.assertEqual((added["title"], added["url"]), ("Added project", url))
        self.assertEqual(added["category"], self.original["categories"][-1]["name"])
        self.assertEqual(
            {p["id"] for p in catalog["projects"]} - {added["id"]},
            {p["id"] for p in self.original["projects"]},
        )

    def test_add_a_project_without_description_or_badge(self) -> None:
        catalog = self.parse(self.insert_before_end([entry("Bare", self.new_url()), ""]))
        added = catalog["projects"][-1]
        self.assertEqual((added["description"], added["description_parts"], added["badges"]), ("", [], []))

    def test_add_a_new_category_with_projects(self) -> None:
        name = self.new_category_name()
        urls = [self.new_url(), self.new_url()]
        catalog = self.parse(
            self.insert_before_end([f"### {name}", "", entry("First", urls[0], "one"), entry("Second", urls[1]), ""])
        )
        self.assertEqual(catalog["categories"][-1]["name"], name)
        self.assertEqual(len(catalog["categories"]), len(self.original["categories"]) + 1)
        self.assertEqual([p["url"] for p in catalog["projects"][-2:]], urls)
        self.assertEqual({p["category"] for p in catalog["projects"][-2:]}, {name})

    def test_rename_a_category(self) -> None:
        name = self.new_category_name()
        lines = list(self.lines)
        lines[self.headings()[0]] = f"### {name}"
        catalog = self.parse(self.mutated(lines))
        self.assertEqual(catalog["categories"][0]["name"], name)
        self.assertEqual(project_ids(catalog), project_ids(self.original))
        self.assertEqual(len(catalog["projects"]), len(self.original["projects"]))

    def test_reorder_categories(self) -> None:
        headings = self.headings()
        if len(headings) < 2:
            self.skipTest("catalog has a single category")
        first_block = self.lines[headings[0] : headings[1]]
        rest = self.lines[headings[1] : self.end]
        lines = self.lines[: headings[0]] + rest + first_block + self.lines[self.end :]
        catalog = self.parse(self.mutated(lines))
        names = [c["name"] for c in self.original["categories"]]
        self.assertEqual([c["name"] for c in catalog["categories"]], names[1:] + names[:1])
        self.assertEqual(project_ids(catalog), project_ids(self.original))

    def test_reorder_projects_within_a_category(self) -> None:
        projects = self.project_lines()
        adjacent = [(a, b) for a, b in zip(projects, projects[1:]) if b == a + 1]
        if not adjacent:
            self.skipTest("catalog has no adjacent project lines")
        a, b = adjacent[0]
        lines = list(self.lines)
        lines[a], lines[b] = lines[b], lines[a]
        catalog = self.parse(self.mutated(lines))
        self.assertEqual(project_ids(catalog), project_ids(self.original))
        self.assertNotEqual([p["id"] for p in catalog["projects"]], [p["id"] for p in self.original["projects"]])

    def test_remove_a_project(self) -> None:
        if len(self.original["projects"]) < 2:
            self.skipTest("removing the only project would (correctly) leave an empty catalog")
        index = self.project_lines()[0]
        catalog = self.parse(self.mutated(self.lines[:index] + self.lines[index + 1 :]))
        self.assertEqual(len(catalog["projects"]), len(self.original["projects"]) - 1)
        self.assertNotIn(self.original["projects"][0]["id"], {p["id"] for p in catalog["projects"]})

    def test_remove_a_category(self) -> None:
        headings = self.headings()
        first_name = self.original["categories"][0]["name"]
        if len(headings) < 2 or all(p["category"] == first_name for p in self.original["projects"]):
            self.skipTest("no other category with projects would remain")
        catalog = self.parse(self.mutated(self.lines[: headings[0]] + self.lines[headings[1] :]))
        self.assertEqual(
            [c["name"] for c in catalog["categories"]], [c["name"] for c in self.original["categories"][1:]]
        )

    def test_edit_title_description_and_rotate_badges_keep_identity(self) -> None:
        index = self.project_lines()[0]
        first = self.original["projects"][0]
        seen_badges = []
        for badge in ("NEW", "RECENT", None):
            lines = list(self.lines)
            lines[index] = entry(f"Edited {badge}", first["url"], f"Edited description for {badge}.", badge)
            catalog = self.parse(self.mutated(lines))
            edited = catalog["projects"][0]
            seen_badges.append(edited["badges"])
            self.assertEqual(edited["id"], first["id"])
            self.assertEqual(edited["title"], f"Edited {badge}")
            self.assertEqual(edited["description"], f"Edited description for {badge}.")
        self.assertEqual(seen_badges, [["NEW"], ["RECENT"], []])

    def test_equivalent_url_duplicate_is_rejected_with_a_line_number(self) -> None:
        url = self.original["projects"][0]["url"]
        text = self.insert_before_end([entry("Duplicate", url + "#duplicate-fragment"), ""])
        with self.assertRaisesRegex(CatalogError, "duplicate canonical project URL") as context:
            parse_readme(text)
        self.assertEqual(context.exception.line, self.end + 1)

    def test_malformed_and_unsupported_additions_fail_at_the_right_line(self) -> None:
        # (message, offset of the offending line from the first added line)
        cases = {
            "- [Broken](not-a-url)": ("must use http or https", 0),
            "- Not a link": ("must begin with a primary Markdown link", 0),
            "- [Wrapped](https://example.invalid/w) — first line\n  continued": ("unsupported content", 1),
            "- [Html](https://example.invalid/h) — <b>bold</b>": ("raw HTML", 0),
            "- [Script](https://example.invalid/s) — [x](javascript:alert(1))": ("invalid link URL", 0),
            "- [Host](https://evil<host>/)": ("forbidden characters", 0),
            "- [Unicode](https://faß.de/)": ("internationalized hostnames", 0),
        }
        for addition, (message, offset) in cases.items():
            with self.subTest(addition=addition):
                text = self.insert_before_end([addition, ""])
                with self.assertRaisesRegex(CatalogError, message) as context:
                    parse_readme(text)
                self.assertEqual(context.exception.line, self.end + 1 + offset)

    def test_a_project_added_outside_the_markers_is_always_an_error(self) -> None:
        line = entry("Misplaced", self.new_url(), "after the end marker")
        # Insert next to the markers, not at the end of the file: a README may legitimately end inside
        # an unclosed code fence, where appended text would be code.
        after = self.end + 1
        variants = {
            "touching the end marker": self.lines[:after] + ["", line] + self.lines[after:],
            "under a later heading": self.lines[:after] + ["", "### Another Section", "", line, ""] + self.lines[after:],
            "indented under a later heading": self.lines[:after] + ["", "### Another Section", "", "  " + line, ""] + self.lines[after:],
            "before the start marker": self.lines[: self.start] + [line, ""] + self.lines[self.start :],
        }
        for name, lines in variants.items():
            with self.subTest(name=name), self.assertRaisesRegex(CatalogError, "project entry is outside"):
                parse_readme(self.mutated(lines))

    def test_ordinary_content_outside_the_catalog_is_untouched(self) -> None:
        after = self.end + 1
        extra = [
            "",
            "## Related",
            "",
            "See [another list](https://example.org/list) for more.",
            "",
            "- Docs: [site](https://example.org/docs)",
            "- [Guide](CONTRIBUTING.md)",
            "",
            "```markdown",
            START,
            entry("Example", "https://example.org/example"),
            END,
            "```",
            "",
        ]
        self.assertEqual(parse_readme(self.mutated(self.lines[:after] + extra + self.lines[after:])), self.original)


class LiveReadmeOnlyChangeTests(ReadmeOnlyScenarios, CatalogTestCase):
    @classmethod
    def readme_text(cls) -> str:
        return README_PATH.read_text(encoding="utf-8")


class MinimalCatalogScenarioTests(ReadmeOnlyScenarios, CatalogTestCase):
    """A catalog with one category and one project (Codex M2)."""

    @classmethod
    def readme_text(cls) -> str:
        return build_readme([("Solo", [entry("Only", "https://example.org/only")])])


class CollidingNamesScenarioTests(ReadmeOnlyScenarios, CatalogTestCase):
    """A catalog that already uses the names a naive test would add (Codex M2)."""

    @classmethod
    def readme_text(cls) -> str:
        names = ["Brand New Test Category", "Added Test Category 1", "Added Test Category 2", "Renamed Test Category"]
        return build_readme(
            [(name, [entry(f"P{i}", f"https://example.org/colliding/{i}")]) for i, name in enumerate(names)]
        )


class WhitespaceVariantScenarioTests(ReadmeOnlyScenarios, CatalogTestCase):
    """Tab-separated headings and bullets, closing hashes, and trailing spaces (Codex M2)."""

    @classmethod
    def readme_text(cls) -> str:
        return (
            f"# Title\n\n{START}\n\n###\tAlpha ###  \n\n-\t[One](https://example.org/one)\t—  first   \n"
            "*   [Two](https://example.org/two)\n###   Beta   \n+ [Three](https://example.org/three) ![NEW](badges/new.svg)\n\n"
            f"{END}\n\n### Other\n\nText.\n"
        )


class FrozenSnapshotRegressionTests(CatalogTestCase):
    """Regression for how the original README entries are represented.

    ``fixtures/snapshot_readme.md`` is a frozen copy of the README as of
    2026-11-03 and ``fixtures/baseline_projects.json`` records the expected
    entries (IDs from the reviewed v1.0.0 parser). Neither follows the live
    README; update them only when intentionally changing the catalog format.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.snapshot_text = (FIXTURES / "snapshot_readme.md").read_text(encoding="utf-8")
        cls.baseline = json.loads((FIXTURES / "baseline_projects.json").read_text(encoding="utf-8"))
        cls.catalog = parse_readme(cls.snapshot_text)

    def test_every_original_entry_is_represented_correctly_in_order(self) -> None:
        self.assertEqual(len(self.catalog["projects"]), 53)
        actual = [
            (p["category"], p["title"], p["url"], p["id"], p["badges"]) for p in self.catalog["projects"]
        ]
        expected = [
            (row["category"], row["title"], row["canonical_url"], row["id"], row["badges"]) for row in self.baseline
        ]
        self.assertEqual(actual, expected)

    def test_original_categories_and_badge_counts(self) -> None:
        self.assertEqual(
            [(c["name"], c["slug"]) for c in self.catalog["categories"]],
            [
                ("Official Resources", "official-resources"),
                ("Code Examples", "code-examples"),
                ("Development Tools", "development-tools"),
                ("Tutorials", "tutorials"),
                ("Games", "games"),
                ("Clocks", "clocks"),
                ("Weather Stations", "weather-stations"),
                ("Operating Systems", "operating-systems"),
                ("Other Projects", "other-projects"),
                ("Community & Media", "community-media"),
            ],
        )
        badges = [tuple(p["badges"]) for p in self.catalog["projects"]]
        self.assertEqual(badges.count(("NEW",)), 8)
        self.assertEqual(badges.count(("RECENT",)), 11)

    def test_description_links_and_unicode_in_real_entries(self) -> None:
        by_title = {p["title"]: p for p in self.catalog["projects"]}
        dash = by_title["Presto AI Dash"]
        self.assertEqual(
            dash["description_parts"][1], {"text": "live demo", "url": "https://presto-dash.com/demo/"}
        )
        self.assertNotIn("](", dash["description"])
        self.assertIn("CO₂", by_title["SCD41 CO₂ Monitor"]["title"])
        self.assertEqual(by_title["GitHub Releases & Firmware"]["title"], "GitHub Releases & Firmware")
        self.assertEqual(by_title["WiiM \"What's Playing\" display"]["category"], "Other Projects")

    def test_snapshot_catalog_output_is_byte_stable(self) -> None:
        # A change-detector for the serialized format, not a correctness oracle: the
        # tests above verify the content independently. Update this value only when
        # intentionally changing the output (and bump generator_version).
        digest = hashlib.sha256(render_catalog(self.catalog).encode("utf-8")).hexdigest()
        self.assertEqual(digest, "2f9ebb7e23d78112aed84d4c9f9434754d9b1088eb4b5eefc3d2372bda2e1ceb")


if __name__ == "__main__":
    unittest.main()
