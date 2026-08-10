import json
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_release  # noqa: E402


class UnsignedDesktopAlphaTests(unittest.TestCase):
    def test_unsigned_windows_config_needs_no_release_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "windows-alpha.json"
            desktop_release._updater_config(
                output,
                public_key="",
                endpoint="",
                platform="windows",
                version="0.2.0-alpha.1",
                signing_mode="unsigned",
            )
            payload = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(payload["version"], "0.2.0-alpha.1")
        self.assertEqual(payload["bundle"]["targets"], ["nsis", "msi"])
        self.assertFalse(payload["bundle"]["createUpdaterArtifacts"])
        self.assertNotIn("windows", payload["bundle"])
        self.assertNotIn("plugins", payload)

    def test_unsigned_linux_config_builds_appimage_and_deb(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "linux-alpha.json"
            desktop_release._updater_config(
                output,
                public_key="",
                endpoint="",
                platform="linux",
                version="0.2.0-alpha.1",
                signing_mode="unsigned",
            )
            payload = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(payload["bundle"]["targets"], ["appimage", "deb"])
        self.assertFalse(payload["bundle"]["createUpdaterArtifacts"])

    def test_technical_preview_manifest_keeps_only_the_signed_macos_updater(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            mac_updater = directory / "Restork-macOS-arm64.app.tar.gz"
            mac_updater.write_bytes(b"mac updater")
            mac_updater.with_name(f"{mac_updater.name}.sig").write_text(
                "a" * 64,
                encoding="utf-8",
            )
            (directory / "Restork-Windows-x64-UNSIGNED-ALPHA-setup.exe").write_bytes(b"exe")
            (directory / "Restork-Linux-x64-UNSIGNED-ALPHA.AppImage").write_bytes(b"appimage")
            (directory / "Restork-Linux-x64-UNSIGNED-ALPHA.deb").write_bytes(b"deb")

            desktop_release._update_manifest(
                directory,
                repository="Totoro-qaq/restork",
                tag="v0.2.0-alpha.1",
                version="0.2.0-alpha.1",
                commit="a" * 40,
                channel="alpha",
                trust="technical-preview",
            )

            latest = json.loads((directory / "latest.json").read_text(encoding="utf-8"))
            manifest = json.loads(
                (directory / "release-manifest.json").read_text(encoding="utf-8")
            )

        self.assertEqual(sorted(latest["platforms"]), ["darwin-aarch64"])
        self.assertEqual(manifest["trust"], "technical-preview")
        self.assertEqual(manifest["platform_trust"]["windows-x86_64"], "unsigned")
        self.assertEqual(manifest["platform_trust"]["linux-x86_64"], "unsigned")


if __name__ == "__main__":
    unittest.main()
