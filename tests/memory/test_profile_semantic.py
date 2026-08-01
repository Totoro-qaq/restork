from __future__ import annotations

import stat
from pathlib import Path

from restork.contracts.types import DataClass
from restork.knowledge.search import VaultIndex
from restork.knowledge.vault import Vault
from restork.memory.models import MemoryLayer, memory_content_hash
from restork.memory.profile import PrivateProfileStore
from restork.memory.semantic import MarkdownSemanticMemory


def test_private_profile_is_explicit_correctable_and_user_only(tmp_path: Path) -> None:
    profile_dir = tmp_path / "private-profile"
    store = PrivateProfileStore(profile_dir)
    empty = store.get("profile:locale.language")
    assert empty.summary == ""

    language = store.correct(
        empty.memory_id,
        "zh-CN",
        expected_content_hash=empty.content_hash,
    )
    artists = store.correct(
        "profile:preferences.favorite_artists",
        ["Synthetic Artist"],
        expected_content_hash=memory_content_hash("[]"),
    )
    instructions = store.correct(
        "profile:instructions",
        "Prefer evidence before conclusions.",
        expected_content_hash=memory_content_hash(""),
    )

    assert language.summary == "zh-CN"
    assert artists.summary == '["Synthetic Artist"]'
    assert instructions.summary == "Prefer evidence before conclusions."
    assert store.load().preferences.favorite_artists == ("Synthetic Artist",)
    assert stat.S_IMODE((profile_dir / "profile.toml").stat().st_mode) == 0o600
    assert stat.S_IMODE((profile_dir / "instructions.md").stat().st_mode) == 0o600

    assert store.delete(language.memory_id, expected_content_hash=language.content_hash)
    assert store.get(language.memory_id).summary == ""


def test_markdown_semantic_memory_is_disposable_and_uses_opaque_refs(tmp_path: Path) -> None:
    vault_root = tmp_path / "vault"
    vault_root.mkdir()
    note = vault_root / "Model Notes.md"
    note.write_text(
        "# Model Notes\n\nA synthetic retrieval fact about matrices.\n",
        encoding="utf-8",
    )
    vault = Vault(vault_root)
    semantic = MarkdownSemanticMemory(vault, VaultIndex.build(vault))

    candidates = semantic.search("matrices")

    assert len(candidates) == 1
    assert candidates[0].layer is MemoryLayer.SEMANTIC
    assert "matrices" in candidates[0].content
    assert "Model Notes.md" not in (candidates[0].source_ref or "")
    assert candidates[0].data_class is DataClass.PERSONAL
