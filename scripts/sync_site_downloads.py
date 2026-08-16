#!/usr/bin/env python3
"""Point the marketing site's download links at a published Alpha tag.

The site hardcodes the current technical-preview tag in five places per
language page: the hero release note, three per-platform download URLs, and
the release/checksum links. Release automation runs this script after an
Alpha is published so the site never lags the latest build.

Usage:
    python3 scripts/sync_site_downloads.py --tag v0.1.5-alpha.4
    python3 scripts/sync_site_downloads.py --tag v0.1.5-alpha.4 --check

`--check` exits 1 when the site would change, without writing files.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

SITE_PAGES = ("site/index.html", "site/zh-CN.html")

TAG_PATTERN = r"v[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+"
VERSION_PATTERN = r"[0-9]+\.[0-9]+\.[0-9]+-alpha\.[0-9]+"

# Every rewrite is anchored to a full URL or a known markup fragment so an
# unexpected site layout fails loudly instead of rewriting the wrong text.
def _substitutions(tag: str, version: str) -> list[tuple[re.Pattern[str], str]]:
    download = f"releases/download/{tag}/Restork-{version}"
    return [
        (
            re.compile(
                rf"releases/download/{TAG_PATTERN}/Restork-{VERSION_PATTERN}"
                r"-macOS-arm64-UNSIGNED-ALPHA\.dmg"
            ),
            f"{download}-macOS-arm64-UNSIGNED-ALPHA.dmg",
        ),
        (
            re.compile(
                rf"releases/download/{TAG_PATTERN}/Restork-{VERSION_PATTERN}"
                r"-Windows-x64-UNSIGNED-ALPHA-setup\.exe"
            ),
            f"{download}-Windows-x64-UNSIGNED-ALPHA-setup.exe",
        ),
        (
            re.compile(
                rf"releases/download/{TAG_PATTERN}/Restork-{VERSION_PATTERN}"
                r"-Linux-x64-UNSIGNED-ALPHA\.AppImage"
            ),
            f"{download}-Linux-x64-UNSIGNED-ALPHA.AppImage",
        ),
        (
            re.compile(rf"releases/tag/{TAG_PATTERN}"),
            f"releases/tag/{tag}",
        ),
        (
            re.compile(rf"<strong>{TAG_PATTERN}</strong>"),
            f"<strong>{tag}</strong>",
        ),
    ]


def sync_page(path: Path, tag: str) -> tuple[str, bool]:
    """Return the page content with all Alpha references pointing at `tag`."""
    version = tag.lstrip("v")
    original = path.read_text(encoding="utf-8")
    content = original
    for pattern, replacement in _substitutions(tag, version):
        content, count = pattern.subn(replacement, content)
        if count == 0 and replacement not in content:
            raise ValueError(
                f"{path}: expected at least one match for {pattern.pattern!r}; "
                "the site layout changed — update this script with the page."
            )
    return content, content != original


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="Published Alpha tag, e.g. v0.1.5-alpha.4")
    parser.add_argument("--check", action="store_true", help="Fail if the site would change")
    args = parser.parse_args(argv)

    if not re.fullmatch(TAG_PATTERN, args.tag):
        parser.error(f"--tag must match {TAG_PATTERN}, got {args.tag!r}")

    root = Path(__file__).resolve().parent.parent
    changed: list[str] = []
    pending: list[tuple[Path, str]] = []
    for relative in SITE_PAGES:
        path = root / relative
        content, differs = sync_page(path, args.tag)
        if differs:
            changed.append(relative)
            pending.append((path, content))

    if args.check:
        if changed:
            print(f"site downloads lag {args.tag}: {', '.join(changed)}", file=sys.stderr)
            return 1
        print(f"site downloads already point at {args.tag}")
        return 0

    for path, content in pending:
        path.write_text(content, encoding="utf-8")
    if changed:
        print(f"pointed site downloads at {args.tag}: {', '.join(changed)}")
    else:
        print(f"site downloads already point at {args.tag}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
