#!/usr/bin/env python3
"""Generate a deterministic CycloneDX inventory from Restork lock files."""

from __future__ import annotations

import argparse
import json
import os
import tomllib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


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


def _cargo_components(path: Path) -> list[dict[str, str]]:
    document = tomllib.loads(path.read_text(encoding="utf-8"))
    return [
        _component("cargo", package["name"], package["version"])
        for package in document.get("package", [])
        if isinstance(package.get("name"), str) and isinstance(package.get("version"), str)
    ]


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
    document = tomllib.loads(path.read_text(encoding="utf-8"))
    return [
        _component("pypi", package["name"], package["version"])
        for package in document.get("package", [])
        if isinstance(package.get("name"), str) and isinstance(package.get("version"), str)
    ]


def _timestamp() -> str:
    source_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if source_epoch is not None:
        instant = datetime.fromtimestamp(int(source_epoch), UTC)
    else:
        instant = datetime.now(UTC)
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
