#!/usr/bin/env python3
"""Classify changed paths into the heavyweight CI lanes they can affect."""

from __future__ import annotations

import argparse
from pathlib import PurePosixPath
import sys
from typing import Iterable


LANES = ("rust", "dashboard", "desktop", "dependency")


def _is_lightweight(path: str) -> bool:
    root_names = (
        "README",
        "CHANGELOG",
        "SECURITY",
        "CODE_OF_CONDUCT",
        "CONTRIBUTING",
        "LICENSE",
    )
    if path in {".gitignore", ".gitattributes", ".editorconfig"}:
        return True
    if path.startswith(("site/", "docs/", "plans/", "assets/", "research/")):
        return True
    if path.startswith((".github/ISSUE_TEMPLATE/", ".github/PULL_REQUEST_TEMPLATE")):
        return True
    return path.startswith(root_names)


def classify_paths(paths: Iterable[str], *, force_all: bool = False) -> dict[str, bool]:
    normalized = [PurePosixPath(path).as_posix().removeprefix("./") for path in paths if path]
    result = {lane: False for lane in LANES}
    if force_all:
        return {lane: True for lane in LANES}
    run_all = not normalized

    for path in normalized:
        if path.startswith(".github/workflows/"):
            # Workflow changes exercise every non-packaging verification lane.
            run_all = True
            result["dependency"] = True
        elif path.startswith("scripts/"):
            # Executable-script changes exercise all compile/test lanes.
            run_all = True
        elif path.startswith("rust/") or path in {"rust-toolchain.toml", "deny.toml"}:
            result["rust"] = True
            if path.endswith(("Cargo.toml", "Cargo.lock")) or path == "deny.toml":
                result["dependency"] = True
        elif path.startswith(".cargo/"):
            result["rust"] = True
            result["dependency"] = True
        elif path.startswith("dashboard/"):
            result["dashboard"] = True
        elif path.startswith("desktop/"):
            result["desktop"] = True
            if path.endswith(("Cargo.toml", "Cargo.lock")):
                result["dependency"] = True
        elif _is_lightweight(path):
            # Public copy uses the always-on contract and boundary scans.
            continue
        else:
            # Unknown root/build paths may affect more than one package.
            run_all = True

    if run_all:
        result.update({lane: True for lane in ("rust", "dashboard", "desktop")})
    return result


def _read_nul_paths() -> list[str]:
    return [part.decode("utf-8", errors="surrogateescape") for part in sys.stdin.buffer.read().split(b"\0") if part]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="require every heavyweight lane")
    args = parser.parse_args()

    result = classify_paths(_read_nul_paths(), force_all=args.all)
    for lane in LANES:
        value = str(result[lane]).lower()
        print(f"{lane}={value}")
        print(f"{lane.capitalize()} lane: {value}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
