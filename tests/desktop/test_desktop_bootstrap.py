from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from restork.desktop import write_desktop_bootstrap


def test_desktop_bootstrap_uses_a_one_shot_anonymous_pipe() -> None:
    reader, writer = os.pipe()
    write_desktop_bootstrap(writer, port=49152, pairing_code="p" * 32)
    try:
        payload = json.loads(os.read(reader, 4096))
    finally:
        os.close(reader)

    assert payload["schema_version"] == 1
    assert payload["port"] == 49152
    assert payload["pairing_code"] == "p" * 32
    assert payload["pid"] > 0
    assert payload["issued_at"].endswith("+00:00")


def test_desktop_bootstrap_rejects_and_closes_a_regular_file(tmp_path: Path) -> None:
    descriptor = os.open(tmp_path / "bootstrap.json", os.O_WRONLY | os.O_CREAT, 0o600)

    with pytest.raises(PermissionError, match="must be a pipe"):
        write_desktop_bootstrap(
            descriptor,
            port=49152,
            pairing_code="p" * 32,
        )
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_desktop_bootstrap_closes_the_pipe_when_payload_is_invalid() -> None:
    reader, writer = os.pipe()

    with pytest.raises(ValueError, match="port"):
        write_desktop_bootstrap(writer, port=0, pairing_code="p" * 32)
    try:
        assert os.read(reader, 1) == b""
    finally:
        os.close(reader)
