#!/usr/bin/env python3
"""Scan Dashboard copy for banned voice and ASCII punctuation in Chinese strings."""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "dashboard/src"

TR_CALL = re.compile(
    r"""tr\(\s*locale[^,]*,\s*(?P<en>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*(?P<zh>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')""",
    re.S,
)
HAS_CJK = re.compile(r"[\u3400-\u9fff]")
ASCII_PUNCT = re.compile(r"[.,!?;](?!\d)")
URL_OR_CODE = re.compile(r"https?://|SHA-256|API |Core |HTTP |JSON |PPTX|PDF|MCP|SKILL\.md")

# Operating-system and product-adjacent terms that are not Restork calling itself 系统.
SYSTEM_ALLOW = (
    "系统凭据",
    "系统设置",
    "系统日历",
    "系统邮件",
    "系统安全",
    "系统文件夹",
    "系统软件",
    "系统时间",
    "文件系统",
    "操作系统",
    "跟随系统",
    "连接系统",
    "请先打开系统邮件",
)
USER_ALLOW = ("用户名",)


def unquote(literal: str) -> str:
    return str(ast.literal_eval(literal))


def allowed_system(text: str) -> bool:
    return any(term in text for term in SYSTEM_ALLOW)


def allowed_user(text: str) -> bool:
    return any(term in text for term in USER_ALLOW)


def main() -> int:
    issues: list[str] = []
    for path in sorted(DASHBOARD.rglob("*.ts")):
        source = path.read_text(encoding="utf-8")
        relative = path.relative_to(ROOT)
        for match in TR_CALL.finditer(source):
            zh = unquote(match.group("zh"))
            if "本产品" in zh:
                issues.append(f"{relative}: banned 本产品 in {zh!r}")
            if "系统" in zh and not allowed_system(zh):
                issues.append(f"{relative}: 系统 is banned unless it names OS capability: {zh!r}")
            if "用户" in zh and not allowed_user(zh):
                issues.append(f"{relative}: 用户 is banned; address the reader as 你: {zh!r}")
            if HAS_CJK.search(zh) and ASCII_PUNCT.search(zh) and not URL_OR_CODE.search(zh):
                issues.append(f"{relative}: Chinese copy should use fullwidth punctuation: {zh!r}")
    if issues:
        print("\n".join(issues), file=sys.stderr)
        return 1
    print("voice copy ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
