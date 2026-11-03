"""URL canonicalization, entity handling, and the frozen project identity policy."""

from __future__ import annotations

import hashlib
import json
import unittest

from support import FIXTURES, CatalogTestCase, build_readme, entry, normalize_url, readme_catalog

NORMALIZATION_CASES = {
    # GitHub repositories: scheme, www, owner/repo case, trailing slash, .git, fragment, default ports
    "https://github.com/Owner/Repo": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo/": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo.git": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo.git/": "https://github.com/owner/repo",
    "https://github.com/OWNER/REPO": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo#readme": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo?tab=readme#readme": "https://github.com/owner/repo?tab=readme",
    "https://github.com/Owner/Repo?ref=main": "https://github.com/owner/repo?ref=main",
    "HTTPS://GitHub.COM:443/Owner/Repo": "https://github.com/owner/repo",
    "http://github.com/Owner/Repo": "https://github.com/owner/repo",
    "http://www.github.com/Owner/Repo/": "https://github.com/owner/repo",
    "https://WWW.GitHub.com./Owner/Repo": "https://github.com/owner/repo",
    "http://github.com:80/Owner/Repo": "https://github.com/owner/repo",
    "http://github.com:8080/Owner/Repo": "http://github.com:8080/owner/repo",
    "https://github.com/Owner": "https://github.com/owner",
    # GitHub deeper paths keep case, trailing slash, and .git text
    "https://github.com/Owner/Repo/tree/Main/": "https://github.com/owner/repo/tree/Main/",
    "https://github.com/Owner/Repo/blob/main/Examples/Co2.py": "https://github.com/owner/repo/blob/main/Examples/Co2.py",
    "https://github.com/Owner/Repo.git/tree/main": "https://github.com/owner/repo.git/tree/main",
    "https://github.com/Owner/Repo/releases": "https://github.com/owner/repo/releases",
    # Other GitHub hosts are separate resources
    "https://gist.github.com/User/Abc123": "https://gist.github.com/User/Abc123",
    # Every host
    "HTTPS://Example.ORG:443/Path": "https://example.org/Path",
    "http://example.org:80/x": "http://example.org/x",
    "https://example.org:8443/x": "https://example.org:8443/x",
    "https://example.org./x": "https://example.org/x",
    "https://example.org/path/#fragment": "https://example.org/path/",
    "https://example.org/a%2fb?q=%e2%9c%93": "https://example.org/a%2Fb?q=%E2%9C%93",
    "https://example.org/?a=1&b=2": "https://example.org/?a=1&b=2",
    "https://xn--bcher-kva.example/x": "https://xn--bcher-kva.example/x",  # punycode passes through unchanged
    "https://[::1]:8080/x": "https://[::1]:8080/x",
    "https://[0:0:0:0:0:0:0:1]/x": "https://[::1]/x",
    "https://127.0.0.1:8080/x": "https://127.0.0.1:8080/x",
    "https://my_host.example/x": "https://my_host.example/x",
    # Idempotence regressions (Codex M5): suffix case and ordering
    "https://github.com/Owner/Repo.GIT": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo.Git/": "https://github.com/owner/repo",
    "https://github.com/Owner/Repo.git.git": "https://github.com/owner/repo",
    "https://github.com/owner/.git": "https://github.com/owner/.git",
    "https://github.com/OWNER/Repo.GIT/tree/Main": "https://github.com/owner/repo.git/tree/Main",
    # Non-ASCII path and query characters become UTF-8 percent escapes (same destination)
    "https://example.org/café?q=é": "https://example.org/caf%C3%A9?q=%C3%A9",
    "https://example.org/caf%c3%a9": "https://example.org/caf%C3%A9",
    # Non-GitHub hosts keep scheme, www, trailing slash, and path case distinct
    "http://example.org/x": "http://example.org/x",
    "https://www.example.org/x": "https://www.example.org/x",
    "https://example.org/x/": "https://example.org/x/",
    "https://example.org/X": "https://example.org/X",
}


class NormalizationTests(CatalogTestCase):
    def test_normalization_table(self) -> None:
        for source, expected in NORMALIZATION_CASES.items():
            with self.subTest(source=source):
                self.assertEqual(normalize_url(source), expected)

    def test_normalization_is_idempotent_for_the_table(self) -> None:
        for expected in NORMALIZATION_CASES.values():
            with self.subTest(url=expected):
                self.assertEqual(normalize_url(expected), expected)

    def test_normalization_is_idempotent_over_generated_urls(self) -> None:
        """Every accepted URL must already be canonical: normalize(normalize(u)) == normalize(u)."""

        schemes = ("http", "https", "HTTPS")
        hosts = (
            "github.com", "www.github.com", "GitHub.com.", "example.org", "Example.ORG.", "www.example.org",
            "my_host.example", "[::1]", "[0:0:0:0:0:0:0:1]", "127.0.0.1", "xn--bcher-kva.example",
        )
        ports = ("", ":80", ":443", ":8080")
        paths = (
            "", "/", "//", "/a//b/", "/Owner", "/Owner/", "/Owner/Repo", "/Owner/Repo/", "/Owner/Repo.git",
            "/Owner/Repo.GIT/", "/Owner/Repo.git.git", "/owner/.git", "/Owner/Repo/tree/Main/", "/a%2fb", "/café",
        )
        tails = ("", "?q=1", "?q=é#frag", "#frag", "?", "?a=%e2%9c%93")
        accepted = rejected = 0
        for scheme in schemes:
            for host in hosts:
                for port in ports:
                    for path in paths:
                        for tail in tails:
                            url = f"{scheme}://{host}{port}{path}{tail}"
                            try:
                                once = normalize_url(url)
                            except ValueError:
                                rejected += 1
                                continue
                            accepted += 1
                            self.assertEqual(normalize_url(once), once, f"not idempotent: {url!r} -> {once!r}")
        self.assertGreater(accepted, 5000, "the sweep must exercise real normalizations")
        self.assertEqual(rejected, 0, "none of the generated URLs is invalid")

    def test_codex_reproductions_are_idempotent_or_explicitly_rejected(self) -> None:
        self.assertEqual(normalize_url("https://github.com/Owner/Repo.GIT"), "https://github.com/owner/repo")
        self.assertEqual(normalize_url(normalize_url("https://github.com/Owner/Repo.GIT")), "https://github.com/owner/repo")
        with self.assertRaisesRegex(ValueError, "internationalized hostnames are unsupported"):
            normalize_url("https://example.org。/p")  # ideographic full stop would otherwise become a trailing dot

    def test_internationalized_hosts_are_rejected_not_rewritten(self) -> None:
        # Codex M3: the IDNA 2003 codec turned faß.de into fass.de, a different host.
        for url in (
            "https://faß.de/p",
            "https://bücher.example/x",
            "https://ＥＸＡＭＰＬＥ.org/",
            "https://example.org。",
            "https://example.org．/",
            "https://exаmple.org/",  # Cyrillic а
        ):
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "internationalized hostnames are unsupported"):
                normalize_url(url)
        self.assertEqual(normalize_url("https://xn--fa-hia.de/p"), "https://xn--fa-hia.de/p")

    def test_malformed_authorities_are_rejected(self) -> None:
        # Codex M4 plus related forms that browsers parse differently from Python's urlsplit.
        cases = {
            "https://evil<host>/": "forbidden characters",
            "https://%GG/": "invalid percent escape",
            "https://evil%2Fhost/": "forbidden characters",
            "https://exa%6Dple.org/": "forbidden characters",
            "https://exam^ple.org/": "forbidden characters",
            "https://exam|ple.org/": "forbidden characters",
            "https://exam{ple}.org/": "forbidden characters",
            "https://exam'ple.org/": "forbidden characters",
            "https://a..b/": "forbidden characters",
            "https://.example.org/": "forbidden characters",
            "https://example.org../": "forbidden characters",
            "https://-bad.example/": "forbidden characters",
            "https://bad-.example/": "forbidden characters",
            "https://" + "a" * 64 + ".example/": "forbidden characters",
            "https://" + ".".join(["abcdefgh"] * 32) + "/": "forbidden characters",
            "https://example.org\\@evil.test/": "backslashes",
            "https://example.org\\path": "backslashes",
            "https://example.org/a\\b": "backslashes",
            "https://[example.org]/": "invalid URL|IPv6",
            "https://[::1/": "invalid URL",
            "https://[1:2:3]/": "invalid URL|IPv6",
            "https://127.1/": "ambiguous numeric host",
            "https://0x7f.1/": "ambiguous numeric host",
            "https://2130706433/": "ambiguous numeric host",
            "https://01.2.3.4/": "ambiguous numeric host",
            "https://256.1.1.1/": "ambiguous numeric host",
            "https://example.org:abc/": "invalid URL",
            "https://example.org:99999/": "invalid URL",
            "https://example.org/%zz": "invalid percent escape",
            "https://example.org/a%4": "invalid percent escape",
            "https://example.org/a?b=%": "invalid percent escape",
            "https://example.org/a\x01b": "control characters",
            "https://example.org/a\x7fb": "control characters",
            "https://user@example.org/": "credentials",
            "https://@example.org/": "credentials",
            "https:///x": "must include a host",
            "https:example.org/x": "must include a host",
        }
        for url, message in cases.items():
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, message):
                normalize_url(url)

    def test_valid_hosts_still_accepted(self) -> None:
        for url in (
            "https://localhost/",
            "https://a.b-c.d_e.example/",
            "https://1host.example/",
            "https://example.123abc/",
            "https://" + "a" * 63 + ".example/",
            "https://[2001:db8::1]:8443/x",
            "https://192.168.0.1/x",
        ):
            with self.subTest(url=url):
                normalize_url(url)

    def test_invalid_urls_are_rejected(self) -> None:
        for url in (
            "",
            " ",
            "https://exa mple.org/",
            "ftp://example.org/",
            "javascript:alert(1)",
            "https://",
            "https:///x",
            "https://user:secret@example.org/",
            "https://example.org:99999/",
            "//example.org/x",
            "example.org/x",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                normalize_url(url)

    def test_equivalent_urls_are_duplicates(self) -> None:
        base = "https://github.com/owner/repo"
        variants = [
            "https://GitHub.com/Owner/Repo.git",
            "http://github.com/owner/repo",
            "https://www.github.com/owner/repo/",
            "https://github.com./owner/repo",
            "https://github.com:443/owner/repo#readme",
            "https://github.com/OWNER/REPO/",
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                text = build_readme([("Alpha", [entry("A", base), entry("B", variant)])])
                self.assertInvalid(text, "duplicate canonical project URL")
        text = build_readme([("Alpha", [entry("A", "https://example.org/a%2fb"), entry("B", "https://EXAMPLE.org:443/a%2Fb#x")])])
        self.assertInvalid(text, "duplicate canonical project URL")

    def test_distinct_resources_are_not_duplicates(self) -> None:
        pairs = [
            ("http://example.org/x", "https://example.org/x"),
            ("https://example.org/x", "https://www.example.org/x"),
            ("https://example.org/x", "https://example.org/x/"),
            ("https://example.org/x", "https://example.org/X"),
            ("https://example.org/?a=1", "https://example.org/?a=2"),
            ("https://github.com/owner/repo", "https://github.com/owner/repo/issues"),
            ("https://github.com/owner/repo/tree/main", "https://github.com/owner/repo/tree/Main"),
            ("https://gist.github.com/a/b", "https://github.com/a/b"),
        ]
        for first, second in pairs:
            with self.subTest(first=first, second=second):
                catalog = self.parse(build_readme([("Alpha", [entry("A", first), entry("B", second)])]))
                self.assertEqual(len({project["id"] for project in catalog["projects"]}), 2)


class EntityAndEscapeTests(CatalogTestCase):
    def url_of(self, destination: str) -> str:
        return self.parse(build_readme([("Alpha", [entry("T", destination)])]))["projects"][0]["url"]

    def test_entities_in_destinations_decode_like_commonmark(self) -> None:
        expected = "https://example.org/?a=1&b=2"
        for destination in (
            "https://example.org/?a=1&amp;b=2",
            "https://example.org/?a=1&#38;b=2",
            "https://example.org/?a=1&#x26;b=2",
            "https://example.org/?a=1&b=2",
        ):
            with self.subTest(destination=destination):
                self.assertEqual(self.url_of(destination), expected)

    def test_entities_and_literal_ampersands_are_the_same_identity(self) -> None:
        text = build_readme([("Alpha", [entry("A", "https://example.org/?a=1&b=2"), entry("B", "https://example.org/?a=1&amp;b=2")])])
        self.assertInvalid(text, "duplicate canonical project URL")

    def test_only_valid_semicolon_terminated_entities_are_decoded(self) -> None:
        self.assertEqual(self.url_of("https://example.org/?x=1&copy=2&para=3"), "https://example.org/?x=1&copy=2&para=3")
        self.assertEqual(self.url_of("https://example.org/?x=1&nosuchentity;=2"), "https://example.org/?x=1&nosuchentity;=2")
        self.assertEqual(self.url_of("https://example.org/?x=1&amp"), "https://example.org/?x=1&amp")

    def test_escaped_ampersand_stays_literal(self) -> None:
        self.assertEqual(self.url_of(r"https://example.org/?a=1\&amp;b=2"), "https://example.org/?a=1&amp;b=2")

    def test_entities_cannot_smuggle_whitespace_or_controls(self) -> None:
        self.assertInvalid(build_readme([("Alpha", [entry("T", "https://example.org/a&#32;b")])]), "no whitespace")
        self.assertInvalid(build_readme([("Alpha", [entry("T", "https://example.org/a&#10;b")])]), "not allowed")

    def test_backslash_escapes_are_decoded_and_equivalent_to_plain_text(self) -> None:
        plain = self.parse(build_readme([("Alpha", [entry("T", "https://github.com/jake1164/presto-snake")])]))["projects"][0]
        escaped = self.parse(build_readme([("Alpha", [entry("T", r"https://github.com/jake1164/presto\-snake")])]))["projects"][0]
        self.assertEqual((plain["url"], plain["id"]), (escaped["url"], escaped["id"]))


class IdentityPolicyTests(CatalogTestCase):
    def test_id_format_and_versions(self) -> None:
        catalog = self.parse(build_readme([("Alpha", [entry("T", "https://example.org/t")])]))
        expected = "presto_" + hashlib.sha256(b"https://example.org/t").hexdigest()
        self.assertEqual(catalog["projects"][0]["id"], expected)
        self.assertEqual(catalog["identity_version"], 1)
        self.assertEqual(readme_catalog.IDENTITY_VERSION, 1)

    def test_id_depends_only_on_the_canonical_url(self) -> None:
        url = "https://example.org/stable"
        variants = [
            build_readme([("Alpha", [entry("Title", url)])]),
            build_readme([("Renamed", [entry("Another title", url, "with description", "NEW")])]),
            build_readme([("Z", [entry("Third", "https://example.org/other"), entry("T", url, None, "RECENT")])]),
            build_readme([("Alpha", [entry("Title", url + "#fragment")])]),
        ]
        ids = {next(p["id"] for p in self.parse(text)["projects"] if p["url"] == url) for text in variants}
        self.assertEqual(len(ids), 1)

    def test_changing_a_url_changes_the_identity(self) -> None:
        old = self.parse(build_readme([("Alpha", [entry("T", "https://example.org/old")])]))["projects"][0]["id"]
        new = self.parse(build_readme([("Alpha", [entry("T", "https://example.org/new")])]))["projects"][0]["id"]
        self.assertNotEqual(old, new)

    def test_frozen_ids_for_the_original_53_projects_never_change(self) -> None:
        """IDs were generated by the reviewed v1.0.0 parser and are recorded as literals.

        If this fails, a normalization change altered an existing identity. Do not
        edit the fixture: bump ``IDENTITY_VERSION`` and add an explicit old-to-new
        ID mapping instead (see the module docstring in tools/readme_catalog.py).
        """

        rows = json.loads((FIXTURES / "baseline_projects.json").read_text(encoding="utf-8"))
        self.assertEqual(len(rows), 53)
        for row in rows:
            with self.subTest(title=row["title"]):
                canonical = normalize_url(row["url"])
                self.assertEqual(canonical, row["canonical_url"])
                self.assertEqual(row["id"], "presto_" + hashlib.sha256(canonical.encode("utf-8")).hexdigest())
        self.assertEqual(len({row["id"] for row in rows}), 53)

    def test_literal_id_vectors(self) -> None:
        vectors = {
            "https://shop.pimoroni.com/products/presto": "presto_cdb631228402dd3123fddf51396fb06f8ff7d653b767323c57ade0b8e9a0c76a",
            "https://github.com/pimoroni/presto": "presto_5bf5408b1b9a70befc6eea04ca354c2bd1ddb2f8f421f3227f9630f9a689b428",
            "https://github.com/jake1164/presto-snake": "presto_1c9325e90896d31ebc0e47435437d0ceb71c6d4fe9b7ad30c0e2c15683e3cb85",
        }
        for url, expected in vectors.items():
            with self.subTest(url=url):
                self.assertEqual(readme_catalog.project_id(normalize_url(url)), expected)


if __name__ == "__main__":
    unittest.main()
