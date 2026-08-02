from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from restork.desktop import write_desktop_bootstrap


def test_desktop_bootstrap_is_atomic_owner_only_and_non_replacing(
    tmp_path: Path,
) -> None:
    private = tmp_path / "bootstrap"
    private.mkdir(mode=0o700)
    private.chmod(0o700)
    target = private / "core.json"

    write_desktop_bootstrap(target, port=49152, pairing_code="p" * 32)

    payload = json.loads(target.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["port"] == 49152
    assert payload["pairing_code"] == "p" * 32
    assert payload["pid"] > 0
    assert payload["issued_at"].endswith("+00:00")
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert list(private.glob("*.tmp")) == []

    with pytest.raises(FileExistsError):
        write_desktop_bootstrap(target, port=49152, pairing_code="q" * 32)
    assert json.loads(target.read_text(encoding="utf-8"))["pairing_code"] == "p" * 32


def test_desktop_bootstrap_rejects_insecure_parent(tmp_path: Path) -> None:
    insecure = tmp_path / "insecure"
    insecure.mkdir(mode=0o755)
    insecure.chmod(0o755)

    with pytest.raises(PermissionError, match="0700"):
        write_desktop_bootstrap(
            insecure / "core.json",
            port=49152,
            pairing_code="p" * 32,
        )
