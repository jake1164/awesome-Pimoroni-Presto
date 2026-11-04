"""Tests of the test helpers: guard against mutation tests that silently do nothing."""

from __future__ import annotations

import unittest

from support import build_readme, catalog_region, entry, parse_readme, replace_once, sample_readme


class ReplaceOnceTests(unittest.TestCase):
    def test_applies_exactly_one_change(self) -> None:
        self.assertEqual(replace_once("a b c", "b", "x"), "a x c")

    def test_missing_target_fails_instead_of_passing_vacuously(self) -> None:
        with self.assertRaisesRegex(AssertionError, "occurs 0 times"):
            replace_once("a b c", "z", "x")

    def test_ambiguous_target_fails(self) -> None:
        with self.assertRaisesRegex(AssertionError, "occurs 2 times"):
            replace_once("a a", "a", "b")

    def test_no_op_replacement_fails(self) -> None:
        with self.assertRaisesRegex(AssertionError, "did not change"):
            replace_once("a b", "b", "b")


class BuilderTests(unittest.TestCase):
    def test_built_readmes_parse_and_report_the_catalog_region(self) -> None:
        text = sample_readme()
        self.assertEqual(len(parse_readme(text)["projects"]), 3)
        start, end = catalog_region(text.split("\n"))
        self.assertLess(start, end)

    def test_entry_helper_shapes(self) -> None:
        self.assertEqual(entry("T", "https://e.org"), "- [T](https://e.org)")
        self.assertEqual(entry("T", "https://e.org", "d", "NEW"), "- [T](https://e.org) — d ![NEW](badges/new.svg)")
        self.assertIn("catalog:start", build_readme([("A", [entry()])]))


if __name__ == "__main__":
    unittest.main()
