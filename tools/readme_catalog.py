"""Build a deterministic project catalog from the README's marked catalog region.

Format contract
---------------
The catalog is the text between two HTML-comment markers, each on its own line::

    <!-- catalog:start -->
    ### Category name
    - [Project title](https://example.org) — optional description ![NEW](badges/new.svg)
    <!-- catalog:end -->

* Every ``###`` heading inside the markers is a category. Category names, count,
  order, and wording are not configured anywhere else; the README is the source.
* Every top-level list item is a project: ``- [title](URL)`` followed by an
  optional ``—``/``–``/``-`` separated description and optional ``NEW``/``RECENT``
  badges. Entries must stay on one line.
* Blank lines are allowed. Any other content inside the markers is an error so
  that text is never silently dropped.
* Content outside the markers is ordinary README prose and is ignored, with one
  exception so that a project can never silently go missing: a list item (bulleted
  or numbered, at any nesting) outside the markers that *begins with a link to an
  absolute http(s) URL*, or that carries a catalog badge, is an error. Prose
  paragraphs, tables, quotes, relative and ``#anchor`` links, bullets that begin
  with text (``- Docs: [site](https://...)``), and fenced or indented code
  examples remain valid.
* Fenced code blocks follow CommonMark (indent of at most three spaces, backtick
  fence info strings cannot contain backticks, closing fences cannot be indented
  four spaces and must be at least as long as the opening fence). Markers and
  entries inside a fence are examples, not the catalog. Known limitation: fences
  nested in list items or block quotes are not modeled. An *unclosed* fence inside
  a list item can make this scanner disagree with CommonMark about where code ends
  (GitHub then renders the rest of the README as code, so it is visibly broken).
  Keep example fences at the top level and always close them.

Text contract (for consumers such as the future Astro site)
-----------------------------------------------------------
``title`` and ``category`` names are plain text. ``description`` is plain text
and ``description_parts`` is the same text split into ``{"text"}`` and
``{"text", "url"}`` segments. Backslash escapes and CommonMark entities are
already decoded. Raw HTML, images (other than catalog badges), autolinks,
non-http(s) links, control characters, and bidirectional controls are rejected.
Consumers must render text through escaping text nodes and create links only
from ``description_parts`` segments, never with ``innerHTML``/``set:html``.

Identity policy
---------------
A project's ``id`` is ``presto_`` plus the SHA-256 of its canonical URL, as
produced by :func:`normalize_url`. IDs are frozen: changing the normalization
rules must not change the ID of any existing URL. A rule change that would do so
requires a new ``IDENTITY_VERSION`` and an explicit old-to-new ID mapping.
Editing a project's URL in the README creates a new identity; any stored data
for the old ID must be migrated deliberately by the maintainer.
"""

from __future__ import annotations

import argparse
import hashlib
import html.entities
import ipaddress
import json
import os
import re
import sys
import tempfile
import unicodedata
from collections.abc import Iterator
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit


SCHEMA_VERSION = 1
GENERATOR_VERSION = "1.1.0"
IDENTITY_VERSION = 1

CATALOG_START = "catalog:start"
CATALOG_END = "catalog:end"
CATEGORY_LEVEL = 3
BADGES = {"NEW": "badges/new.svg", "RECENT": "badges/recent.svg"}
GITHUB_HOSTS = {"github.com", "www.github.com"}

MAX_TITLE_LENGTH = 120
MAX_DESCRIPTION_LENGTH = 500
MAX_URL_LENGTH = 2000

MARKER_PATTERN = re.compile(r"^ {0,3}<!--\s*(catalog:(?:start|end))\s*-->\s*$")
FENCE_OPEN_PATTERN = re.compile(r"^ {0,3}(`{3,}|~{3,})(.*)$")
FENCE_CLOSE_PATTERN = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*$")
LIST_ITEM_PATTERN = re.compile(r"^[ \t]*[-*+][ \t]+(.*)$")
NUMBERED_ITEM_PATTERN = re.compile(r"^\s*\d+[.)]\s+")
ANY_ITEM_PATTERN = re.compile(r"^([ \t]*)(?:[-*+]|\d{1,9}[.)])[ \t]+")
HEADING_PATTERN = re.compile(r"^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$")
CLOSING_SEQUENCE_PATTERN = re.compile(r"^(.*?)(?:[ \t]+#+)?$")
THEMATIC_BREAK_PATTERN = re.compile(r"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$")
SETEXT_UNDERLINE_PATTERN = re.compile(r"^ {0,3}(?:=+|-+)[ \t]*$")
IMAGE_PATTERN = re.compile(r"!\[([^\]]*)\]\(([^)\s]*)\)")
OUTSIDE_ENTRY_PATTERN = re.compile(
    r"^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[.*?\]\([ \t]*<?https?://", re.IGNORECASE
)
HTML_START_PATTERN = re.compile(r"<[A-Za-z/!?]")
ENTITY_PATTERN = re.compile(
    r"&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));"
)
PERCENT_ESCAPE_PATTERN = re.compile(r"%[0-9a-fA-F]{2}")
INVALID_PERCENT_PATTERN = re.compile(r"%(?![0-9A-Fa-f]{2})")
HOST_LABEL_PATTERN = re.compile(r"^[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$")
NUMERIC_LABEL_PATTERN = re.compile(r"^(?:[0-9]+|0[xX][0-9a-fA-F]*)$")
FORBIDDEN_CODEPOINTS = frozenset(
    [0x061C, 0x200E, 0x200F, 0xFEFF] + list(range(0x202A, 0x202F)) + list(range(0x2066, 0x206A))
)
FORBIDDEN_CATEGORIES = frozenset({"Cc", "Zl", "Zp"})


class CatalogError(ValueError):
    """Raised when README catalog syntax is invalid or unsupported."""

    def __init__(self, message: str, line: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.line = line

    def __str__(self) -> str:
        return format_location("README.md", self.line, self.message)


def format_location(path: str, line: int | None, message: str) -> str:
    return f"{path}:{line}: {message}" if line else f"{path}: {message}"


def _line_error(line_number: int, message: str) -> CatalogError:
    return CatalogError(message, line_number)


def _is_forbidden_character(character: str) -> bool:
    return (
        ord(character) in FORBIDDEN_CODEPOINTS
        or unicodedata.category(character) in FORBIDDEN_CATEGORIES
    )


def _upper_percent_escapes(value: str) -> str:
    return PERCENT_ESCAPE_PATTERN.sub(lambda match: match.group(0).upper(), value)


def _encode_non_ascii(value: str) -> str:
    """Percent-encode non-ASCII characters as UTF-8, as browsers do for paths and queries."""

    return "".join(character if character.isascii() else quote(character, safe="") for character in value)


def _canonical_host(hostname: str, bracketed: bool) -> str:
    """Validate a host strictly and return its canonical spelling.

    Only ASCII hosts are accepted. Internationalized names must be written in
    punycode (``xn--``): converting them here could silently change the
    destination (the standard-library IDNA 2003 codec maps ``faß.de`` to
    ``fass.de``, which browsers treat as a different host).
    """

    if bracketed:
        try:
            return f"[{ipaddress.IPv6Address(hostname).compressed}]"
        except ValueError as error:
            raise ValueError("URL host in brackets must be a valid IPv6 address") from error
    if not hostname.isascii():
        raise ValueError(
            "internationalized hostnames are unsupported; write the host in punycode (`xn--...`)"
        )
    host = hostname.lower()
    if host.endswith("."):
        host = host[:-1]
    if not host:
        raise ValueError("URL must include a host")
    labels = host.split(".")
    if len(host) > 253 or not all(HOST_LABEL_PATTERN.match(label) for label in labels):
        raise ValueError(
            "URL host contains forbidden characters or an empty or malformed label "
            "(allowed: ASCII letters, digits, hyphen, underscore)"
        )
    if NUMERIC_LABEL_PATTERN.match(labels[-1]):
        # Browsers parse a host whose last label is numeric as an IPv4 address,
        # so only the canonical dotted-quad spelling is unambiguous.
        try:
            canonical = str(ipaddress.IPv4Address(host))
        except ValueError as error:
            raise ValueError("ambiguous numeric host; write a full dotted-quad IPv4 address") from error
        if canonical != host:
            raise ValueError("ambiguous numeric host; write a full dotted-quad IPv4 address")
    return host


def normalize_url(raw_url: str) -> str:
    """Normalize URL syntax conservatively for stable project identity.

    The result is canonical in one pass: ``normalize_url(normalize_url(u))`` equals
    ``normalize_url(u)``.

    Rejected (never silently altered): whitespace, control characters,
    backslashes (browsers read them as slashes), invalid percent escapes,
    credentials, internationalized or otherwise malformed hosts, ambiguous
    numeric hosts, and invalid ports.

    Applied to every host: scheme and host casing, one trailing host dot,
    default HTTP(S) ports, UTF-8 percent-encoding of non-ASCII path or query
    characters, percent-escape hex case, IPv6 compression, and removal of the
    fragment (a location within a page, not another project). Query strings and
    path case are otherwise preserved because they can identify distinct resources.

    For github.com (and www.github.com) only: the scheme is https, ``www.`` is
    removed, the owner and repository names are case-folded, and a repository
    URL's trailing slash and terminal ``.git`` clone suffix(es) are removed.
    Deeper GitHub paths keep their case, trailing slash, and ``.git`` text.

    Non-GitHub hosts keep ``http`` versus ``https`` and ``www.`` distinct.
    """

    if not raw_url or any(character.isspace() for character in raw_url):
        raise ValueError("URL must be non-empty and contain no whitespace")
    if any(ord(character) < 0x20 or 0x7F <= ord(character) <= 0x9F for character in raw_url):
        raise ValueError("URL must not contain control characters")
    if "\\" in raw_url:
        raise ValueError("URL must not contain backslashes; browsers treat them as slashes")
    if INVALID_PERCENT_PATTERN.search(raw_url):
        raise ValueError("URL contains an invalid percent escape (`%` must be followed by two hex digits)")

    try:
        parts = urlsplit(raw_url)
        scheme = parts.scheme.lower()
        hostname = parts.hostname
        port = parts.port
    except ValueError as error:
        raise ValueError(f"invalid URL: {error}") from error

    if scheme not in {"http", "https"}:
        raise ValueError("URL must use http or https")
    if not hostname:
        raise ValueError("URL must include a host")
    if parts.username is not None or parts.password is not None:
        raise ValueError("URL must not contain credentials")

    host = _canonical_host(hostname, parts.netloc.startswith("["))
    is_github = host in GITHUB_HOSTS
    if is_github:
        host = "github.com"
        if port in (None, 80, 443):
            port = None
            scheme = "https"
    elif port is not None and ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        port = None
    if port is not None:
        host = f"{host}:{port}"

    path = _encode_non_ascii(parts.path)
    if is_github:
        if len(path.rstrip("/").split("/")) <= 3:
            path = path.rstrip("/")
        segments = path.split("/")
        for position in (1, 2):
            if len(segments) > position:
                segments[position] = segments[position].casefold()
        if len(segments) == 3 and segments[0] == "":
            while segments[2].endswith(".git") and len(segments[2]) > len(".git"):
                segments[2] = segments[2][: -len(".git")]
        path = "/".join(segments)

    query = _encode_non_ascii(parts.query)
    return urlunsplit((scheme, host, _upper_percent_escapes(path), _upper_percent_escapes(query), ""))


def project_id(canonical_url: str) -> str:
    """Return the frozen project identity for an already-canonical URL."""

    return "presto_" + hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()


def _decode(raw: str, line_number: int, mode: str) -> str:
    """Decode CommonMark backslash escapes and entities.

    ``mode`` is ``"destination"`` (unknown escapes are errors; no HTML check) or
    ``"text"`` (a backslash before a non-punctuation character is literal; raw
    HTML is rejected). Entities are decoded strictly (``&name;`` with a
    semicolon), so ``?a=1&copy=2`` is left untouched.
    """

    decoded: list[str] = []
    index = 0
    while index < len(raw):
        character = raw[index]
        if character == "\\":
            if index + 1 == len(raw):
                if mode == "destination":
                    raise _line_error(line_number, "URL destination ends with an incomplete backslash escape")
                decoded.append(character)
                index += 1
                continue
            escaped = raw[index + 1]
            is_punctuation = (
                33 <= ord(escaped) <= 47
                or 58 <= ord(escaped) <= 64
                or 91 <= ord(escaped) <= 96
                or 123 <= ord(escaped) <= 126
            )
            if is_punctuation:
                decoded.append(escaped)
                index += 2
            elif mode == "destination":
                raise _line_error(
                    line_number,
                    f"unsupported backslash escape in URL destination: `\\{escaped}`; "
                    "escape only ASCII punctuation using CommonMark syntax",
                )
            else:
                decoded.append(character)
                index += 1
            continue
        if character == "&":
            match = ENTITY_PATTERN.match(raw, index)
            if match:
                decimal, hexadecimal, name = match.groups()
                if name is not None:
                    replacement = html.entities.html5.get(name + ";")
                else:
                    codepoint = int(decimal) if decimal is not None else int(hexadecimal, 16)
                    invalid = codepoint == 0 or codepoint > 0x10FFFF or 0xD800 <= codepoint <= 0xDFFF
                    replacement = "�" if invalid else chr(codepoint)
                if replacement is not None:
                    decoded.append(replacement)
                    index = match.end()
                    continue
        if mode == "text" and character == "<" and HTML_START_PATTERN.match(raw, index):
            raise _line_error(
                line_number,
                "raw HTML and autolinks are not supported in titles, descriptions, or category names; "
                "use plain text or `[text](https://...)`",
            )
        decoded.append(character)
        index += 1

    result = "".join(decoded)
    for character in result:
        if _is_forbidden_character(character):
            raise _line_error(
                line_number,
                f"control, line-separator, or bidirectional-formatting character "
                f"U+{ord(character):04X} is not allowed",
            )
    return result


def _plain_text(raw: str, line_number: int, what: str, max_length: int) -> str:
    text = _decode(raw, line_number, "text").strip()
    if not text:
        raise _line_error(line_number, f"{what} must not be empty")
    if len(text) > max_length:
        raise _line_error(line_number, f"{what} is longer than {max_length} characters")
    return text


def _scan_bracketed(content: str, start: int) -> int | None:
    """Return the index of the ``]`` matching ``content[start] == "["``."""

    depth = 0
    index = start
    while index < len(content):
        character = content[index]
        if character == "\\":
            index += 2
            continue
        if character == "[":
            depth += 1
        elif character == "]":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _scan_destination(content: str, start: int) -> int | None:
    """Return the index of the ``)`` closing a destination that begins at ``start``."""

    depth = 1
    index = start
    while index < len(content):
        character = content[index]
        if character == "\\":
            index += 2
            continue
        if character == "(":
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _read_link(content: str, index: int, line_number: int, strict: bool) -> tuple[str, str, int] | None:
    """Read ``[label](destination)`` at ``index``.

    Returns ``(label, destination, next_index)``. When ``strict`` is false, text
    that is not a complete inline link returns ``None`` (it is literal text, as
    on GitHub); when true, a precise error is raised.
    """

    label_end = _scan_bracketed(content, index)
    if label_end is None:
        if strict:
            raise _line_error(line_number, "malformed primary Markdown link; expected `[title](URL)`")
        return None
    following = content[label_end + 1 : label_end + 2]
    if following != "(":
        if strict:
            if following in {"[", ":"}:
                raise _line_error(
                    line_number,
                    "reference-style links are unsupported; write `[title](https://...)`",
                )
            raise _line_error(line_number, "malformed primary Markdown link; expected `[title](URL)`")
        return None
    destination_end = _scan_destination(content, label_end + 2)
    if destination_end is None:
        if strict:
            raise _line_error(line_number, "primary Markdown link has an unclosed URL")
        return None
    label = content[index + 1 : label_end]
    if re.search(r"(?<!\\)\]\(", label):
        raise _line_error(line_number, "nested links are not supported in link text")
    return label, content[label_end + 2 : destination_end], destination_end + 1


def _destination_to_url(destination: str, line_number: int) -> str:
    if destination.startswith("<"):
        raise _line_error(
            line_number,
            "angle-bracket link destinations are unsupported; write the URL directly: `[title](https://...)`",
        )
    if any(character.isspace() for character in destination):
        raise _line_error(
            line_number,
            f"URL `{destination}` contains whitespace; link titles (`\"...\"`) are not supported",
        )
    url = _decode(destination, line_number, "destination")
    if not url:
        raise _line_error(line_number, "Markdown link URL must not be empty")
    if len(url) > MAX_URL_LENGTH:
        raise _line_error(line_number, f"URL is longer than {MAX_URL_LENGTH} characters")
    return url


def _parse_description(text: str, line_number: int) -> list[dict[str, str]]:
    """Split a description into plain-text and link segments."""

    parts: list[dict[str, str]] = []
    run: list[str] = []

    def flush() -> None:
        if run:
            decoded = _decode("".join(run), line_number, "text")
            if decoded:
                parts.append({"text": decoded})
            run.clear()

    index = 0
    while index < len(text):
        character = text[index]
        if character == "\\":
            run.append(text[index : index + 2])
            index += 2
            continue
        if text.startswith("![", index):
            raise _line_error(
                line_number,
                "unsupported image/badge syntax; only `![NEW](badges/new.svg)` and "
                "`![RECENT](badges/recent.svg)` are supported",
            )
        if character == "[":
            link = _read_link(text, index, line_number, strict=False)
            if link is not None:
                label, destination, next_index = link
                flush()
                link_text = _plain_text(label, line_number, "description link text", MAX_DESCRIPTION_LENGTH)
                url = _destination_to_url(destination, line_number)
                try:
                    normalize_url(url)
                except ValueError as error:
                    raise _line_error(
                        line_number, f"invalid link URL `{url}` in description: {error}"
                    ) from error
                parts.append({"text": link_text, "url": url})
                index = next_index
                continue
        run.append(character)
        index += 1
    flush()

    if parts and "url" not in parts[0]:
        parts[0]["text"] = parts[0]["text"].lstrip()
    if parts and "url" not in parts[-1]:
        parts[-1]["text"] = parts[-1]["text"].rstrip()
    parts = [part for part in parts if part["text"]]
    if sum(len(part["text"]) for part in parts) > MAX_DESCRIPTION_LENGTH:
        raise _line_error(line_number, f"description is longer than {MAX_DESCRIPTION_LENGTH} characters")
    return parts


def _iter_images(text: str) -> Iterator[tuple[int, re.Match[str] | None]]:
    """Yield ``(index, match)`` for every *unescaped* ``![``.

    ``match`` is ``None`` when the text is not a complete ``![alt](dest)`` image.
    A backslash escapes the next character, so ``\\![NEW](...)`` is a literal
    exclamation mark followed by an ordinary link, not an image.
    """

    index = 0
    while index < len(text):
        if text[index] == "\\":
            index += 2
        elif text.startswith("![", index):
            match = IMAGE_PATTERN.match(text, index)
            yield index, match
            index = match.end() if match else index + 2
        else:
            index += 1


def _extract_badges(remainder: str, line_number: int) -> tuple[str, list[str]]:
    """Remove the trailing NEW/RECENT badge images from an entry's remainder.

    Badges are only recognized as unescaped images at the end of the line, after
    the description. Anything else that looks like an image is an error.
    """

    supported = " and ".join(f"`![{name}]({path})`" for name, path in BADGES.items())
    badges: list[str] = []
    text_end = len(remainder)  # end of the description text (start of the first badge)
    cursor: int | None = None  # end of the previous badge
    for index, match in _iter_images(remainder):
        if match is None:
            raise _line_error(line_number, f"unsupported image/badge syntax; only {supported} are supported")
        label, asset = match.groups()
        if BADGES.get(label) != asset:
            raise _line_error(
                line_number, f"unsupported image/badge syntax `{match.group(0)}`; only {supported} are supported"
            )
        if cursor is None:
            text_end = index
        elif remainder[cursor:index].strip():
            raise _line_error(line_number, "badges must be at the end of the line, after the description")
        if label in badges:
            raise _line_error(line_number, f"duplicate `{label}` badge")
        badges.append(label)
        cursor = match.end()
    if cursor is not None and remainder[cursor:].strip():
        raise _line_error(line_number, "badges must be at the end of the line, after the description")
    if len(badges) > 1:
        raise _line_error(
            line_number, "an entry cannot have both `NEW` and `RECENT` badges; RECENT replaces NEW"
        )
    return remainder[:text_end], badges


def _parse_entry(
    line: str, line_number: int, category: str, category_slug: str
) -> dict[str, object]:
    match = LIST_ITEM_PATTERN.match(line)
    if not match:
        raise _line_error(line_number, "expected a Markdown list item")
    content = match.group(1)
    if not content.startswith("["):
        raise _line_error(
            line_number,
            "catalog list items must begin with a primary Markdown link: "
            "`- [Project title](https://...)`",
        )
    link = _read_link(content, 0, line_number, strict=True)
    if link is None:  # strict reads raise instead; this keeps the type checker honest
        raise _line_error(line_number, "malformed primary Markdown link; expected `[title](URL)`")
    label, destination, next_index = link
    title = _plain_text(label, line_number, "link title", MAX_TITLE_LENGTH)
    raw_url = _destination_to_url(destination, line_number)
    try:
        url = normalize_url(raw_url)
    except ValueError as error:
        raise _line_error(line_number, f"invalid project URL `{raw_url}`: {error}") from error

    remainder, badges = _extract_badges(content[next_index:], line_number)
    remainder = re.sub(r"[ \t]+", " ", remainder).strip(" ")

    parts: list[dict[str, str]] = []
    if remainder:
        separator = re.match(r"^(?:[—–] *|- +|-$)", remainder)
        if not separator:
            raise _line_error(
                line_number,
                "description must follow the project link after an em dash or en dash, "
                "or after a hyphen followed by a space",
            )
        parts = _parse_description(remainder[separator.end() :], line_number)

    return {
        "id": project_id(url),
        "category": category,
        "category_slug": category_slug,
        "title": title,
        "url": url,
        "description": "".join(part["text"] for part in parts),
        "description_parts": parts,
        "badges": badges,
    }


def _slugify(name: str) -> str:
    return re.sub(r"[^\w]+", "-", name.casefold()).strip("-_")


def _split_lines(text: str) -> list[str]:
    """Split on newlines only, so reported line numbers match GitHub's."""

    return text.removeprefix("\ufeff").replace("\r\n", "\n").replace("\r", "\n").split("\n")


def _opening_fence(line: str) -> tuple[str, int] | None:
    """Return ``(character, length)`` if ``line`` opens a CommonMark fenced code block."""

    match = FENCE_OPEN_PATTERN.match(line)
    if not match:
        return None
    marker, info = match.groups()
    if marker[0] == "`" and "`" in info:  # a backtick fence's info string cannot contain backticks
        return None
    return marker[0], len(marker)


def _closes_fence(line: str, fence: tuple[str, int]) -> bool:
    """A closing fence: at most three spaces of indent, the same character, at least as long, nothing else."""

    match = FENCE_CLOSE_PATTERN.match(line)
    return bool(match) and match.group(1)[0] == fence[0] and len(match.group(1)) >= fence[1]


def locate_catalog(lines: list[str]) -> tuple[int, int, list[int]]:
    """Return the marker line indexes and the non-fenced lines outside the catalog.

    Markers inside fenced code blocks are examples and are ignored. A fence that is
    never closed runs to the end of the document, as in CommonMark.
    """

    start: int | None = None
    end: int | None = None
    fence: tuple[str, int] | None = None
    outside: list[int] = []

    for index, line in enumerate(lines):
        number = index + 1
        if start is not None and end is None:
            marker = MARKER_PATTERN.match(line)
            if marker:
                if marker.group(1) == CATALOG_END:
                    end = index
                else:
                    raise _line_error(
                        number, f"found `<!-- {CATALOG_START} -->` again before `<!-- {CATALOG_END} -->`"
                    )
            continue

        if fence is not None:
            if _closes_fence(line, fence):
                fence = None
            continue
        opening = _opening_fence(line)
        if opening:
            fence = opening
            continue

        marker = MARKER_PATTERN.match(line)
        if marker:
            if marker.group(1) == CATALOG_START:
                if start is not None:
                    raise _line_error(
                        number, f"only one catalog region is supported; `<!-- {CATALOG_START} -->` repeats"
                    )
                start = index
            elif start is None:
                raise _line_error(number, f"`<!-- {CATALOG_END} -->` appears before `<!-- {CATALOG_START} -->`")
            else:
                raise _line_error(
                    number, f"only one catalog region is supported; `<!-- {CATALOG_END} -->` repeats"
                )
            continue
        outside.append(index)

    if start is None:
        raise CatalogError(
            f"could not find `<!-- {CATALOG_START} -->`; the project catalog must be wrapped in "
            f"`<!-- {CATALOG_START} -->` and `<!-- {CATALOG_END} -->` comments"
        )
    if end is None:
        raise CatalogError(
            f"`<!-- {CATALOG_START} -->` (line {start + 1}) has no matching `<!-- {CATALOG_END} -->`"
        )
    return start, end, outside


def _has_catalog_badge(line: str) -> bool:
    for _, match in _iter_images(line):
        if match is not None and match.group(1).upper() in BADGES and match.group(2).lower().startswith("badges/"):
            return True
    return False


def _check_outside_catalog(lines: list[str], outside: list[int]) -> None:
    """Fail on project-shaped list items outside the markers, which would otherwise vanish.

    A list item (bulleted or numbered, at any nesting) is project-shaped when it
    begins with a link to an absolute http(s) URL or carries a catalog badge.
    Everything else outside the markers is ordinary README content: paragraphs,
    tables, quotes, relative or ``#anchor`` links, bullets that begin with text,
    and code (fenced, or indented four or more spaces outside a list).
    """

    in_list = False
    for index in outside:
        line = lines[index]
        if not line.strip():
            continue
        item = ANY_ITEM_PATTERN.match(line)
        if item is None:
            if not line[0].isspace():  # a paragraph, heading, table, ... ends any list
                in_list = False
            continue
        if len(item.group(1).expandtabs(4)) >= 4 and not in_list:
            continue  # indented code block, not a list item
        in_list = True
        number = index + 1
        if OUTSIDE_ENTRY_PATTERN.match(line):
            raise _line_error(
                number,
                f"project entry is outside `<!-- {CATALOG_START} -->`/`<!-- {CATALOG_END} -->` and would "
                "not be published; move it inside the catalog. (A list item outside the markers that begins "
                "with an http(s) link is treated as a project; start the bullet with text if it is not one.)",
            )
        if _has_catalog_badge(line):
            raise _line_error(
                number,
                f"list item with a NEW/RECENT badge is outside `<!-- {CATALOG_START} -->`/"
                f"`<!-- {CATALOG_END} -->` and would not be published; move it inside the catalog",
            )


def _parse_catalog(
    lines: list[str], start: int, end: int
) -> tuple[list[dict[str, str]], list[dict[str, object]]]:
    categories: list[dict[str, str]] = []
    slug_owner: dict[str, str] = {}
    projects: list[dict[str, object]] = []
    seen_urls: dict[str, int] = {}
    current: dict[str, str] | None = None

    for index in range(start + 1, end):
        line = lines[index]
        number = index + 1
        if not line.strip():
            continue

        if re.match(r"^\s+#{1,6}(?:\s|$)", line):
            raise _line_error(
                number,
                "indented headings are unsupported in the catalog; use an unindented `### Category` heading",
            )
        heading = HEADING_PATTERN.match(line)
        if heading:
            level = len(heading.group(1))
            raw_name = CLOSING_SEQUENCE_PATTERN.match(heading.group(2) or "").group(1)  # type: ignore[union-attr]
            if level != CATEGORY_LEVEL:
                raise _line_error(
                    number,
                    f"only `{'#' * CATEGORY_LEVEL}` category headings are allowed inside the catalog; "
                    f"found a level-{level} heading `{raw_name}`",
                )
            if re.search(r"\]\(", raw_name):
                raise _line_error(number, "links are not supported in category headings")
            name = _plain_text(raw_name, number, "category name", MAX_TITLE_LENGTH)
            slug = _slugify(name)
            if not slug:
                raise _line_error(number, f"category name `{name}` must contain a letter or digit")
            if slug in slug_owner:
                previous = slug_owner[slug]
                detail = (
                    f"duplicate catalog category `{name}`"
                    if previous == name
                    else f"category names `{previous}` and `{name}` produce the same slug `{slug}`"
                )
                raise _line_error(number, detail)
            slug_owner[slug] = name
            current = {"slug": slug, "name": name}
            categories.append(current)
            continue

        if THEMATIC_BREAK_PATTERN.match(line) or re.match(r"^ {0,3}=+[ \t]*$", line):
            raise _line_error(
                number,
                "horizontal rules and Setext heading underlines are unsupported inside the catalog",
            )
        if LIST_ITEM_PATTERN.match(line):
            if line[0].isspace():
                raise _line_error(
                    number,
                    "indented/nested list items are unsupported in the catalog; "
                    "place each project at the category's top level",
                )
            if current is None:
                raise _line_error(
                    number, "project entries must follow a `### Category` heading inside the catalog"
                )
            project = _parse_entry(line, number, current["name"], current["slug"])
            canonical_url = str(project["url"])
            if canonical_url in seen_urls:
                raise _line_error(
                    number,
                    f"duplicate canonical project URL `{canonical_url}`; "
                    f"first listed on line {seen_urls[canonical_url]}",
                )
            seen_urls[canonical_url] = number
            projects.append(project)
        elif NUMBERED_ITEM_PATTERN.match(line):
            raise _line_error(
                number, "numbered lists are not supported for catalog entries; use `- [title](URL)`"
            )
        elif index + 1 < end and SETEXT_UNDERLINE_PATTERN.match(lines[index + 1]):
            raise _line_error(
                number,
                "Setext headings are unsupported in the catalog; use a `### Category` heading",
            )
        else:
            raise _line_error(
                number,
                "unsupported content in the catalog; descriptions must stay on the same "
                "list-item line as `- [title](URL)`. Wrapped/indented descriptions, comments, and "
                "other prose are rejected to prevent silently lost text.",
            )

    if not categories:
        raise CatalogError("the catalog contains no `### Category` headings", start + 1)
    if not projects:
        raise CatalogError("the catalog contains no project entries", start + 1)
    return categories, projects


def parse_readme(text: str) -> dict[str, object]:
    """Parse the README catalog and return the versioned catalog object."""

    lines = _split_lines(text)
    start, end, outside = locate_catalog(lines)
    _check_outside_catalog(lines, outside)
    categories, projects = _parse_catalog(lines, start, end)
    return {
        "schema_version": SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "identity_version": IDENTITY_VERSION,
        "categories": categories,
        "projects": projects,
    }


def render_catalog(catalog: dict[str, object]) -> str:
    """Serialize the catalog as stable, UTF-8-friendly JSON."""

    return json.dumps(catalog, ensure_ascii=False, indent=2) + "\n"


def _escape_annotation_data(value: str) -> str:
    return value.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_annotation_property(value: str) -> str:
    return _escape_annotation_data(value).replace(":", "%3A").replace(",", "%2C")


def format_diagnostic(kind: str, path: str, line: int | None, message: str, style: str) -> str:
    """Format a diagnostic as plain text or a GitHub Actions annotation."""

    if style == "github":
        properties = f"file={_escape_annotation_property(path)}"
        if line:
            properties += f",line={line}"
        return f"::{kind} {properties},title=README catalog::{_escape_annotation_data(message)}"
    return format_location(path, line, message)


def _read_readme(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as error:
        raise CatalogError(f"{path.name} is not valid UTF-8: {error}") from error


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate the project catalog JSON from the README.")
    parser.add_argument("--readme", type=Path, default=Path("README.md"))
    parser.add_argument(
        "--output",
        type=Path,
        required=True,
        help="catalog JSON path (must end in .json); treated as disposable: replaced on success, "
        "deleted if generation fails so a stale catalog can never be mistaken for a current one",
    )
    parser.add_argument(
        "--format", choices=("text", "github"), default="text", dest="style", help="error output style"
    )
    args = parser.parse_args(argv)

    readme_label = args.readme.as_posix()
    if args.output.suffix.lower() != ".json":
        print(f"--output must be a .json file, got `{args.output}`", file=sys.stderr)
        return 2
    if args.output.resolve() == args.readme.resolve():
        print("--output must not be the README file", file=sys.stderr)
        return 2

    try:
        catalog = parse_readme(_read_readme(args.readme))
        rendered = render_catalog(catalog)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=args.output.parent,
                prefix=f".{args.output.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                temporary_path = Path(temporary_file.name)
                temporary_file.write(rendered)
            os.replace(temporary_path, args.output)
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
    except (OSError, CatalogError) as error:
        try:
            args.output.unlink(missing_ok=True)
        except OSError as cleanup_error:
            print(f"Could not remove stale catalog output: {cleanup_error}", file=sys.stderr)
        if isinstance(error, CatalogError):
            print(format_diagnostic("error", readme_label, error.line, error.message, args.style), file=sys.stderr)
        else:
            print(error, file=sys.stderr)
        return 1

    projects = catalog["projects"]
    categories = catalog["categories"]
    print(
        f"Generated {len(projects)} projects in {len(categories)} categories: {args.output}"  # type: ignore[arg-type]
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
