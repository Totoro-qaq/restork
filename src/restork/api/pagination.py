"""Small opaque cursor helpers for bounded local-list responses."""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass


@dataclass(frozen=True)
class PageWindow:
    offset: int
    limit: int


def page_window(
    *,
    scope: str,
    cursor: str | None,
    limit: int,
    maximum: int = 50,
) -> PageWindow:
    if not 1 <= limit <= maximum:
        raise ValueError(f"page limit must be between 1 and {maximum}")
    if cursor is None:
        return PageWindow(offset=0, limit=limit)
    if not 1 <= len(cursor) <= 512:
        raise ValueError("page cursor is invalid")
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
        if (
            not isinstance(payload, dict)
            or payload.get("v") != 1
            or payload.get("scope") != scope
            or not isinstance(payload.get("offset"), int)
        ):
            raise ValueError
        offset = payload["offset"]
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError) as error:
        raise ValueError("page cursor is invalid") from error
    if not 0 <= offset <= 1_000_000:
        raise ValueError("page cursor is outside the supported range")
    return PageWindow(offset=offset, limit=limit)


def page_metadata(
    *,
    scope: str,
    window: PageWindow,
    returned: int,
    has_more: bool,
) -> dict[str, object]:
    return {
        "limit": window.limit,
        "has_more": has_more,
        "next_cursor": (
            _encode_cursor(scope, window.offset + returned) if has_more else None
        ),
    }


def _encode_cursor(scope: str, offset: int) -> str:
    payload = json.dumps(
        {"v": 1, "scope": scope, "offset": offset},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")
