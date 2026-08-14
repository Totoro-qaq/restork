from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class WindowsDesktopLifecycleContractTests(unittest.TestCase):
    def test_release_desktop_uses_windows_gui_subsystem(self) -> None:
        source = (ROOT / "desktop/src-tauri/src/main.rs").read_text(encoding="utf-8")

        self.assertIn(
            '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
            source,
        )

    def test_all_desktop_owned_core_commands_hide_windows_consoles(self) -> None:
        source = (
            ROOT / "desktop/src-tauri/src/supervisor_windows.rs"
        ).read_text(encoding="utf-8")
        invalidate = re.search(
            r"pub\(crate\) fn invalidate_vault_authority.*?\n}\n\nfn start_attempt",
            source,
            flags=re.DOTALL,
        )

        self.assertIsNotNone(invalidate)
        self.assertIn(".creation_flags(CREATE_NO_WINDOW)", invalidate.group(0))
        self.assertIn(
            ".creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW)",
            source,
        )

    def test_windows_package_smoke_rejects_console_subsystem_binaries(self) -> None:
        source = (ROOT / "scripts/smoke-desktop-windows.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("function Assert-WindowsGuiSubsystem", source)
        self.assertIn("Assert-WindowsGuiSubsystem -Path $executable", source)
        self.assertIn("$ImageSubsystemWindowsGui = 2", source)

    def test_windows_package_smoke_outlives_its_launcher(self) -> None:
        source = (ROOT / "scripts/smoke-desktop-windows.ps1").read_text(
            encoding="utf-8"
        )

        self.assertIn("function Start-RestorkViaEphemeralLauncher", source)
        self.assertIn("-WindowStyle Hidden -Wait -PassThru", source)
        self.assertIn("Restork exited with its short-lived PowerShell launcher.", source)
        self.assertIn(
            "$desktopProcess = Start-RestorkViaEphemeralLauncher",
            source,
        )

    def test_source_quickstart_explains_terminal_ownership(self) -> None:
        source = (ROOT / "scripts/quickstart.ps1").read_text(encoding="utf-8")

        self.assertIn("Source development mode", source)
        self.assertIn("closing this PowerShell window stops", source)
        self.assertIn("源码开发模式", source)


if __name__ == "__main__":
    unittest.main()
