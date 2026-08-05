from __future__ import annotations

import json
import re
import struct
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path

import pytest
import yaml

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


def test_windows_release_config_requires_a_thumbprint_and_https_timestamp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    output = tmp_path / "windows-release.json"
    monkeypatch.setenv("RESTORK_WINDOWS_CERTIFICATE_THUMBPRINT", "A" * 40)
    monkeypatch.setenv("RESTORK_WINDOWS_TIMESTAMP_URL", "https://timestamp.example.com")
    _updater_config(
        output,
        public_key="R" * 64,
        endpoint="https://example.com/latest.json",
        platform="windows",
    )
    bundle = json.loads(output.read_text(encoding="utf-8"))["bundle"]
    assert bundle["targets"] == ["nsis", "msi"]
    assert bundle["windows"]["certificateThumbprint"] == "A" * 40
    assert bundle["windows"]["timestampUrl"].startswith("https://")


def test_macos_alpha_config_is_versioned_and_explicitly_ad_hoc_signed(
    tmp_path: Path,
) -> None:
    output = tmp_path / "macos-alpha.json"
    _updater_config(
        output,
        public_key="R" * 64,
        endpoint="https://github.com/example/restork/releases/latest/download/latest.json",
        platform="macos",
        version="0.1.3-alpha.1",
        signing_mode="ad-hoc",
    )
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["version"] == "0.1.3-alpha.1"
    assert payload["bundle"] == {
        "createUpdaterArtifacts": True,
        "macOS": {"signingIdentity": "-"},
        "targets": ["app", "dmg"],
    }
    with pytest.raises(ValueError, match="only for macOS"):
        _updater_config(
            output,
            public_key="R" * 64,
            endpoint="https://example.com/latest.json",
            platform="linux",
            signing_mode="ad-hoc",
        )


def test_update_manifest_can_bind_all_desktop_targets_to_one_commit(
    tmp_path: Path,
) -> None:
    fixtures = {
        "Restork.app.tar.gz": b"mac updater",
        "Restork_0.1.2_x64-setup.exe": b"windows updater",
        "Restork_0.1.2_amd64.AppImage": b"linux updater",
    }
    for name, content in fixtures.items():
        artifact = tmp_path / name
        artifact.write_bytes(content)
        artifact.with_name(f"{name}.sig").write_text("S" * 64, encoding="utf-8")
    (tmp_path / "Restork_0.1.2_aarch64.dmg").write_bytes(b"mac installer")
    (tmp_path / "Restork_0.1.2_x64.msi").write_bytes(b"windows installer")
    (tmp_path / "Restork_0.1.2_amd64.deb").write_bytes(b"linux installer")

    _update_manifest(
        tmp_path,
        repository="Totoro-qaq/restork",
        tag="v0.1.2",
        version="0.1.2",
        commit="a" * 40,
        channel="alpha",
        trust="ad-hoc",
    )

    latest = json.loads((tmp_path / "latest.json").read_text(encoding="utf-8"))
    assert set(latest["platforms"]) == {
        "darwin-aarch64",
        "windows-x86_64",
        "linux-x86_64",
    }
    release = json.loads((tmp_path / "release-manifest.json").read_text(encoding="utf-8"))
    assert release["commit"] == "a" * 40
    assert release["channel"] == "alpha"
    assert release["trust"] == "ad-hoc"
    assert "no Apple Developer ID" in latest["notes"]
    assert len(release["artifacts"]) >= 10


def test_protected_release_is_three_platform_fail_closed_and_action_pinned() -> None:
    root = Path(__file__).parents[2]
    workflow_path = root / ".github" / "workflows" / "release.yml"
    source = workflow_path.read_text(encoding="utf-8")
    workflow = yaml.safe_load(source)
    jobs = workflow["jobs"]

    assert {
        "desktop-macos",
        "desktop-windows",
        "desktop-linux",
        "clean-machine-macos",
        "clean-machine-windows",
        "clean-machine-linux",
        "assemble-desktop-release",
        "publish-github-release",
    }.issubset(jobs)
    assert jobs["desktop-macos"]["environment"] == "release-macos"
    assert jobs["desktop-windows"]["environment"] == "release-windows"
    assert jobs["desktop-linux"]["environment"] == "release-linux"
    assert jobs["publish-github-release"]["environment"] == "release-publish"
    assert jobs["publish-github-release"]["needs"] == [
        "source-release",
        "assemble-desktop-release",
    ]

    for action in re.findall(r"uses:\s*([^\s#]+)", source):
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action), action

    for required in (
        "codesign --verify --deep --strict",
        "xcrun stapler validate",
        "Get-AuthenticodeSignature",
        "gpg --batch --verify",
        "smoke-desktop-app.sh 3",
        '"event":"browser_session_stored"',
        "Restork Core survived its desktop owner",
        "pgrep -x restorkd",
        "scripts/generate_sbom.py",
        "actions/attest-build-provenance@",
        "Missing protected release credential",
    ):
        assert required in source


def test_public_macos_alpha_is_ad_hoc_labeled_clean_machine_checked_and_pinned() -> None:
    root = Path(__file__).parents[2]
    source = (root / ".github" / "workflows" / "unsigned-alpha.yml").read_text(encoding="utf-8")
    workflow = yaml.safe_load(source)
    jobs = workflow["jobs"]
    assert {
        "validate-alpha-ref",
        "build-macos-alpha",
        "clean-machine-macos",
        "publish-alpha",
    }.issubset(jobs)
    assert jobs["build-macos-alpha"]["environment"] == "release-macos"
    assert jobs["publish-alpha"]["environment"] == "release-publish"
    for action in re.findall(r"uses:\s*([^\s#]+)", source):
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action), action
    for required in (
        "--signing-mode ad-hoc",
        'grep -q "^Signature=adhoc$"',
        "UNSIGNED-ALPHA.dmg",
        "scripts/generate_sbom.py",
        "actions/attest-build-provenance@",
        "smoke-desktop-app.sh 3",
        "--latest",
        "docs/unsigned-alpha-release.md",
    ):
        assert required in source
    assert "APPLE_CERTIFICATE" not in source
    assert "APPLE_PASSWORD" not in source


def test_macos_lifecycle_smoke_waits_for_launchservices_and_forces_fresh_processes() -> None:
    root = Path(__file__).parents[2]
    source = (root / "scripts" / "smoke-desktop-app.sh").read_text(encoding="utf-8")
    assert '/usr/bin/open -n "$app_bundle"' in source
    assert 'desktop_seen=0' in source
    assert 'elif [[ "$desktop_seen" == "1" ]]' in source


def test_pages_workflow_is_pinned_and_deploys_only_public_static_assets() -> None:
    root = Path(__file__).parents[2]
    source = (root / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
    for action in re.findall(r"uses:\s*([^\s#]+)", source):
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action), action
    assert "path: build/pages" in source
    assert "site/index.html site/zh-CN.html" in source
    assert "social-preview.png assets/readme/social-preview.zh-CN.png" in source
    assert "README" not in source
    assert "secrets." not in source


def test_site_social_previews_are_language_matched_and_share_safe() -> None:
    root = Path(__file__).parents[2]
    cases = (
        (
            root / "assets" / "readme" / "social-preview.png",
            root / "site" / "index.html",
            "https://totoro-qaq.github.io/restork/assets/readme/social-preview.png",
        ),
        (
            root / "assets" / "readme" / "social-preview.zh-CN.png",
            root / "site" / "zh-CN.html",
            "https://totoro-qaq.github.io/restork/assets/readme/social-preview.zh-CN.png",
        ),
    )
    for image, page, public_url in cases:
        payload = image.read_bytes()
        assert payload.startswith(b"\x89PNG\r\n\x1a\n")
        assert struct.unpack(">II", payload[16:24]) == (1280, 640)
        assert len(payload) < 1_000_000
        source = page.read_text(encoding="utf-8")
        assert public_url in source
        assert 'name="twitter:card" content="summary_large_image"' in source


def test_desktop_core_build_loads_the_rust_workspace_linker_policy() -> None:
    root = Path(__file__).parents[2]
    build_script = (root / "scripts" / "build-desktop-runtime.mjs").read_text(encoding="utf-8")
    cargo_config = (root / ".cargo" / "config.toml").read_text(encoding="utf-8")

    # Cargo discovers .cargo/config.toml from the working directory, not the
    # --manifest-path argument. Keep the policy at the repository root for
    # contributor/CI commands and build the Core from its workspace as defense
    # in depth; otherwise a packaged macOS Core can miss its Swift LC_RPATH.
    assert 'run("cargo", [' in build_script
    assert '], process.env, join(projectRoot, "rust"));' in build_script
    assert "process.env.CARGO" not in build_script
    assert "homedir" not in build_script
    assert "@executable_path/../Frameworks" in cargo_config
    assert "/usr/lib/swift" in cargo_config
