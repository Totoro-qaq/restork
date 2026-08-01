#!/usr/bin/env python3
"""Audit README links and Restork's GitHub-facing visual assets."""

from __future__ import annotations

import re
import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import unquote

MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)")
MARKDOWN_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)")
HTML_IMAGE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
HTML_SRC = re.compile(r"\bsrc=[\"']([^\"']+)[\"']", re.IGNORECASE)
HTML_ALT = re.compile(r"\balt=[\"']([^\"']*)[\"']", re.IGNORECASE)
REMOTE_SCHEMES = ("http://", "https://", "mailto:", "data:", "#")
UNSAFE_SVG_TAGS = {"script", "foreignObject", "iframe", "object", "embed"}
REQUIRED_ASSETS = {
    "assets/readme/hero.svg": (1200, 400),
    "assets/readme/architecture.svg": (1200, 560),
    "assets/readme/demo-hd.gif": (1600, 1000),
    "assets/readme/demo-poster.webp": (1600, 1000),
}


def _local_target(reference: str, base: Path) -> Path | None:
    if reference.startswith(REMOTE_SCHEMES):
        return None
    clean = unquote(reference.split("#", 1)[0].split("?", 1)[0])
    if not clean:
        return None
    return (base / clean).resolve()


def _svg_dimensions(root: ET.Element) -> tuple[int, int] | None:
    view_box = root.attrib.get("viewBox", "").split()
    if len(view_box) != 4:
        return None
    try:
        return round(float(view_box[2])), round(float(view_box[3]))
    except ValueError:
        return None


def _audit_svg(path: Path, expected: tuple[int, int]) -> list[str]:
    issues: list[str] = []
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as error:
        return [f"invalid SVG XML: {error}"]
    if _svg_dimensions(root) != expected:
        issues.append(f"viewBox must be 0 0 {expected[0]} {expected[1]}")

    tags: set[str] = set()
    for node in root.iter():
        tag = node.tag.rsplit("}", 1)[-1]
        tags.add(tag)
        if tag in UNSAFE_SVG_TAGS:
            issues.append(f"contains unsupported <{tag}>")
        for attribute, value in node.attrib.items():
            local_attribute = attribute.rsplit("}", 1)[-1]
            if local_attribute == "href" and value.startswith(("http://", "https://", "data:")):
                issues.append("contains a remote or embedded href")
    if "title" not in tags:
        issues.append("missing <title>")
    if "desc" not in tags:
        issues.append("missing <desc>")
    source = path.read_text(encoding="utf-8")
    if re.search(r"(?:@import|url\s*\(\s*['\"]?https?://)", source, re.IGNORECASE):
        issues.append("contains remote CSS")
    return issues


def _gif_dimensions(path: Path) -> tuple[int, int, int]:
    payload = path.read_bytes()
    if payload[:6] not in {b"GIF87a", b"GIF89a"} or len(payload) < 10:
        raise ValueError("invalid GIF header")
    width, height = struct.unpack("<HH", payload[6:10])
    frame_markers = payload.count(b"\x21\xf9\x04")
    return width, height, frame_markers


def _webp_dimensions(path: Path) -> tuple[int, int]:
    payload = path.read_bytes()
    if len(payload) < 30 or payload[:4] != b"RIFF" or payload[8:12] != b"WEBP":
        raise ValueError("invalid WebP header")
    chunk = payload[12:16]
    if chunk == b"VP8X":
        width = 1 + int.from_bytes(payload[24:27], "little")
        height = 1 + int.from_bytes(payload[27:30], "little")
        return width, height
    if chunk == b"VP8 ":
        start_code = payload.find(b"\x9d\x01\x2a", 20, 40)
        if start_code == -1:
            raise ValueError("invalid lossy WebP frame")
        width, height = struct.unpack("<HH", payload[start_code + 3 : start_code + 7])
        return width & 0x3FFF, height & 0x3FFF
    if chunk == b"VP8L" and payload[20] == 0x2F:
        bits = int.from_bytes(payload[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise ValueError(f"unsupported WebP chunk {chunk!r}")


def _audit_required_assets(root: Path) -> list[str]:
    issues: list[str] = []
    for relative, minimum in REQUIRED_ASSETS.items():
        path = root / relative
        if not path.is_file():
            issues.append(f"missing required asset: {relative}")
            continue
        if path.suffix == ".svg":
            issues.extend(f"{relative}: {issue}" for issue in _audit_svg(path, minimum))
            continue
        try:
            if path.suffix == ".gif":
                width, height, frames = _gif_dimensions(path)
                if frames < 2:
                    issues.append(f"{relative}: demonstration GIF is not animated")
            else:
                width, height = _webp_dimensions(path)
        except ValueError as error:
            issues.append(f"{relative}: {error}")
            continue
        if width < minimum[0] or height < minimum[1]:
            issues.append(
                f"{relative}: expected at least {minimum[0]}x{minimum[1]}, got {width}x{height}"
            )
    return issues


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: audit_readme.py README.md", file=sys.stderr)
        return 2
    if sys.argv[1] not in {"README.md", "./README.md"}:
        print("ERROR: run the audit from the repository root for README.md", file=sys.stderr)
        return 2
    repository_root = Path.cwd().resolve()
    readme = repository_root / "README.md"
    if not readme.is_file():
        print(f"ERROR: README not found: {readme}", file=sys.stderr)
        return 2

    source = readme.read_text(encoding="utf-8")
    issues: list[str] = []
    for alt, reference in MARKDOWN_IMAGE.findall(source):
        if not alt.strip():
            issues.append(f"Markdown image missing useful alt text: {reference}")
    for tag in HTML_IMAGE.findall(source):
        alt = HTML_ALT.search(tag)
        if alt is None or not alt.group(1).strip():
            issues.append(f"HTML image missing useful alt text: {tag[:100]}")

    references = MARKDOWN_LINK.findall(source)
    references.extend(
        match.group(1)
        for tag in HTML_IMAGE.findall(source)
        if (match := HTML_SRC.search(tag))
    )
    checked: set[Path] = set()
    for reference in references:
        target = _local_target(reference, readme.parent)
        if target is None or target in checked:
            continue
        if not target.is_relative_to(repository_root):
            issues.append(f"local target escapes the repository: {reference}")
            continue
        checked.add(target)
        if not target.is_file():
            issues.append(f"missing local target: {reference}")

    required_order = (
        "## 产品实证 / Product proof",
        "## 为什么是 Restork / Why Restork",
        "## 架构 / Architecture",
        "## 五分钟启动 / Five-minute start",
        "## 隐私边界 / Privacy boundary",
    )
    positions = [source.find(heading) for heading in required_order]
    if any(position < 0 for position in positions) or positions != sorted(positions):
        issues.append(
            "README narrative order must be value -> proof -> mechanism -> first use -> detail"
        )
    if "/Users/" in source or "C:\\Users\\" in source:
        issues.append("README contains an absolute personal path")
    if "synthetic" not in source.lower() or "合成" not in source:
        issues.append("README must state the synthetic provenance in both languages")
    issues.extend(_audit_required_assets(readme.parent))

    print(f"README: {readme}")
    print(f"Local targets checked: {len(checked)}")
    print(f"Required visual assets checked: {len(REQUIRED_ASSETS)}")
    if issues:
        print("Issues:")
        for issue in issues:
            print(f"- {issue}")
        return 1
    print("OK: links, narrative order, alt text, SVG safety, and raster dimensions passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
