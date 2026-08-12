import json
import tempfile
import unittest
from pathlib import Path

import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_release  # noqa: E402


class UnsignedDesktopAlphaTests(unittest.TestCase):
    def test_release_workflows_resolve_generated_config_from_repository_root(self) -> None:
        repository = Path(__file__).resolve().parents[2]
        for workflow_name, config_name in (
            ("unsigned-alpha.yml", "desktop-alpha-config.json"),
            ("release.yml", "desktop-release-config.json"),
        ):
            with self.subTest(workflow=workflow_name):
                workflow = (repository / ".github" / "workflows" / workflow_name).read_text(
                    encoding="utf-8"
                )
                self.assertNotIn(f"--config ../build/{config_name}", workflow)
                self.assertIn(f"--config build/{config_name}", workflow)

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
        self.assertEqual(payload["bundle"]["targets"], ["nsis"])
        self.assertFalse(payload["bundle"]["createUpdaterArtifacts"])
        self.assertNotIn("windows", payload["bundle"])
        self.assertNotIn("plugins", payload)

    def test_unsigned_stable_windows_config_keeps_nsis_and_msi(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            output = Path(temporary_directory) / "windows-stable.json"
            desktop_release._updater_config(
                output,
                public_key="",
                endpoint="",
                platform="windows",
                version="0.2.0",
                signing_mode="unsigned",
            )
            payload = json.loads(output.read_text(encoding="utf-8"))

        self.assertEqual(payload["bundle"]["targets"], ["nsis", "msi"])

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

            alpha = json.loads((directory / "alpha.json").read_text(encoding="utf-8"))
            manifest = json.loads(
                (directory / "release-manifest.json").read_text(encoding="utf-8")
            )

        self.assertEqual(sorted(alpha["platforms"]), ["darwin-aarch64"])
        self.assertEqual(manifest["trust"], "technical-preview")
        self.assertEqual(manifest["platform_trust"]["windows-x86_64"], "unsigned")
        self.assertEqual(manifest["platform_trust"]["linux-x86_64"], "unsigned")

    def test_stable_and_beta_write_different_updater_manifests(self) -> None:
        for channel, expected in (("stable", "latest.json"), ("beta", "beta.json")):
            with self.subTest(channel=channel), tempfile.TemporaryDirectory() as temporary_directory:
                directory = Path(temporary_directory)
                updater = directory / "Restork-macOS-arm64.app.tar.gz"
                updater.write_bytes(b"mac updater")
                updater.with_name(f"{updater.name}.sig").write_text("a" * 64, encoding="utf-8")
                desktop_release._update_manifest(
                    directory,
                    repository="Totoro-qaq/restork",
                    tag=f"v0.2.0{'-beta.1' if channel == 'beta' else ''}",
                    version=f"0.2.0{'-beta.1' if channel == 'beta' else ''}",
                    commit="a" * 40,
                    channel=channel,
                    trust="protected",
                )
                self.assertTrue((directory / expected).is_file())
                self.assertFalse((directory / ("beta.json" if expected == "latest.json" else "latest.json")).exists())

    def test_alpha_has_its_own_manifest_name(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            directory = Path(temporary_directory)
            updater = directory / "Restork-macOS-arm64.app.tar.gz"
            updater.write_bytes(b"mac updater")
            updater.with_name(f"{updater.name}.sig").write_text("a" * 64, encoding="utf-8")
            desktop_release._update_manifest(
                directory,
                repository="Totoro-qaq/restork",
                tag="v0.2.0-alpha.1",
                version="0.2.0-alpha.1",
                commit="a" * 40,
                channel="alpha",
                trust="ad-hoc",
            )
            self.assertTrue((directory / "alpha.json").is_file())
            self.assertFalse((directory / "beta.json").exists())


if __name__ == "__main__":
    unittest.main()
