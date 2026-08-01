from __future__ import annotations

from pathlib import Path

import pytest

from restork.knowledge.links import extract_wiki_links
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault, VaultPathError


def _write(root: Path, relative_path: str, content: str) -> None:
    target = root / relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def test_index_searches_title_heading_body_and_explicit_links(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "Research/Graph.md",
        "# 图谱检索\n\n连接 [[Restork|agent]] 与 [[知识库#目录]]。\n\n正文提到图谱检索。",
    )
    _write(tmp_path, "Restork.md", "# Restork\n\n本地 agent。")

    index = VaultIndex.build(Vault(tmp_path))

    results = index.search("图谱检索")
    assert [result.relative_path for result in results] == ["Research/Graph.md"]
    assert results[0].links == ("Restork", "知识库")
    assert index.search("restork")[0].relative_path == "Restork.md"


def test_vault_rejects_denied_paths_and_ignores_hidden_app_content(tmp_path: Path) -> None:
    _write(tmp_path, "Visible.md", "# Visible")
    _write(tmp_path, ".obsidian/Private.md", "# Hidden")
    _write(tmp_path, "secrets/Private.md", "# Hidden")
    vault = Vault(tmp_path)

    assert [note.relative_path for note in vault.iter_notes()] == ["Visible.md"]
    with pytest.raises(VaultPathError):
        vault.read_note("../Visible.md")
    with pytest.raises(VaultPathError):
        vault.read_note(".obsidian/Private.md")


def test_wiki_links_exclude_headings_aliases_and_inferred_words() -> None:
    assert extract_wiki_links("[[Target#Heading|Alias]] mentions Target") == ("Target",)
