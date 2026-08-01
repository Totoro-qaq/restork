from __future__ import annotations

import json
from datetime import UTC, datetime
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
from restork.study.store import SQLiteStudyStore
from restork.study.workflow import StudyWorkflow


def _client(tmp_path: Path) -> tuple[TestClient, dict[str, str], str, Path]:
    database = tmp_path / "state.db"
    runs = SQLiteRunStore.create(database)
    events = SQLiteEventStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    study_store = SQLiteStudyStore.create(database)
    task = TaskSpec(
        task_id="study-api",
        mode=Mode.STUDY,
        goal="Explain Bayesian evidence",
        workspace_scope="synthetic",
        completion_criteria=["complete one evaluated response"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "practice"]),
        budgets=BudgetSpec(max_steps=12, max_wall_time_seconds=600),
        created_at=datetime.now(UTC),
    )
    run = Harness(runs, events, budgets).start(task, idempotency_key="study-api")
    workflow = StudyWorkflow(
        study=study_store,
        runs=runs,
        events=events,
        budgets=budgets,
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
            study=workflow,
            study_artifacts=study_store,
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    return client, {"Authorization": f"Bearer {token}"}, run.run_id, database


def test_study_api_runs_diagnostic_path_and_private_practice(tmp_path: Path) -> None:
    client, auth, run_id, database = _client(tmp_path)
    diagnostic = client.post(
        f"/v1/study/runs/{run_id}/diagnostic",
        headers=auth,
        json={"objective": "Explain Bayesian evidence", "target_note": None},
    )

    assert diagnostic.status_code == 200
    questions = diagnostic.json()["questions"]
    assert len(questions) == 2
    assert SQLiteRunStore.create(database).get(run_id).state is RunPhase.PLANNING
    answers = {
        questions[0]["question_id"]: "2",
        questions[1]["question_id"]: "private diagnostic response",
    }
    path = client.post(
        f"/v1/study/runs/{run_id}/path",
        headers=auth,
        json={"answers": answers},
    )

    assert path.status_code == 200
    artifact = path.json()
    assert artifact["readiness_signal"] == "developing"
    assert artifact["exercises"][0]["answer_revealed"] is False
    assert "answer" not in artifact["exercises"][0]
    exercise_id = artifact["exercises"][0]["exercise_id"]
    attempt_url = f"/v1/study/runs/{run_id}/exercises/{exercise_id}/attempt"
    assert (
        client.post(
            attempt_url,
            headers=auth,
            json={"answer": "private wrong answer", "confidence": 2},
        ).status_code
        == 400
    )
    attempt_headers = {**auth, "Idempotency-Key": "study-attempt-api"}
    attempt = client.post(
        attempt_url,
        headers=attempt_headers,
        json={"answer": "private wrong answer", "confidence": 2},
    )
    replay = client.post(
        attempt_url,
        headers=attempt_headers,
        json={"answer": "private wrong answer", "confidence": 2},
    )

    assert attempt.status_code == replay.status_code == 200
    assert attempt.json() == replay.json()
    assert attempt.json()["correct"] is False
    assert attempt.json()["record_preview"] is None
    inspected = client.get(f"/v1/study/runs/{run_id}/artifact", headers=auth)
    assert inspected.json() == artifact
    event_payload = json.dumps(
        [
            event.model_dump(mode="json")
            for event in SQLiteEventStore.create(database).read(run_id, after_seq=0)
        ]
    )
    assert "private diagnostic response" not in event_payload
    assert "private wrong answer" not in event_payload
    assert b"private diagnostic response" not in database.read_bytes()
    assert b"private wrong answer" not in database.read_bytes()


def test_study_api_validates_payloads_and_configuration(tmp_path: Path) -> None:
    client, auth, run_id, database = _client(tmp_path)

    invalid = client.post(
        f"/v1/study/runs/{run_id}/diagnostic",
        headers=auth,
        json={"objective": ""},
    )
    assert invalid.status_code == 422
    assert client.get(f"/v1/study/runs/{run_id}/artifact", headers=auth).status_code == 404

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
        f"/v1/study/runs/{run_id}/diagnostic",
        headers={"Authorization": f"Bearer {token}"},
        json={"objective": "Explain Bayesian evidence"},
    )
    assert response.status_code == 503


def test_study_api_accepts_a_run_created_through_the_dashboard_contract(
    tmp_path: Path,
) -> None:
    client, auth, _, _ = _client(tmp_path)
    task = TaskSpec(
        task_id="dashboard-study-api",
        mode=Mode.STUDY,
        goal="Practice a synthetic concept",
        workspace_scope="dashboard",
        completion_criteria=["produce one evaluated response"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search", "practice"]),
        budgets=BudgetSpec(max_steps=12, max_wall_time_seconds=600),
        created_at=datetime.now(UTC),
    )
    created = client.post(
        "/v1/runs",
        headers={**auth, "Idempotency-Key": "dashboard-study-create"},
        json=task.model_dump(mode="json"),
    )
    assert created.status_code == 200

    diagnostic = client.post(
        f"/v1/study/runs/{created.json()['run_id']}/diagnostic",
        headers=auth,
        json={"objective": task.goal},
    )

    assert diagnostic.status_code == 200
    assert diagnostic.json()["objective"] == task.goal
