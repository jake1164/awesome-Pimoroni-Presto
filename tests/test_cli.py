"""Command-line behavior: atomic output, fail-closed errors, and CI annotations."""

from __future__ import annotations

import hashlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from support import (
    ROOT,
    CatalogError,
    build_readme,
    entry,
    parse_readme,
    readme_catalog,
    render_catalog,
    sample_readme,
)

SCRIPT = ROOT / "tools" / "readme_catalog.py"


def run_cli(*arguments: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


class CliTests(unittest.TestCase):
    def setUp(self) -> None:
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.dir = Path(self._directory.name)
        self.readme = self.dir / "README.md"

    def write_readme(self, text: str) -> None:
        self.readme.write_text(text, encoding="utf-8", newline="")

    def test_success_writes_deterministic_json_atomically(self) -> None:
        text = sample_readme()
        self.write_readme(text)
        first = run_cli("--readme", "README.md", "--output", "build/nested/catalog.json", cwd=self.dir)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("Generated 3 projects in 2 categories", first.stdout)
        output = self.dir / "build" / "nested" / "catalog.json"
        self.assertEqual(output.read_bytes(), render_catalog(parse_readme(text)).encode("utf-8"))
        self.assertEqual([path.name for path in output.parent.iterdir()], ["catalog.json"])
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        second = run_cli("--readme", "README.md", "--output", "build/nested/catalog.json", cwd=self.dir)
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(hashlib.sha256(output.read_bytes()).hexdigest(), digest)

    def test_failure_is_fail_closed_with_line_numbered_error(self) -> None:
        text = sample_readme().replace(entry("Two", "https://example.org/two"), "- [Two](not-a-url)")
        self.write_readme(text)
        stale = self.dir / "catalog.json"
        stale.write_text('{"stale": true}\n', encoding="utf-8")
        result = run_cli("--readme", "README.md", "--output", "catalog.json", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        line = text.split("\n").index("- [Two](not-a-url)") + 1
        self.assertTrue(result.stderr.startswith(f"README.md:{line}: "), result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(stale.exists(), "a stale catalog must not survive a failed build")

    def test_error_label_uses_the_readme_argument(self) -> None:
        self.write_readme("# nothing here\n")
        other = self.dir / "docs" / "OTHER.md"
        other.parent.mkdir()
        other.write_text("# nothing here\n", encoding="utf-8")
        result = run_cli("--readme", "docs/OTHER.md", "--output", "c.json", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(result.stderr.startswith("docs/OTHER.md: could not find"), result.stderr)

    def test_github_annotation_format(self) -> None:
        text = sample_readme().replace(entry("Two", "https://example.org/two"), "- [Two](not-a-url)")
        self.write_readme(text)
        result = run_cli("--readme", "README.md", "--output", "c.json", "--format", "github", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        with self.assertRaises(CatalogError) as context:
            parse_readme(text)
        error = context.exception
        self.assertEqual(
            result.stderr.strip(),
            f"::error file=README.md,line={error.line},title=README catalog::{error.message}",
        )

    def test_annotation_escaping(self) -> None:
        formatted = readme_catalog.format_diagnostic("error", "dir:a,b%.md", 7, "50% bad\nnext:line, ok\r", "github")
        self.assertEqual(
            formatted,
            "::error file=dir%3Aa%2Cb%25.md,line=7,title=README catalog::50%25 bad%0Anext:line, ok%0D",
        )
        self.assertEqual(readme_catalog.format_diagnostic("error", "README.md", None, "m", "github"), "::error file=README.md,title=README catalog::m")
        self.assertEqual(readme_catalog.format_diagnostic("error", "README.md", 3, "m", "text"), "README.md:3: m")

    def test_misplaced_entries_fail_the_build_with_an_annotation(self) -> None:
        misplaced = "  - [Omitted](https://example.org/review-indented) — should diagnose"
        text = build_readme([("Alpha", [entry()])], after="### Hardware Mods\n\n" + misplaced + "\n\n")
        self.write_readme(text)
        stale = self.dir / "c.json"
        stale.write_text("{}", encoding="utf-8")
        line = text.split("\n").index(misplaced) + 1
        result = run_cli("--readme", "README.md", "--output", "c.json", "--format", "github", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertRegex(
            result.stderr, rf"^::error file=README\.md,line={line},title=README catalog::project entry is outside"
        )
        self.assertFalse(stale.exists())

    def test_duplicate_diagnostic_names_the_supplied_file_only(self) -> None:
        # Codex L2: the secondary location used to be hard-coded as README.md.
        other = self.dir / "docs" / "duplicate.md"
        other.parent.mkdir()
        first_entry = entry("A", "https://example.org/x")
        second_entry = entry("B", "https://example.org/x#frag")
        text = build_readme([("Alpha", [first_entry, second_entry])])
        other.write_text(text, encoding="utf-8", newline="")
        lines = text.split("\n")
        first, second = lines.index(first_entry) + 1, lines.index(second_entry) + 1
        for style in ("text", "github"):
            with self.subTest(style=style):
                result = run_cli("--readme", "docs/duplicate.md", "--output", "c.json", "--format", style, cwd=self.dir)
                self.assertEqual(result.returncode, 1)
                self.assertNotIn("README.md", result.stderr)
                self.assertIn(f"first listed on line {first}", result.stderr)
                expected_prefix = f"docs/duplicate.md:{second}: " if style == "text" else f"::error file=docs/duplicate.md,line={second},"
                self.assertTrue(result.stderr.startswith(expected_prefix), result.stderr)

    def test_invalid_utf8_is_a_clean_failure(self) -> None:
        self.readme.write_bytes(b"# title\n\xff\xfe broken\n")
        stale = self.dir / "c.json"
        stale.write_text("{}", encoding="utf-8")
        result = run_cli("--readme", "README.md", "--output", "c.json", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertIn("not valid UTF-8", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(stale.exists())

    def test_missing_readme_is_a_clean_failure(self) -> None:
        result = run_cli("--readme", "missing.md", "--output", "c.json", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse((self.dir / "c.json").exists())

    def test_output_may_not_clobber_the_readme_or_a_non_json_file(self) -> None:
        self.write_readme(sample_readme())
        original = self.readme.read_bytes()
        same_file = run_cli("--readme", "README.md", "--output", "README.md", cwd=self.dir)
        self.assertEqual(same_file.returncode, 2)
        self.assertEqual(self.readme.read_bytes(), original)
        non_json = run_cli("--readme", "README.md", "--output", "catalog.txt", cwd=self.dir)
        self.assertEqual(non_json.returncode, 2)
        self.assertFalse((self.dir / "catalog.txt").exists())
        json_readme = self.dir / "readme.json"
        json_readme.write_text("# nothing", encoding="utf-8")
        refused = run_cli("--readme", "readme.json", "--output", "./readme.json", cwd=self.dir)
        self.assertEqual(refused.returncode, 2)
        self.assertIn("must not be the README", refused.stderr)
        self.assertEqual(json_readme.read_text(encoding="utf-8"), "# nothing")

    def test_write_failure_leaves_no_temporary_files(self) -> None:
        self.write_readme(sample_readme())
        blocked = self.dir / "out" / "catalog.json"
        blocked.mkdir(parents=True)
        result = run_cli("--readme", "README.md", "--output", "out/catalog.json", cwd=self.dir)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual([path.name for path in (self.dir / "out").iterdir()], ["catalog.json"])


if __name__ == "__main__":
    unittest.main()
