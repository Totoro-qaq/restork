"""Fail-closed resolution for explicitly selected private local files."""

from __future__ import annotations

from pathlib import Path


def resolve_private_file(
    value: str,
    *,
    base: Path,
    suffixes: frozenset[str],
    maximum_bytes: int = 2_000_000,
) -> Path:
    if not value.strip():
        raise ValueError("private file path is empty")
    selected = Path(value).expanduser()
    if selected.is_absolute():
        candidate = selected
    else:
        if ".." in selected.parts:
            raise ValueError("relative private file path cannot traverse parents")
        candidate = base / selected
    if candidate.suffix.casefold() not in suffixes:
        raise ValueError("private file type is not supported")
    if candidate.is_symlink() or not candidate.is_file():
        raise ValueError("private source must be a regular non-symlink file")
    resolved = candidate.resolve(strict=True)
    if resolved != candidate.absolute():
        raise ValueError("private source path cannot contain symlinks")
    if not selected.is_absolute() and not resolved.is_relative_to(base.resolve()):
        raise ValueError("relative private source escapes its profile directory")
    if resolved.stat().st_size > maximum_bytes:
        raise ValueError("private source exceeds its size budget")
    return resolved


def resolve_cover_file(value: str, *, playlist: Path) -> tuple[Path, str]:
    selected = Path(value)
    if selected.is_absolute() or ".." in selected.parts:
        raise ValueError("cover path must stay relative to the playlist")
    candidate = playlist.parent / selected
    if candidate.is_symlink() or not candidate.is_file():
        raise ValueError("cover must be a regular non-symlink file")
    resolved = candidate.resolve(strict=True)
    if resolved != candidate.absolute() or not resolved.is_relative_to(playlist.parent.resolve()):
        raise ValueError("cover path escapes the playlist directory")
    media_types = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
    }
    if resolved.stat().st_size > 5_000_000:
        raise ValueError("cover exceeds its size budget")
    try:
        return resolved, media_types[resolved.suffix.casefold()]
    except KeyError as error:
        raise ValueError("cover must be PNG, JPEG, or WebP") from error
