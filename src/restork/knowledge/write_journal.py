"""Crash-recoverable same-filesystem one-file Markdown writes."""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass
from hashlib import sha256
from pathlib import Path

from restork.contracts.approval import ApprovalRequest
from restork.knowledge.vault import Vault, VaultPathError
from restork.knowledge.write_plan import WritePlan, validate_approval


@dataclass(frozen=True)
class WriteJournal:
    relative_path: str
    preimage: str
    preimage_hash: str
    postimage_hash: str


class JournaledWriter:
    def __init__(self, vault: Vault, journal_dir: Path) -> None:
        self._vault = vault
        self._journal_dir = journal_dir

    def apply(self, plan: WritePlan, approval: ApprovalRequest) -> None:
        validate_approval(plan, approval)
        note = self._vault.read_note(plan.relative_path)
        if note.content_hash != plan.expected_hash:
            raise ValueError("write preview is stale")
        journal = WriteJournal(
            plan.relative_path,
            note.content,
            note.content_hash,
            _hash(plan.new_content),
        )
        journal_path = self._journal_path(plan.relative_path)
        self._write_journal(journal_path, journal)
        target = self._vault.root / plan.relative_path
        self._atomic_replace(target, plan.new_content)
        if _hash(target.read_text(encoding="utf-8")) != journal.postimage_hash:
            raise RuntimeError("post-write validation failed")
        journal_path.unlink()

    def recover(self) -> list[str]:
        recovered: list[str] = []
        for journal_path in sorted(self._journal_dir.glob("*.json")):
            journal = WriteJournal(**json.loads(journal_path.read_text(encoding="utf-8")))
            try:
                current = self._vault.read_note(journal.relative_path)
            except VaultPathError:
                raise RuntimeError("journal target is no longer a safe vault note") from None
            if current.content_hash in {journal.preimage_hash, journal.postimage_hash}:
                journal_path.unlink()
                recovered.append(journal.relative_path)
            else:
                raise RuntimeError("write recovery requires user action; target changed externally")
        return recovered

    def _journal_path(self, relative_path: str) -> Path:
        return self._journal_dir / f"{sha256(relative_path.encode()).hexdigest()}.json"

    def _write_journal(self, path: Path, journal: WriteJournal) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(asdict(journal), sort_keys=True))
            handle.flush()
            os.fsync(handle.fileno())

    @staticmethod
    def _atomic_replace(target: Path, content: str) -> None:
        descriptor, temporary = tempfile.mkstemp(prefix=".restork-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def _hash(content: str) -> str:
    return sha256(content.encode()).hexdigest()
