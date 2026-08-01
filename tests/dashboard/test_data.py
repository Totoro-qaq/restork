from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

from restork.contracts.approval import ApprovalRequest
from restork.contracts.run import RunSummary
from restork.contracts.types import DataClass, Mode, RiskClass, RunPhase
from restork.dashboard.models import RadarAction, RadarItem, RadarLane, RadarState
from restork.dashboard.radar import SQLiteRadarStore
from restork.dashboard.tasks import MarkdownTaskBoard
from restork.knowledge.vault import Vault
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.runs import SQLiteRunStore


def test_run_and_approval_lists_are_ordered_and_bounded(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    runs = SQLiteRunStore.create(database)
    now = datetime.now(UTC)
    for index in range(3):
        runs.create_run(
            RunSummary(
                run_id=f"run-{index}",
                task_id=f"task-{index}",
                mode=Mode.RESEARCH,
                state=RunPhase.PLANNING,
                state_version=1,
                created_at=now + timedelta(seconds=index),
                updated_at=now + timedelta(seconds=index),
            )
        )
    assert [run.run_id for run in runs.list_runs(limit=2)] == ["run-2", "run-1"]

    approvals = SQLiteApprovalStore.open(database)
    for index in range(2):
        approvals.create(
            ApprovalRequest(
                approval_id=f"approval-{index}",
                run_id=f"run-{index}",
                action_kind="synthetic.write",
                risk_class=RiskClass.LOCAL_WRITE,
                human_summary="Synthetic approval",
                action_digest=f"digest-{index}",
                canonical_scope="fixture.md",
                resource_versions={},
                policy_version="v1",
                idempotency_key=f"approval-{index}",
                nonce=f"nonce-{index}",
                expires_at=now + timedelta(minutes=index + 1),
            )
        )
    assert [item.approval_id for item in approvals.list_requests(pending_only=True)] == [
        "approval-0",
        "approval-1",
    ]


def test_task_board_reads_markdown_as_the_only_task_truth(tmp_path: Path) -> None:
    (tmp_path / "Tasks.md").write_text(
        "- [ ] First #todo [priority:: P1] ^restork-first\n"
        "- [x] Finished [completed:: 2026-08-01]\n",
        encoding="utf-8",
    )
    board = MarkdownTaskBoard(Vault(tmp_path))

    active = board.snapshot(include_completed=False)
    all_tasks = board.snapshot()

    assert active.configured
    assert [task.task_id for task in active.tasks] == ["restork-first"]
    assert len(all_tasks.tasks) == 2
    assert MarkdownTaskBoard().snapshot().configured is False


def test_radar_actions_are_idempotent_and_dismissed_items_are_hidden(tmp_path: Path) -> None:
    store = SQLiteRadarStore.create(tmp_path / "state.db")
    now = datetime.now(UTC)
    item = RadarItem(
        item_id="radar-1",
        lane=RadarLane.MY_STARS,
        title="Synthetic repository release",
        source="GitHub Stars",
        url="https://example.com/project",
        summary="Public synthetic feed data",
        score=9.5,
        published_at=now,
        data_class=DataClass.PERSONAL,
        created_at=now,
        updated_at=now,
    )
    store.upsert(item)

    dismissed = store.act("radar-1", RadarAction.DISMISS, idempotency_key="dismiss-1")
    replay = store.act("radar-1", RadarAction.DISMISS, idempotency_key="dismiss-1")

    assert dismissed == replay
    assert dismissed.state is RadarState.DISMISSED
    assert store.snapshot().items == ()
    assert store.snapshot(include_dismissed=True).items == (dismissed,)
