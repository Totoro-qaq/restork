from __future__ import annotations

import subprocess
from pathlib import Path


def test_public_artifact_scan_rejects_a_synthetic_credential(tmp_path: Path) -> None:
    scanner = Path(__file__).parents[1] / "scripts" / "scan-public-artifacts.sh"
    synthetic_credential = "-".join(["sk", "abcdefghijklmnopqrstuvwx"])
    (tmp_path / "credential.md").write_text(synthetic_credential, encoding="utf-8")

    result = subprocess.run(
        ["bash", str(scanner)],
        capture_output=True,
        check=False,
        cwd=tmp_path,
        text=True,
    )

    assert result.returncode == 1
    assert "possible credential material" in result.stderr
