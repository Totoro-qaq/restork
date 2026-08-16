#!/usr/bin/env python3
"""Contract tests for scripts/sync_site_downloads.py."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.sync_site_downloads import sync_page, main

OLD_TAG = "v0.1.5-alpha.3"
NEW_TAG = "v0.1.5-alpha.4"

PAGE_TEMPLATE = """
<p class="release-note"><strong>{tag}</strong> · Unsigned technical preview.</p>
<a href="https://github.com/Totoro-qaq/restork/releases/download/{tag}/Restork-{version}-macOS-arm64-UNSIGNED-ALPHA.dmg">macOS</a>
<a href="https://github.com/Totoro-qaq/restork/releases/download/{tag}/Restork-{version}-Windows-x64-UNSIGNED-ALPHA-setup.exe">Windows</a>
<a href="https://github.com/Totoro-qaq/restork/releases/download/{tag}/Restork-{version}-Linux-x64-UNSIGNED-ALPHA.AppImage">Linux</a>
<a href="https://github.com/Totoro-qaq/restork/releases/tag/{tag}">Checksums and all packages →</a>
<a href="https://github.com/Totoro-qaq/restork/releases/tag/{tag}">Release and checksums</a>
"""


def write_page(directory: Path, tag: str) -> Path:
    path = directory / "index.html"
    path.write_text(
        PAGE_TEMPLATE.format(tag=tag, version=tag.lstrip("v")),
        encoding="utf-8",
    )
    return path


class SyncSiteDownloadsTest(unittest.TestCase):
    def test_rewrites_every_alpha_reference(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            page = write_page(Path(tmp), OLD_TAG)
            content, changed = sync_page(page, NEW_TAG)
        self.assertTrue(changed)
        self.assertNotIn(OLD_TAG, content)
        self.assertEqual(content.count(NEW_TAG), 6)
        for asset in (
            "Restork-0.1.5-alpha.4-macOS-arm64-UNSIGNED-ALPHA.dmg",
            "Restork-0.1.5-alpha.4-Windows-x64-UNSIGNED-ALPHA-setup.exe",
            "Restork-0.1.5-alpha.4-Linux-x64-UNSIGNED-ALPHA.AppImage",
        ):
            self.assertIn(f"releases/download/{NEW_TAG}/{asset}", content)
        self.assertIn(f"<strong>{NEW_TAG}</strong>", content)

    def test_already_current_page_is_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            page = write_page(Path(tmp), NEW_TAG)
            content, changed = sync_page(page, NEW_TAG)
        self.assertFalse(changed)
        self.assertEqual(content.count(NEW_TAG), 6)

    def test_unknown_layout_fails_loudly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            page = Path(tmp) / "index.html"
            page.write_text("<p>no downloads here</p>", encoding="utf-8")
            with self.assertRaises(ValueError):
                sync_page(page, NEW_TAG)

    def test_rejects_non_alpha_tag(self) -> None:
        with self.assertRaises(SystemExit):
            main(["--tag", "v1.0.0"])


if __name__ == "__main__":
    unittest.main()
