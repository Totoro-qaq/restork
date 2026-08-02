from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


def test_checked_in_locks_generate_a_deterministic_cyclonedx_inventory(
    tmp_path: Path,
) -> None:
    root = Path(__file__).parents[2]
    first = tmp_path / "first.cdx.json"
    second = tmp_path / "second.cdx.json"
    environment = {**os.environ, "SOURCE_DATE_EPOCH": "1785600000", "GITHUB_SHA": "a" * 40}
    for output in (first, second):
        subprocess.run(
            [
                sys.executable,
                str(root / "scripts" / "generate_sbom.py"),
                "--root",
                str(root),
                "--output",
                str(output),
            ],
            check=True,
            env=environment,
        )
    assert first.read_bytes() == second.read_bytes()
    payload = json.loads(first.read_text(encoding="utf-8"))
    assert payload["bomFormat"] == "CycloneDX"
    assert payload["specVersion"] == "1.5"
    purls = {component["purl"] for component in payload["components"]}
    assert any(purl.startswith("pkg:cargo/axum@") for purl in purls)
    assert any(purl.startswith("pkg:npm/vite@") for purl in purls)
    assert any(purl.startswith("pkg:pypi/fastapi@") for purl in purls)
