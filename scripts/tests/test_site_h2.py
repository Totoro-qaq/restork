"""Focused contract tests for the public H2 product narrative."""

from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SITE = ROOT / "site"

DOWNLOADS = {
    "macOS": "Restork-0.1.5-alpha.1-macOS-arm64-UNSIGNED-ALPHA.dmg",
    "Windows": "Restork-0.1.5-alpha.1-Windows-x64-UNSIGNED-ALPHA-setup.exe",
    "Linux": "Restork-0.1.5-alpha.1-Linux-x64-UNSIGNED-ALPHA.AppImage",
}


class SiteH2ContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pages = {
            "en": (SITE / "index.html").read_text(encoding="utf-8"),
            "zh-CN": (SITE / "zh-CN.html").read_text(encoding="utf-8"),
        }

    def test_downloads_are_real_release_assets_and_live_in_the_hero(self) -> None:
        for locale, html in self.pages.items():
            hero = re.search(r'<section[^>]+class="hero"[\s\S]+?</section>', html)
            self.assertIsNotNone(hero, locale)
            hero_html = hero.group(0)
            for platform, asset in DOWNLOADS.items():
                with self.subTest(locale=locale, platform=platform):
                    self.assertIn(asset, hero_html)
            self.assertIn("v0.1.5-alpha.1", hero_html)

    def test_narrative_is_four_ordered_steps_not_feature_card_grids(self) -> None:
        for locale, html in self.pages.items():
            with self.subTest(locale=locale):
                self.assertEqual(html.count('class="story-step"'), 4)
                self.assertIn('class="feature-stack"', html)
                self.assertNotIn('class="modes"', html)
                self.assertNotIn('class="promises"', html)

    def test_product_media_is_localized_and_has_static_fallback(self) -> None:
        en = self.pages["en"]
        zh = self.pages["zh-CN"]
        self.assertIn("demo-hd.gif", en)
        self.assertIn("demo-poster.webp", en)
        self.assertNotIn("demo-hd.zh-CN.gif", en)
        self.assertIn("demo-hd.zh-CN.gif", zh)
        self.assertIn("demo-poster.zh-CN.webp", zh)
        self.assertIn('class="motion-media"', en)
        self.assertIn('class="static-media"', en)
        self.assertIn('class="media-fallback"', en)

    def test_fake_browser_chrome_and_architecture_art_are_removed(self) -> None:
        for locale, html in self.pages.items():
            with self.subTest(locale=locale):
                self.assertNotIn('class="window"', html)
                self.assertNotIn('class="window-bar"', html)
                self.assertNotIn("architecture", html)

    def test_trust_section_links_to_full_documents(self) -> None:
        for locale, html in self.pages.items():
            with self.subTest(locale=locale):
                self.assertIn('class="trust-list"', html)
                self.assertIn("security", html.lower())
                self.assertIn("desktop", html.lower())

    def test_images_declare_intrinsic_size_and_lazy_loading(self) -> None:
        for locale, html in self.pages.items():
            for tag in re.findall(r"<img\b[^>]*>", html):
                with self.subTest(locale=locale, tag=tag):
                    self.assertRegex(tag, r'\bwidth="\d+"')
                    self.assertRegex(tag, r'\bheight="\d+"')
                    self.assertIn('loading="lazy"', tag)

    def test_styles_include_responsive_and_reduced_motion_contracts(self) -> None:
        css = (SITE / "styles.css").read_text(encoding="utf-8")
        self.assertTrue(css.startswith("/* Hallmark · pre-emit critique:"))
        self.assertIn("overflow-x: clip", css)
        self.assertIn("position: sticky", css)
        self.assertIn("prefers-reduced-motion: reduce", css)
        self.assertIn(".motion-media", css)
        self.assertIn(".static-media", css)
        self.assertIn(":focus-visible", css)

    def test_ultrawide_layout_keeps_a_centered_bounded_canvas(self) -> None:
        css = (SITE / "styles.css").read_text(encoding="utf-8")
        maximum = re.search(r"--content-max:\s*(\d+)px", css)
        self.assertIsNotNone(maximum)
        self.assertGreaterEqual(int(maximum.group(1)), 1800)
        self.assertLessEqual(int(maximum.group(1)), 2200)
        self.assertIn("width: min(var(--content-max)", css)
        self.assertIn("margin-inline: auto", css)


if __name__ == "__main__":
    unittest.main()
