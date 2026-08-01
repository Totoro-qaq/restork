from __future__ import annotations

from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode, RunPhase
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.work.store import SQLiteWorkStore
from restork.work.workflow import WorkWorkflow


def _client(
    tmp_path: Path,
) -> tuple[TestClient, dict[str, str], str, Path, Path, Path]:
    database = tmp_path / "state.db"
    workspace = tmp_path / "repo"
    (workspace / "src").mkdir(parents=True)
    (workspace / ".git").mkdir()
    (workspace / "src" / "app.py").write_text("VALUE = 1\n", encoding="utf-8")
    synthetic_token = "gh" + "p_" + "c" * 24
    (workspace / "README.md").write_text(
        f"private=/Users/example/repo\ntoken={synthetic_token}\n",
        encoding="utf-8",
    )
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    approvals = SQLiteApprovalStore.open(database)
    work_store = SQLiteWorkStore.create(database)
    task = TaskSpec(
        task_id="work-api",
        mode=Mode.WORK,
        goal="Implement a bounded API change",
        workspace_scope="selected-local-workspace",
        completion_criteria=["verify changed-file hashes"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "handoff_export"]),
        budgets=BudgetSpec(max_steps=12, max_wall_time_seconds=600),
        created_at=datetime.now(UTC),
    )
    run = Harness(runs, events, budgets).start(task, idempotency_key="work-api")
    artifacts = tmp_path / "private-data" / "artifacts"
    workflow = WorkWorkflow(
        work=work_store,
        runs=runs,
        events=events,
        budgets=budgets,
        approvals=approvals,
        artifact_dir=artifacts,
    )
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            events,
            pairing,
            runs,
            approvals,
            SQLiteIntentStore.create(database),
            budgets=budgets,
            work=workflow,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    return (
        client,
        {"Authorization": f"Bearer {token}"},
        run.run_id,
        workspace,
        artifacts,
        database,
    )


def _plan_body(workspace: Path) -> dict[str, object]:
    return {
        "goal": "Implement a bounded API change",
        "workspace_root": str(workspace),
        "target_files": ["src/app.py"],
        "context_files": ["README.md"],
        "constraints": ["Do not expand the target set."],
        "non_goals": ["No deployment."],
        "completion_criteria": [
            "verify changed-file hashes",
            "The target postimage hash matches.",
        ],
        "verification_commands": ["uv run pytest -q"],
        "context_data_class": "public",
    }


def test_work_api_plans_exports_and_verifies_without_executing(tmp_path: Path) -> None:
    client, auth, run_id, workspace, artifacts, database = _client(tmp_path)
    plan_response = client.post(
        f"/v1/work/runs/{run_id}/plan",
        headers=auth,
        json=_plan_body(workspace),
    )

    assert plan_response.status_code == 200
    plan = plan_response.json()
    assert plan["target_files"] == ["src/app.py"]
    assert str(workspace) not in plan_response.text
    assert client.get(f"/v1/work/runs/{run_id}/artifact", headers=auth).json() == plan
    preview_url = f"/v1/work/runs/{run_id}/handoff/preview"
    assert client.post(preview_url, headers=auth, json={}).status_code == 400
    preview_response = client.post(
        preview_url,
        headers={**auth, "Idempotency-Key": "work-preview-api"},
        json={},
    )

    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["envelope"]["executor_boundary"].endswith("no_restork_executor")
    assert str(workspace) not in preview_response.text
    assert "/Users/example" not in preview_response.text
    assert "gh" + "p_" + "c" * 24 not in preview_response.text
    assert client.get(f"/v1/work/runs/{run_id}/handoff", headers=auth).status_code == 200
    approval_id = preview["approval"]["approval_id"]
    export_url = f"/v1/work/runs/{run_id}/handoff/export"
    denied = client.post(
        export_url,
        headers={**auth, "Idempotency-Key": "work-export-api"},
        json={"approval_id": approval_id},
    )
    assert denied.status_code == 403
    assert not artifacts.exists()
    approved = client.post(
        f"/v1/approvals/{approval_id}",
        headers={**auth, "Idempotency-Key": "work-approve-api"},
        json={"decision": "approve", "decided_by": "local-test"},
    )
    assert approved.status_code == 200
    exported = client.post(
        export_url,
        headers={**auth, "Idempotency-Key": "work-export-api"},
        json={"approval_id": approval_id},
    )

    assert exported.status_code == 200
    exported_payload = exported.json()
    handoff_file = artifacts / exported_payload["artifact_ref"]
    assert handoff_file.is_file()
    assert handoff_file.stat().st_mode & 0o777 == 0o600
    before_hash = sha256((workspace / "src" / "app.py").read_bytes()).hexdigest()
    (workspace / "src" / "app.py").write_text("VALUE = 2\n", encoding="utf-8")
    after_hash = sha256((workspace / "src" / "app.py").read_bytes()).hexdigest()
    manifest = {
        "run_id": run_id,
        "plan_artifact_id": plan["artifact_id"],
        "base_snapshot_hash": plan["workspace_snapshot_hash"],
        "changed_files": [
            {
                "relative_path": "src/app.py",
                "before_hash": before_hash,
                "after_hash": after_hash,
            }
        ],
        "claimed_commands": [{"command": "uv run pytest -q", "exit_code": 0}],
        "artifacts": [],
        "summary": "Synthetic external result.",
    }
    verified = client.post(
        f"/v1/work/runs/{run_id}/verify",
        headers={**auth, "Idempotency-Key": "work-verify-api"},
        json=manifest,
    )

    assert verified.status_code == 200
    assert verified.json()["status"] == "partial"
    assert verified.json()["completion_eligible"] is False
    assert verified.json()["commands"][0]["status"] == "unverified"
    assert verified.json()["task_update_preview"] is None
    assert SQLiteRunStore.create(database).get(run_id).state is RunPhase.USER_ACTION_REQUIRED
    inspected = client.get(f"/v1/work/runs/{run_id}/verification", headers=auth)
    assert inspected.json() == verified.json()


def test_work_api_fails_closed_for_configuration_validation_and_scope(tmp_path: Path) -> None:
    client, auth, run_id, workspace, _, database = _client(tmp_path)
    body = _plan_body(workspace)
    body["workspace_root"] = str(workspace / ".." / "missing")
    rejected = client.post(
        f"/v1/work/runs/{run_id}/plan",
        headers=auth,
        json=body,
    )
    assert rejected.status_code == 409
    assert str(tmp_path) not in rejected.text

    pairing = PairingAuthority()
    unconfigured = TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
        )
    )
    token = unconfigured.post(
        "/v1/pair", json={"code": pairing.pairing_code}
    ).json()["access_token"]
    response = unconfigured.post(
        f"/v1/work/runs/{run_id}/plan",
        headers={"Authorization": f"Bearer {token}"},
        json=_plan_body(workspace),
    )
    assert response.status_code == 503


def test_research_handoff_creates_one_idempotent_separately_budgeted_work_child(
    tmp_path: Path,
) -> None:
    database = tmp_path / "child.db"
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    parent_task = TaskSpec(
        task_id="research-parent",
        mode=Mode.RESEARCH,
        goal="Research a bounded implementation",
        workspace_scope="synthetic",
        completion_criteria=["produce an evidence artifact"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "source_read"]),
        budgets=BudgetSpec(
            max_steps=8,
            max_wall_time_seconds=600,
            max_child_tasks=1,
        ),
        created_at=datetime.now(UTC),
    )
    parent = Harness(runs, events, budgets).start(parent_task)
    child_task = TaskSpec(
        task_id="work-child",
        parent_task_id=parent.task_id,
        mode=Mode.WORK,
        goal="Prepare a bounded implementation handoff",
        workspace_scope="synthetic",
        completion_criteria=["verify changed-file hashes"],
        data_policy=parent_task.data_policy,
        tool_policy=ToolPolicy(allowed_tools=["handoff_export"]),
        budgets=BudgetSpec(max_steps=8, max_wall_time_seconds=600),
        created_at=datetime.now(UTC),
    )
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            events,
            pairing,
            runs,
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            budgets=budgets,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    auth = {"Authorization": f"Bearer {token}"}
    url = f"/v1/runs/{parent.run_id}/work-child"

    missing_key = client.post(
        url,
        headers=auth,
        json=child_task.model_dump(mode="json"),
    )
    assert missing_key.status_code == 400
    headers = {**auth, "Idempotency-Key": "work-child-api"}
    first = client.post(url, headers=headers, json=child_task.model_dump(mode="json"))
    replay = client.post(url, headers=headers, json=child_task.model_dump(mode="json"))

    assert first.status_code == 200
    assert replay.json() == first.json()
    assert first.json()["mode"] == "work"
    assert budgets.usage(parent.run_id).child_tasks == 1
    assert runs.get_task(first.json()["run_id"]) == child_task
    rebound = client.post(
        url,
        headers=headers,
        json=child_task.model_copy(update={"task_id": "different"}).model_dump(
            mode="json"
        ),
    )
    assert rebound.status_code == 409
