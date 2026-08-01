"""Parser for explicit Obsidian wiki links; it never infers relationships."""

from __future__ import annotations

import re

_WIKI_LINK = re.compile(r"\[\[(?P<target>[^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")


def extract_wiki_links(markdown: str) -> tuple[str, ...]:
    """Return normalized link targets in source order, preserving duplicates."""
    return tuple(match.group("target").strip() for match in _WIKI_LINK.finditer(markdown))
