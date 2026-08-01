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
        env={"PATH": "/usr/bin:/bin"},
        text=True,
    )

    assert result.returncode == 1
    assert "possible credential material" in result.stderr


def test_oss_clean_001_rejects_private_paths_runtime_files_and_screenshots(
    tmp_path: Path,
) -> None:
    scanner = Path(__file__).parents[1] / "scripts" / "scan-public-artifacts.sh"
    cases = {
        "note.md": "/".join(("", "Users", "private-owner", "vault", "note.md")),
        "state.db": "synthetic state",
        "capture.png": "synthetic capture",
        "playlist.json": "[]",
    }

    for name, content in cases.items():
        case_root = tmp_path / name.replace(".", "-")
        case_root.mkdir()
        (case_root / name).write_text(content, encoding="utf-8")
        result = subprocess.run(
            ["bash", str(scanner)],
            capture_output=True,
            check=False,
            cwd=case_root,
            env={"PATH": "/usr/bin:/bin"},
            text=True,
        )
        assert result.returncode == 1, name


def test_oss_clean_001_allows_documented_synthetic_placeholders(tmp_path: Path) -> None:
    scanner = Path(__file__).parents[1] / "scripts" / "scan-public-artifacts.sh"
    (tmp_path / "example.md").write_text(
        "Synthetic path: /Users/example/vault/note.md\n",
        encoding="utf-8",
    )

    result = subprocess.run(
        ["bash", str(scanner)],
        capture_output=True,
        check=False,
        cwd=tmp_path,
        env={"PATH": "/usr/bin:/bin"},
        text=True,
    )

    assert result.returncode == 0, result.stderr
