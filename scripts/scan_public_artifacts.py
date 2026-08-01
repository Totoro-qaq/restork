#!/usr/bin/env python3
"""Fail a release when tracked files or Git history contain private material."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

_EXCLUDED_PARTS = {".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".venv"}
_EXCLUDED_PREFIXES = {"dashboard/node_modules/", "dashboard/dist/", "dist/", "build/"}
_PRIVATE_SUFFIXES = {
    ".db",
    ".har",
    ".ics",
    ".key",
    ".log",
    ".pem",
    ".sqlite",
    ".sqlite3",
    ".trace",
    ".zip",
}
_PRIVATE_NAMES = {".env", "playlist.csv", "playlist.json", "profile.toml"}
_PUBLIC_RASTERS = {
    "assets/readme/demo-hd.gif",
    "assets/readme/demo-poster.webp",
}
_PLACEHOLDER_USERS = {"demo", "example", "name", "user", "username"}
_CREDENTIAL = re.compile(
    rb"(?:gh[pous]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|"
    rb"DEEPSEEK_API_KEY[ \t]*=)"
)
_ABSOLUTE_HOME = re.compile(
    rb"(?:/Users/|/home/)([A-Za-z0-9._-]+)(?=[/\\\s'\"`]|$)|"
    rb"[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)(?=[\\\s'\"`]|$)",
    re.IGNORECASE,
)


def _git_output(*arguments: str) -> bytes | None:
    result = subprocess.run(
        ["git", *arguments],
        capture_output=True,
        check=False,
    )
    return result.stdout if result.returncode == 0 else None


def _tracked_paths(root: Path) -> tuple[Path, ...]:
    payload = _git_output("ls-files", "-z")
    if payload is not None:
        return tuple(
            root / entry.decode("utf-8", errors="surrogateescape")
            for entry in payload.split(b"\0")
            if entry
        )
    return tuple(
        path
        for path in root.rglob("*")
        if path.is_file()
        and not (_EXCLUDED_PARTS & set(path.relative_to(root).parts))
        and not any(
            path.relative_to(root).as_posix().startswith(prefix)
            for prefix in _EXCLUDED_PREFIXES
        )
    )


def _path_issues(relative: str) -> list[str]:
    path = Path(relative)
    issues: list[str] = []
    if path.suffix.casefold() in _PRIVATE_SUFFIXES:
        issues.append("private runtime or archive file is tracked")
    if path.name.casefold() in _PRIVATE_NAMES:
        issues.append("private configuration or source file is tracked")
    if path.suffix.casefold() in {".gif", ".jpeg", ".jpg", ".png", ".webp"}:
        if not any(
            relative == public or relative.endswith("/" + public)
            for public in _PUBLIC_RASTERS
        ):
            issues.append("undocumented raster or screenshot is tracked")
    return issues


def _content_issues(payload: bytes) -> list[str]:
    issues: list[str] = []
    if _CREDENTIAL.search(payload):
        issues.append("possible credential material")
    for match in _ABSOLUTE_HOME.finditer(payload):
        username = next(group for group in match.groups() if group is not None)
        if username.decode("ascii", errors="ignore").casefold() not in _PLACEHOLDER_USERS:
            issues.append("absolute personal home path")
            break
    return issues


def _history_issues() -> list[str]:
    payload = _git_output("log", "-p", "--all", "--", ".")
    if payload is None:
        return []
    return [f"Git history: {issue}" for issue in _content_issues(payload)]


def main() -> int:
    root = Path.cwd().resolve()
    issues: list[str] = []
    for path in _tracked_paths(root):
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if any(relative.startswith(prefix) for prefix in _EXCLUDED_PREFIXES):
            continue
        issues.extend(f"{relative}: {issue}" for issue in _path_issues(relative))
        try:
            payload = path.read_bytes()
        except OSError:
            issues.append(f"{relative}: tracked file could not be read")
            continue
        issues.extend(f"{relative}: {issue}" for issue in _content_issues(payload))
    issues.extend(_history_issues())

    # A release scan must not depend on a developer-specific username setting.
    os.environ.pop("USER", None)
    if issues:
        print("error: public artifact boundary failed:", file=sys.stderr)
        for issue in sorted(set(issues)):
            print(f"- {issue}", file=sys.stderr)
        return 1
    print("OK: tracked worktree and full Git history contain public/synthetic data only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
