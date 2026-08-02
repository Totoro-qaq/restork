from __future__ import annotations

import json
import subprocess
import sys
import tarfile
from pathlib import Path


def test_release_artifacts_are_reproducible_public_and_complete(tmp_path: Path) -> None:
    root = Path(__file__).parents[2]
    output = tmp_path / "release"
    result = subprocess.run(
        [
            sys.executable,
            str(root / "scripts" / "build_release.py"),
            "--output",
            str(output),
        ],
        capture_output=True,
        check=False,
        cwd=root,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    manifest = json.loads((output / "release-manifest.json").read_text(encoding="utf-8"))
    assert manifest["reproducible"] is True
    assert len(manifest["source_commit"]) == 40
    assert {item["name"].rsplit(".", maxsplit=1)[-1] for item in manifest["artifacts"]} == {
        "gz",
        "whl",
    }
    checksums = (output / "SHA256SUMS").read_text(encoding="utf-8")
    assert all(item["sha256"] in checksums for item in manifest["artifacts"])

    source_archive = next(output.glob("*.tar.gz"))
    with tarfile.open(source_archive, "r:gz") as archive:
        names = archive.getnames()
    assert any(name.endswith("assets/readme/hero.svg") for name in names)
    assert any(name.endswith("assets/readme/hero.zh-CN.svg") for name in names)
    assert any(name.endswith("assets/readme/architecture.zh-CN.svg") for name in names)
    assert any(name.endswith("assets/readme/demo-hd.gif") for name in names)
    assert any(name.endswith("assets/readme/demo-hd.zh-CN.gif") for name in names)
    assert any(name.endswith("assets/readme/demo-poster.zh-CN.webp") for name in names)
    assert any(name.endswith("README.zh-CN.md") for name in names)
    assert not any("design/" in name or name.endswith(".db") for name in names)
