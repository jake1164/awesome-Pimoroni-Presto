"""Shared helpers for the README catalog tests.

Parser tests build their own README text so they never depend on the live
README's current projects, categories, titles, URLs, or badges.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "tools"))

import readme_catalog  # noqa: E402,F401  (re-exported for the test modules)
from readme_catalog import (  # noqa: E402,F401
    CatalogError,
    normalize_url,
    parse_readme,
    render_catalog,
)

START = "<!-- catalog:start -->"
END = "<!-- catalog:end -->"


def replace_once(text: str, old: str, new: str) -> str:
    """Replace ``old`` exactly once, failing loudly if the mutation cannot apply.

    A bare ``str.replace`` silently does nothing when the target is absent, which
    makes mutation tests pass vacuously.
    """

    occurrences = text.count(old)
    if occurrences != 1:
        raise AssertionError(f"mutation target occurs {occurrences} times (expected 1): {old!r}")
    mutated = text.replace(old, new, 1)
    if mutated == text:
        raise AssertionError(f"mutation did not change the text: {old!r}")
    return mutated


def entry(
    title: str = "Project",
    url: str = "https://example.org/project",
    description: str | None = None,
    badge: str | None = None,
) -> str:
    line = f"- [{title}]({url})"
    if description is not None:
        line += f" — {description}"
    if badge:
        line += f" ![{badge}](badges/{badge.lower()}.svg)"
    return line


def build_readme(
    categories: list[tuple[str, list[str]]],
    before: str = "",
    after: str = "",
    contents: bool = True,
) -> str:
    """Return a README with a marked catalog containing ``categories``."""

    parts = ["# Sample list\n\nAn intro with an [ordinary link](https://example.org/intro).\n"]
    if contents:
        parts.append("## Contents\n\n- [Anything](#anything)\n- [Contributing](#i-want-to-contribute)\n")
    if before:
        parts.append(before)
    parts.append(START + "\n")
    for name, entries in categories:
        parts.append(f"### {name}\n\n" + "\n".join(entries) + ("\n" if entries else ""))
    parts.append(END + "\n")
    if after:
        parts.append(after)
    parts.append(
        "### I want to contribute!\n\nRead the [guide](CONTRIBUTING.md) or visit "
        "[the site](https://example.org/site).\n"
    )
    return "\n".join(parts)


def sample_readme() -> str:
    return build_readme(
        [
            ("Alpha", [entry("One", "https://example.org/one", "first"), entry("Two", "https://example.org/two")]),
            ("Beta", [entry("Three", "https://github.com/owner/three", "third", "NEW")]),
        ]
    )


def catalog_region(lines: list[str]) -> tuple[int, int]:
    """Return the real (fence-aware) catalog marker line indexes of a README line list.

    Uses the parser's own locator so tests keep working when the README contains
    fenced examples that mention the markers.
    """

    start, end, _ = readme_catalog.locate_catalog(lines)
    return start, end


def project_ids(catalog: dict) -> dict[str, str]:
    return {project["url"]: project["id"] for project in catalog["projects"]}


class CatalogTestCase(unittest.TestCase):
    def assertInvalid(self, text: str, pattern: str, line: int | None = None) -> CatalogError:
        with self.assertRaisesRegex(CatalogError, pattern) as context:
            parse_readme(text)
        if line is not None:
            self.assertEqual(context.exception.line, line, str(context.exception))
        return context.exception

    def parse(self, text: str) -> dict:
        return parse_readme(text)
