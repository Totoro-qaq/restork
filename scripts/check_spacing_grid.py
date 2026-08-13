#!/usr/bin/env python3
"""Fail when dashboard/src/styles.css layout spacing leaves the 4px grid.

Only margin / padding / gap (and their longhands) are scanned. Border,
outline, shadow, hairline, and scrollbar metrics are out of scope.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STYLES = ROOT / "dashboard/src/styles.css"

LAYOUT_DECL = re.compile(
    r"(?<![\w-])(?P<prop>(?:margin|padding|gap|row-gap|column-gap)"
    r"(?:-(?:top|right|bottom|left|block|inline|block-start|block-end|"
    r"inline-start|inline-end))?)\s*:\s*(?P<val>[^;{}]+);",
    re.IGNORECASE,
)
PX = re.compile(r"(?<![\w.-])(\d+)px")

# Each exemption is a substring of the declaration value plus the reason it
# may leave the 4px grid. Keep this list empty unless a specific optical
# exception is documented here.
EXEMPTIONS: list[tuple[str, str]] = []


def strip_comments(source: str) -> str:
    return re.sub(r"/\*.*?\*/", "", source, flags=re.S)


def is_exempt(prop: str, value: str, px: int) -> str | None:
    blob = f"{prop}:{value}"
    for needle, reason in EXEMPTIONS:
        if needle in blob:
            return reason
    return None


def spacing_issues(source: str, label: str = "dashboard/src/styles.css") -> list[str]:
    text = strip_comments(source)
    issues: list[str] = []
    for match in LAYOUT_DECL.finditer(text):
        prop = match.group("prop")
        value = match.group("val")
        for px_match in PX.finditer(value):
            px = int(px_match.group(1))
            if px % 4 == 0:
                continue
            reason = is_exempt(prop, value, px)
            if reason:
                continue
            snippet = re.sub(r"\s+", " ", f"{prop}: {value.strip()}")[:120]
            issues.append(f"{label}: {snippet} → {px}px is off the 4px grid")
    return issues


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if argv:
        print("check_spacing_grid.py does not accept file paths", file=sys.stderr)
        return 2
    source = STYLES.read_text(encoding="utf-8")
    issues = spacing_issues(source)

    if issues:
        print("\n".join(issues), file=sys.stderr)
        print(f"{len(issues)} spacing-grid violation(s)", file=sys.stderr)
        return 1
    print("spacing grid ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
