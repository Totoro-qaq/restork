from __future__ import annotations

import json
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).parents[2] / "scripts" / "desktop_release.py"
_SPEC = spec_from_file_location("restork_desktop_release", _SCRIPT)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError("desktop release helper could not be loaded")
_MODULE = module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MODULE)
_update_manifest = _MODULE._update_manifest
_updater_config = _MODULE._updater_config


def test_updater_config_requires_credential_free_https_and_public_material(
    tmp_path: Path,
) -> None:
    output = tmp_path / "release.json"
    with pytest.raises(ValueError, match="HTTPS"):
        _updater_config(output, public_key="R" * 64, endpoint="http://example.com/latest.json")
    with pytest.raises(ValueError, match="PUBLIC_KEY"):
        _updater_config(
            output,
            public_key="PRIVATE KEY " * 8,
            endpoint="https://example.com/latest.json",
        )

    _updater_config(
        output,
        public_key="R" * 64,
        endpoint="https://example.com/latest.json",
    )

    assert json.loads(output.read_text(encoding="utf-8")) == {
        "bundle": {"createUpdaterArtifacts": True},
        "plugins": {
            "updater": {
                "endpoints": ["https://example.com/latest.json"],
                "pubkey": "R" * 64,
            }
        },
    }


def test_update_manifest_binds_signed_archive_to_repository_tag_and_checksum(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "Restork.app.tar.gz"
    archive.write_bytes(b"signed archive")
    (tmp_path / "Restork.app.tar.gz.sig").write_text("S" * 64, encoding="utf-8")
    (tmp_path / "Restork_0.1.2_aarch64.dmg").write_bytes(b"signed disk image")

    _update_manifest(
        tmp_path,
        repository="Totoro-qaq/restork",
        tag="v0.1.2",
        version="0.1.2",
    )

    manifest = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
    platform = manifest["platforms"]["darwin-aarch64"]
    assert platform["signature"] == "S" * 64
    assert platform["url"].endswith("/v0.1.2/Restork.app.tar.gz")
    checksums = (tmp_path / "SHA256SUMS").read_text(encoding="utf-8")
    assert "Restork.app.tar.gz" in checksums
    assert "Restork_0.1.2_aarch64.dmg" in checksums
