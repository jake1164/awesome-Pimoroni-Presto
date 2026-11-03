"""Entry grammar, badges, description segments, and untrusted-text handling."""

from __future__ import annotations

import unittest

from support import CatalogTestCase, build_readme, entry


def readme_with(line: str) -> str:
    return build_readme([("Alpha", [line])])


class EntryGrammarTests(CatalogTestCase):
    def project(self, line: str) -> dict:
        return self.parse(readme_with(line))["projects"][0]

    def test_description_separators(self) -> None:
        for separator in ("—", "–", "- ", " — ", "—  "):
            with self.subTest(separator=separator):
                project = self.project(f"- [T](https://example.org/t) {separator}the description")
                self.assertEqual(project["description"], "the description")
        self.assertEqual(self.project("- [T](https://example.org/t)—tight")["description"], "tight")
        self.assertEqual(self.project("- [T](https://example.org/t)")["description"], "")
        self.assertEqual(self.project("- [T](https://example.org/t) —")["description_parts"], [])
        self.assertEqual(self.project("* [T](https://example.org/t) — star")["description"], "star")
        self.assertEqual(self.project("+ [T](https://example.org/t) — plus")["description"], "plus")

    def test_separator_errors_do_not_drop_text(self) -> None:
        cases = {
            "- [T](https://example.org/t): colon": "description must follow the project link",
            "- [T](https://example.org/t) (unofficial) — text": "description must follow the project link",
            "- [T](https://example.org/t) -5C sensor": "description must follow the project link",
            "- [T](https://example.org/t) plain words": "description must follow the project link",
        }
        for line, message in cases.items():
            with self.subTest(line=line):
                self.assertInvalid(readme_with(line), message)

    def test_badges(self) -> None:
        self.assertEqual(self.project(entry("T", "https://example.org/t", "d", "NEW"))["badges"], ["NEW"])
        self.assertEqual(self.project(entry("T", "https://example.org/t", None, "RECENT"))["badges"], ["RECENT"])
        self.assertEqual(self.project(entry("T", "https://example.org/t"))["badges"], [])
        spaced = self.project("- [T](https://example.org/t) —   d   ![NEW](badges/new.svg)   ")
        self.assertEqual((spaced["description"], spaced["badges"]), ("d", ["NEW"]))
        self.assertEqual(self.project("- [T](https://example.org/t) ![NEW](badges/new.svg)")["description"], "")

    def test_badges_must_be_at_the_end_of_the_line(self) -> None:
        base = "- [T](https://example.org/t) — "
        placement = "badges must be at the end of the line, after the description"
        cases = {
            "before description text": (base + "a ![NEW](badges/new.svg) b", placement),
            "badge then text": (base + "![NEW](badges/new.svg) trailing", placement),
            "text between badges": (base + "d ![NEW](badges/new.svg) and ![RECENT](badges/recent.svg)", placement),
            "inside a link label": (base + "[docs ![NEW](badges/new.svg)](https://example.org/d)", placement),
            "linked badge": (base + "[![NEW](badges/new.svg)](https://example.org/d)", placement),
            "two adjacent badges": (base + "![NEW](badges/new.svg) ![RECENT](badges/recent.svg)", "cannot have both"),
        }
        for name, (line, message) in cases.items():
            with self.subTest(name=name):
                self.assertInvalid(readme_with(line), message)

    def test_escaped_badge_syntax_is_literal_text_not_a_badge(self) -> None:
        # Codex L1: `\![NEW](...)` is a literal "!" followed by an ordinary (here relative, hence rejected) link.
        escaped = "- [T](https://example.org/t) — literal \\![NEW](badges/new.svg)"
        error = self.assertInvalid(readme_with(escaped), "invalid link URL `badges/new.svg` in description")
        self.assertEqual(error.line, readme_with(escaped).split("\n").index(escaped) + 1)
        for line in (
            "- [T](https://example.org/t) — literal !\\[NEW\\](badges/new.svg)",
            "- [T](https://example.org/t) — literal \\![NEW\\](badges/new.svg)",
        ):
            with self.subTest(line=line):
                project = self.project(line)
                self.assertEqual(project["badges"], [])
                self.assertIn("NEW", project["description"])
        # an escaped backslash leaves the following image unescaped, so it is a real badge
        double = self.project("- [T](https://example.org/t) — literal \\\\![NEW](badges/new.svg)")
        self.assertEqual((double["badges"], double["description"]), (["NEW"], "literal \\"))

    def test_badge_errors(self) -> None:
        base = "- [T](https://example.org/t) — d "
        cases = {
            "both": (base + "![NEW](badges/new.svg) ![RECENT](badges/recent.svg)", "cannot have both"),
            "duplicate": (base + "![NEW](badges/new.svg) ![NEW](badges/new.svg)", "duplicate `NEW` badge"),
            "mismatch": (base + "![NEW](badges/recent.svg)", "unsupported image/badge syntax"),
            "unknown": (base + "![HOT](badges/hot.svg)", "unsupported image/badge syntax"),
            "external image": (base + "![x](https://example.org/x.png)", "unsupported image/badge syntax"),
            "lowercase": (base + "![new](badges/new.svg)", "unsupported image/badge syntax"),
            "malformed": (base + "![NEW](badges/new.svg", "unsupported image/badge syntax"),
        }
        for name, (line, message) in cases.items():
            with self.subTest(name=name):
                self.assertInvalid(readme_with(line), message)

    def test_primary_link_errors(self) -> None:
        cases = {
            "no link": ("- Presto Snake: https://example.org/t", "must begin with a primary Markdown link"),
            "bold": ("- **[T](https://example.org/t)**", "must begin with a primary Markdown link"),
            "reference style": ("- [T][ref]", "reference-style links are unsupported"),
            "task list": ("- [ ] [T](https://example.org/t)", "malformed primary Markdown link"),
            "unclosed": ("- [T](https://example.org/t", "unclosed URL"),
            "unclosed label": ("- [T(https://example.org/t)", "malformed primary Markdown link"),
            "angle brackets": ("- [T](<https://example.org/t>)", "angle-bracket link destinations"),
            "link title": ('- [T](https://example.org/t "Title")', "link titles"),
            "empty url": ("- [T]()", "must not be empty"),
            "relative": ("- [T](CONTRIBUTING.md)", "must use http or https"),
            "mailto": ("- [T](mailto:a@example.org)", "must use http or https"),
            "ftp": ("- [T](ftp://example.org/t)", "must use http or https"),
            "javascript": ("- [T](javascript:alert(1))", "must use http or https"),
            "credentials": ("- [T](https://user:pw@example.org/t)", "must not contain credentials"),
            "no host": ("- [T](https:///path)", "must include a host"),
            "bad escape": (r"- [T](https://example.org/a\qb)", "unsupported backslash escape"),
            "trailing escape": ("- [T](https://example.org/a\\)", "unclosed URL"),
            "nested link": ("- [[a](https://example.org/a)](https://example.org/t)", "nested links"),
            "empty title": ("- [ ](https://example.org/t)", "link title must not be empty"),
            "long title": (f"- [{'T' * 121}](https://example.org/t)", "link title is longer than 120"),
            "long url": (f"- [T](https://example.org/{'a' * 2000})", "URL is longer than 2000"),
            "overlong label": ("- [T](https://" + "a" * 64 + ".example/t)", "malformed label"),
            "unicode host": ("- [T](https://faß.de/p)", "internationalized hostnames are unsupported"),
            "malformed authority": ("- [T](https://evil<host>/)", "forbidden characters"),
            "invalid percent": ("- [T](https://%GG/)", "invalid percent escape"),
            "percent-encoded slash in host": ("- [T](https://evil%2Fhost/)", "forbidden characters"),
            "backslash authority": (r"- [T](https://example.org\\@evil.test/)", "unsupported backslash escape|backslashes"),
        }
        for name, (line, message) in cases.items():
            with self.subTest(name=name):
                self.assertInvalid(readme_with(line), message, line=readme_with(line).split("\n").index(line) + 1)

    def test_titles_are_decoded_plain_text(self) -> None:
        cases = {
            r"Snake \[beta\]": "Snake [beta]",
            "Snake [beta]": "Snake [beta]",
            r"Snake\_Game": "Snake_Game",
            "Q&amp;A &lt;3": "Q&A <3",
            "GitHub Releases & Firmware": "GitHub Releases & Firmware",
            "CO₂ Monitor": "CO₂ Monitor",
            "Presto-Cal (iCalendar + Timezone/DST)": "Presto-Cal (iCalendar + Timezone/DST)",
            'WiiM "What\'s Playing"': 'WiiM "What\'s Playing"',
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(self.project(f"- [{source}](https://example.org/t)")["title"], expected)

    def test_parentheses_and_escapes_in_urls(self) -> None:
        url = "https://en.wikipedia.org/wiki/Raspberry_Pi_(disambiguation)"
        self.assertEqual(self.project(f"- [Wiki]({url})")["url"], url)
        self.assertEqual(
            self.project(r"- [T](https://example.org/a\-b)")["url"], "https://example.org/a-b"
        )

    def test_duplicate_urls_report_both_locations(self) -> None:
        text = build_readme(
            [
                ("Alpha", [entry("One", "https://example.org/x")]),
                ("Beta", [entry("Two", "https://EXAMPLE.org:443/x#frag")]),
            ]
        )
        lines = text.split("\n")
        first = lines.index(entry("One", "https://example.org/x")) + 1
        error = self.assertInvalid(text, f"duplicate canonical project URL.*first listed on line {first}$")
        self.assertEqual(error.line, lines.index(entry("Two", "https://EXAMPLE.org:443/x#frag")) + 1)
        self.assertNotIn("README.md", error.message)  # the file name comes from the caller, not the message


class DescriptionPartsTests(CatalogTestCase):
    def project(self, description: str) -> dict:
        return self.parse(readme_with(f"- [T](https://example.org/t) — {description}"))["projects"][0]

    def test_links_become_structured_segments_and_plain_text_is_flattened(self) -> None:
        project = self.project("see ([live demo](https://example.org/demo)), and [forum](https://example.org/f).")
        self.assertEqual(
            project["description_parts"],
            [
                {"text": "see ("},
                {"text": "live demo", "url": "https://example.org/demo"},
                {"text": "), and "},
                {"text": "forum", "url": "https://example.org/f"},
                {"text": "."},
            ],
        )
        self.assertEqual(project["description"], "see (live demo), and forum.")

    def test_description_text_is_decoded_but_never_interpreted_as_html(self) -> None:
        project = self.project(r"Q&amp;A, 5 &lt; 6, a\*b, R&D, \[not a link\], [bare] text, 2 < 3")
        self.assertEqual(project["description"], "Q&A, 5 < 6, a*b, R&D, [not a link], [bare] text, 2 < 3")
        self.assertEqual(project["description_parts"], [{"text": project["description"]}])

    def test_incomplete_links_are_literal_text_like_on_github(self) -> None:
        self.assertEqual(self.project("see [docs](https://example.org/d")["description"], "see [docs](https://example.org/d")

    def test_description_link_urls_keep_fragments_and_are_validated(self) -> None:
        link = self.project("[a](https://example.org/d#section)")["description_parts"][0]
        self.assertEqual(link["url"], "https://example.org/d#section")
        link = self.project("[a](https://example.org/?x=1&amp;y=2)")["description_parts"][0]
        self.assertEqual(link["url"], "https://example.org/?x=1&y=2")

    def test_untrusted_markup_is_rejected(self) -> None:
        cases = {
            "javascript link": ("[click](javascript:alert(1))", "invalid link URL"),
            "data link": ("[click](data:text/html;base64,AAAA)", "invalid link URL"),
            "relative link": ("[click](CONTRIBUTING.md)", "invalid link URL"),
            "credential link": ("[click](https://u:p@example.org/)", "invalid link URL"),
            "angle link": ("[click](<https://example.org/>)", "angle-bracket link destinations"),
            "titled link": ('[click](https://example.org/ "t")', "link titles"),
            "script tag": ("<script>alert(1)</script>", "raw HTML"),
            "img tag": ("<img src=x onerror=alert(1)>", "raw HTML"),
            "comment": ("a <!-- hidden --> b", "raw HTML"),
            "closing tag": ("a </b>", "raw HTML"),
            "autolink": ("see <https://example.org>", "raw HTML"),
            "image": ("![alt](https://example.org/i.png)", "unsupported image/badge syntax"),
            "linked image": ("[![alt](https://example.org/i.png)](https://example.org/)", "unsupported image/badge syntax"),
            "empty link text": ("[ ](https://example.org/)", "must not be empty"),
            "nested link": ("[[a](https://example.org/a)](https://example.org/b)", "nested links"),
            "too long": ("x" * 501, "description is longer than 500"),
        }
        for name, (description, message) in cases.items():
            with self.subTest(name=name):
                self.assertInvalid(readme_with(f"- [T](https://example.org/t) — {description}"), message)

    def test_html_in_titles_is_rejected(self) -> None:
        for title in ("<img src=x onerror=alert(1)>", "<b>bold</b>", "a <!-- c --> b"):
            with self.subTest(title=title):
                self.assertInvalid(readme_with(f"- [{title}](https://example.org/t)"), "raw HTML")

    def test_control_and_bidirectional_characters_are_rejected(self) -> None:
        for name, character in {
            "line separator": " ",
            "paragraph separator": " ",
            "next line": "\x85",
            "null": "\x00",
            "escape": "\x1b",
            "right-to-left override": "‮",
            "left-to-right isolate": "⁦",
            "right-to-left mark": "‏",
            "byte order mark": "﻿",
            "numeric entity newline": "&#10;",
            "numeric entity bidi": "&#x202E;",
        }.items():
            with self.subTest(where="description", name=name):
                self.assertInvalid(readme_with(f"- [T](https://example.org/t) — a{character}b"), "not allowed")
            with self.subTest(where="title", name=name):
                self.assertInvalid(readme_with(f"- [a{character}b](https://example.org/t)"), "not allowed")

    def test_legitimate_unicode_is_preserved(self) -> None:
        project = self.project("CO₂ I²C ♥ café 日本語 👨‍💻 split‑flap — dash")
        self.assertEqual(project["description"], "CO₂ I²C ♥ café 日本語 👨‍💻 split‑flap — dash")

    def test_escaped_text_cannot_smuggle_a_link_or_html(self) -> None:
        project = self.project(r"\[a\](https://example.org/x) and \<b>")
        self.assertEqual(project["description"], "[a](https://example.org/x) and <b>")
        self.assertTrue(all("url" not in part for part in project["description_parts"]))


if __name__ == "__main__":
    unittest.main()
