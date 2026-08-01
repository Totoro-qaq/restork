"""Safe discovery of user-selected Markdown vaults, without mutation."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path

_DENIED_PATH_PARTS = frozenset({".git", ".obsidian", "artifacts", "cache", "indexes", "secrets"})


class VaultPathError(ValueError):
    """Raised when a selected vault root or note path is unsafe."""


@dataclass(frozen=True)
class VaultNote:
    """A Markdown source with a stable relative identity and immutable snapshot."""

    relative_path: str
    content: str
    content_hash: str


class Vault:
    """Read-only vault boundary that never follows symlinks or hidden app state."""

    def __init__(self, root: Path) -> None:
        resolved = root.expanduser().resolve(strict=True)
        if not resolved.is_dir():
            raise VaultPathError("vault root must be an existing directory")
        self._root = resolved

    @property
    def root(self) -> Path:
        return self._root

    def iter_notes(self) -> list[VaultNote]:
        notes: list[VaultNote] = []
        for candidate in sorted(self._root.rglob("*.md")):
            if candidate.is_symlink() or not candidate.is_file():
                continue
            relative = candidate.relative_to(self._root)
            if _is_denied(relative):
                continue
            resolved = candidate.resolve(strict=True)
            if not resolved.is_relative_to(self._root):
                continue
            content = candidate.read_text(encoding="utf-8")
            notes.append(
                VaultNote(
                    relative_path=relative.as_posix(),
                    content=content,
                    content_hash=sha256(content.encode("utf-8")).hexdigest(),
                )
            )
        return notes

    def read_note(self, relative_path: str) -> VaultNote:
        candidate = self._resolve_note_path(relative_path)
        content = candidate.read_text(encoding="utf-8")
        return VaultNote(
            relative_path=candidate.relative_to(self._root).as_posix(),
            content=content,
            content_hash=sha256(content.encode("utf-8")).hexdigest(),
        )

    def _resolve_note_path(self, relative_path: str) -> Path:
        path = Path(relative_path)
        if path.is_absolute() or _is_denied(path) or path.suffix.lower() != ".md":
            raise VaultPathError("unsupported vault note path")
        candidate = self._root / path
        if candidate.is_symlink() or not candidate.is_file():
            raise VaultPathError("vault note must be a regular Markdown file")
        resolved = candidate.resolve(strict=True)
        if not resolved.is_relative_to(self._root):
            raise VaultPathError("vault note escapes the configured root")
        return candidate


def _is_denied(path: Path) -> bool:
    return any(part.casefold() in _DENIED_PATH_PARTS for part in path.parts)
