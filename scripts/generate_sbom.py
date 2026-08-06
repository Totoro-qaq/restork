#!/usr/bin/env python3
"""Generate a deterministic CycloneDX inventory from Restork lock files."""

from __future__ import annotations

import argparse
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--output", type=Path, required=True)
    return parser


def _component(ecosystem: str, name: str, version: str) -> dict[str, str]:
    return {
        "type": "library",
        "name": name,
        "version": version,
        "bom-ref": f"pkg:{ecosystem}/{name}@{version}",
        "purl": f"pkg:{ecosystem}/{name}@{version}",
    }


_LOCK_VALUE = re.compile(r'^\s*(name|version)\s*=\s*"([^"\\]*)"\s*$')


def _locked_package_components(path: Path, ecosystem: str) -> list[dict[str, str]]:
    """Read only the bounded name/version subset shared by Cargo and uv locks.

    Release helpers run with the Python bundled by each CI host, including
    macOS Python 3.9 where ``tomllib`` is unavailable. Lockfile package names
    and versions are plain quoted strings, so a deliberately narrow parser is
    both sufficient and safer than accepting arbitrary TOML here.
    """

    components: list[dict[str, str]] = []
    package: Optional[dict[str, str]] = None
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip() == "[[package]]":
            if package is not None and {"name", "version"} <= package.keys():
                components.append(_component(ecosystem, package["name"], package["version"]))
            package = {}
            continue
        if package is None:
            continue
        match = _LOCK_VALUE.fullmatch(line)
        if match is not None:
            package[match.group(1)] = match.group(2)
    if package is not None and {"name", "version"} <= package.keys():
        components.append(_component(ecosystem, package["name"], package["version"]))
    return components


def _cargo_components(path: Path) -> list[dict[str, str]]:
    return _locked_package_components(path, "cargo")


def _npm_components(path: Path) -> list[dict[str, str]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    components: list[dict[str, str]] = []
    for location, package in document.get("packages", {}).items():
        if not location or not isinstance(package, dict):
            continue
        name = package.get("name")
        version = package.get("version")
        if not isinstance(name, str):
            name = location.rsplit("node_modules/", 1)[-1]
        if isinstance(version, str) and name:
            components.append(_component("npm", name, version))
    return components


def _python_components(path: Path) -> list[dict[str, str]]:
    return _locked_package_components(path, "pypi")


def _timestamp() -> str:
    source_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if source_epoch is not None:
        instant = datetime.fromtimestamp(int(source_epoch), timezone.utc)
    else:
        instant = datetime.now(timezone.utc)
    return instant.isoformat().replace("+00:00", "Z")


def generate(root: Path) -> dict[str, Any]:
    components = _cargo_components(root / "rust" / "Cargo.lock")
    components.extend(_npm_components(root / "dashboard" / "package-lock.json"))
    components.extend(_npm_components(root / "desktop" / "package-lock.json"))
    components.extend(_python_components(root / "uv.lock"))
    unique = {component["bom-ref"]: component for component in components}
    ordered = [unique[key] for key in sorted(unique)]
    identity = "\n".join(component["bom-ref"] for component in ordered)
    return {
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "serialNumber": f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, identity)}",
        "version": 1,
        "metadata": {
            "timestamp": _timestamp(),
            "component": {
                "type": "application",
                "name": "restork",
                "version": "0.1.2",
                "bom-ref": "pkg:github/Totoro-qaq/restork@0.1.2",
            },
            "properties": [
                {"name": "restork:git_commit", "value": os.environ.get("GITHUB_SHA", "local")},
                {"name": "restork:source", "value": "checked-in lock files"},
            ],
        },
        "components": ordered,
    }


def main() -> int:
    arguments = _parser().parse_args()
    payload = generate(arguments.root.resolve())
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
