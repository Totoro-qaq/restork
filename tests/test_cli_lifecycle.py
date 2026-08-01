from __future__ import annotations

import json
from pathlib import Path

from restork.cli import main
from restork.contracts.types import EffectPhase
from restork.storage.intents import EffectIntent, SQLiteIntentStore


def test_cli_creates_inspects_streams_completes_and_cancels(tmp_path: Path, capsys: object) -> None:
    database = tmp_path / "state.db"
    base = ["--state-db", str(database)]
    create = [
        *base,
        "create",
        "--task-id",
        "t",
        "--mode",
        "research",
        "--goal",
        "g",
        "--scope",
        "s",
        "--criterion",
        "c",
        "--idempotency-key",
        "create-1",
    ]
    assert main(create) == 0
    run_id = capsys.readouterr().out.strip()  # type: ignore[attr-defined]
    assert main([*base, "stream", run_id]) == 0
    assert len(json.loads(capsys.readouterr().out)) == 2  # type: ignore[attr-defined]
    complete = [
        *base,
        "complete",
        run_id,
        "--artifact",
        "artifact:x",
    ]
    assert main(complete) == 0


def test_cli_requires_explicit_unknown_effect_reconciliation(
    tmp_path: Path, capsys: object
) -> None:
    database = tmp_path / "state.db"
    SQLiteIntentStore.create(database).create_intent(
        EffectIntent("i", "r", "write", "hash", EffectPhase.UNKNOWN, "never")
    )
    assert (
        main(
            [
                "--state-db",
                str(database),
                "resolve-unknown",
                "i",
                "--run-id",
                "r",
                "--outcome",
                "failed",
                "--idempotency-key",
                "resolve-1",
            ]
        )
        == 0
    )
    assert capsys.readouterr().out.strip() == "failed"  # type: ignore[attr-defined]
