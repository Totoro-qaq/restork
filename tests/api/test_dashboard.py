from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import DataClass, Mode
from restork.dashboard.models import RadarItem, RadarLane
from restork.dashboard.radar import SQLiteRadarStore
from restork.dashboard.tasks import MarkdownTaskBoard, MarkdownTaskMutator
from restork.knowledge.vault import Vault
from restork.research.evidence import DeterministicResearchSynthesizer
from restork.research.models import (
    FetchedSource,
    SourceAuthority,
    SourceCard,
    SourceKind,
    SourceRequest,
)
from restork.research.store import SQLiteResearchStore
from restork.research.workflow import ResearchWorkflow
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


class _ResearchSources:
    def __init__(self, source: FetchedSource) -> None:
        self.source = source
        self.calls = 0

    async def fetch(self, request: SourceRequest) -> FetchedSource:
        assert request.url == self.source.card.canonical_url
        self.calls += 1
        return self.source


def _task() -> TaskSpec:
    return TaskSpec(
        task_id="dashboard-task",
        mode=Mode.RESEARCH,
        goal="Inspect a synthetic Dashboard run",
        workspace_scope="fixtures",
        completion_criteria=["visible in Dashboard"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(
            max_steps=4,
            max_wall_time_seconds=600,
            max_tokens=1_000,
        ),
        created_at=datetime.now(UTC),
    )


def _client(tmp_path: Path) -> tuple[TestClient, dict[str, str], SQLiteRunStore]:
    database = tmp_path / "state.db"
    vault_root = tmp_path / "vault"
    vault_root.mkdir()
    (vault_root / "Tasks.md").write_text(
        "- [ ] Verify Dashboard #todo ^restork-dashboard\n", encoding="utf-8"
    )
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    Harness(runs, events).start(_task(), idempotency_key="dashboard-run")
    radar = SQLiteRadarStore.create(database)
    now = datetime.now(UTC)
    radar.upsert(
        RadarItem(
            item_id="radar-api",
            lane=RadarLane.HN,
            title="Synthetic local-first discussion",
            source="HN",
            url="https://example.com/discussion",
            data_class=DataClass.PUBLIC,
            created_at=now,
            updated_at=now,
        )
    )
    pairing = PairingAuthority()
    approvals = SQLiteApprovalStore.open(database)
    task_board = MarkdownTaskBoard(Vault(vault_root))
    budgets = SQLiteBudgetStore.create(database)
    research_store = SQLiteResearchStore.create(database)
    source_text = "A public synthetic discussion reports a reproducible local-first result."
    source = FetchedSource(
        card=SourceCard(
            source_id="source-" + "a" * 24,
            kind=SourceKind.WEB,
            authority=SourceAuthority.SECONDARY,
            title="Synthetic local-first discussion",
            canonical_url="https://example.com/discussion",
            publisher="example.com",
            retrieved_at=now,
            content_hash=sha256(source_text.encode()).hexdigest(),
            media_type="text/plain",
            byte_count=len(source_text.encode()),
        ),
        text=source_text,
    )
    research = ResearchWorkflow(
        sources=_ResearchSources(source),
        synthesizer=DeterministicResearchSynthesizer(),
        artifacts=research_store,
        runs=runs,
        events=events,
        budgets=budgets,
        vault=Vault(vault_root),
        now=lambda: now,
    )
    client = TestClient(
        create_app(
            events,
            pairing,
            runs,
            approvals,
            SQLiteIntentStore.create(database),
            tasks=task_board,
            task_mutations=MarkdownTaskMutator.create(
                task_board,
                database,
                approvals,
                tmp_path / "journal",
            ),
            radar=radar,
            budgets=budgets,
            research=research,
            research_artifacts=research_store,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    return client, {"Authorization": f"Bearer {token}"}, runs


def test_dashboard_snapshot_endpoints_use_core_state(tmp_path: Path) -> None:
    client, auth, _ = _client(tmp_path)

    runs = client.get("/v1/runs", headers=auth)
    approvals = client.get("/v1/approvals?pending_only=true", headers=auth)
    tasks = client.get("/v1/tasks?include_completed=false", headers=auth)
    radar = client.get("/v1/radar", headers=auth)

    assert {runs.status_code, approvals.status_code, tasks.status_code, radar.status_code} == {
        200
    }
    assert runs.json()["runs"][0]["task"]["goal"] == "Inspect a synthetic Dashboard run"
    assert runs.json()["runs"][0]["budget"]["usage"]["tokens"] == 0
    assert approvals.json()["approvals"] == []
    assert approvals.json()["page"] == {
        "limit": 20,
        "has_more": False,
        "next_cursor": None,
    }
    assert tasks.json()["tasks"][0]["task_id"] == "restork-dashboard"
    assert radar.json()["items"][0]["item_id"] == "radar-api"


def test_radar_research_action_creates_idempotent_research_run(tmp_path: Path) -> None:
    client, auth, runs = _client(tmp_path)
    headers = {**auth, "Idempotency-Key": "research-radar"}

    first = client.post(
        "/v1/radar/radar-api/action",
        headers=headers,
        json={"action": "research"},
    )
    replay = client.post(
        "/v1/radar/radar-api/action",
        headers=headers,
        json={"action": "research"},
    )

    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    created = runs.get(first.json()["run_id"])
    assert created.mode is Mode.RESEARCH
    assert first.json()["item"]["state"] == "research_queued"
    assert first.json()["research_artifact"]["note_preview"]["action"] == "create"
    assert first.json()["research_artifact"]["metrics"]["citation_correctness"] == 1
    artifact = client.get(
        f"/v1/research/runs/{created.run_id}/artifact", headers=auth
    )
    assert artifact.status_code == 200
    assert artifact.json()["artifact_id"] == first.json()["research_artifact"]["artifact_id"]
    executed = client.post(
        f"/v1/research/runs/{created.run_id}/execute",
        headers=auth,
        json={
            "question": "Investigate: Synthetic local-first discussion",
            "sources": [{"url": "https://example.com/discussion"}],
        },
    )
    mismatch = client.post(
        f"/v1/research/runs/{created.run_id}/execute",
        headers=auth,
        json={
            "question": "A different request",
            "sources": [{"url": "https://example.com/discussion"}],
        },
    )
    assert executed.status_code == 200
    assert mismatch.status_code == 409


def test_core_serves_dashboard_with_security_headers(tmp_path: Path) -> None:
    web = tmp_path / "web"
    (web / "assets").mkdir(parents=True)
    (web / "index.html").write_text("<!doctype html><title>Restork</title>", encoding="utf-8")
    (web / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8"
    )
    database = tmp_path / "static.db"
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            web_root=web,
        )
    )

    response = client.get("/")
    favicon = client.get("/favicon.svg")

    assert response.status_code == 200
    assert "Restork" in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'self'" in response.headers["content-security-policy"]
    assert response.headers["cache-control"] == "no-store"
    assert favicon.status_code == 200
    assert favicon.headers["content-type"].startswith("image/svg+xml")


def test_task_completion_uses_preview_approval_and_apply(tmp_path: Path) -> None:
    client, auth, _ = _client(tmp_path)
    preview = client.post(
        "/v1/tasks/restork-dashboard/preview",
        headers={**auth, "Idempotency-Key": "preview-dashboard-task"},
        json={"completed": True},
    )

    assert preview.status_code == 200
    approval_id = preview.json()["approval"]["approval_id"]
    approved = client.post(
        f"/v1/approvals/{approval_id}",
        headers={**auth, "Idempotency-Key": "approve-dashboard-task"},
        json={"decision": "approve", "decided_by": "dashboard-test"},
    )
    applied = client.post(
        f"/v1/tasks/approvals/{approval_id}/apply",
        headers={
            **auth,
            "Idempotency-Key": "apply-dashboard-task",
            "Content-Type": "application/json",
        },
        json={},
    )

    assert approved.status_code == applied.status_code == 200
    tasks = client.get("/v1/tasks", headers=auth).json()["tasks"]
    assert tasks[0]["completed"] is True


def test_quick_capture_and_radar_make_task_both_create_reviewable_previews(
    tmp_path: Path,
) -> None:
    client, auth, _ = _client(tmp_path)

    capture = client.post(
        "/v1/tasks/quick-capture/preview",
        headers={**auth, "Idempotency-Key": "quick-capture"},
        json={"text": "Review a synthetic source", "priority": "P2"},
    )
    radar = client.post(
        "/v1/radar/radar-api/action",
        headers={**auth, "Idempotency-Key": "radar-make-task"},
        json={"action": "make_task"},
    )

    assert capture.status_code == radar.status_code == 200
    assert capture.json()["after_line"].startswith("- [ ] Review a synthetic source")
    assert capture.json()["approval"]["decision"] == "pending"
    assert radar.json()["task_preview_available"] is True
    assert radar.json()["task_approval_id"].startswith("task-approval-")
    pending = client.get("/v1/approvals?pending_only=true", headers=auth).json()[
        "approvals"
    ]
    assert {approval["approval_id"] for approval in pending} == {
        capture.json()["approval"]["approval_id"],
        radar.json()["task_approval_id"],
    }
