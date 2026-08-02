from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _task(index: int) -> TaskSpec:
    return TaskSpec(
        task_id=f"pagination-{index}",
        mode=Mode.RESEARCH,
        goal=f"Synthetic pagination goal {index}",
        workspace_scope="synthetic",
        completion_criteria=["remain bounded"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=4, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )


def test_run_and_event_pages_are_bounded_ordered_and_cursor_scoped(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    created = [Harness(runs, events).start(_task(index)) for index in range(3)]
    selected = created[0]
    for index in range(3):
        events.append_next(selected.run_id, kind=f"synthetic.{index}")
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            events,
            pairing,
            runs,
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
        )
    )
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    headers = {"Authorization": f"Bearer {token}"}

    first_runs = client.get("/v1/runs", params={"limit": 2}, headers=headers)
    first_payload = first_runs.json()
    second_runs = client.get(
        "/v1/runs",
        params={"limit": 2, "cursor": first_payload["page"]["next_cursor"]},
        headers=headers,
    )

    assert first_runs.status_code == 200
    assert first_payload["page"]["has_more"] is True
    assert len(first_payload["runs"]) == 2
    assert len(second_runs.json()["runs"]) == 1
    assert len(
        {
            item["summary"]["run_id"]
            for item in [*first_payload["runs"], *second_runs.json()["runs"]]
        }
    ) == 3
    assert (
        client.get(
            "/v1/approvals",
            params={"cursor": first_payload["page"]["next_cursor"]},
            headers=headers,
        ).status_code
        == 422
    )
    assert (
        client.get("/v1/runs", params={"cursor": "not-a-cursor"}, headers=headers).status_code
        == 422
    )

    first_events = client.get(
        f"/v1/runs/{selected.run_id}/event-page",
        params={"limit": 2},
        headers=headers,
    ).json()
    second_events = client.get(
        f"/v1/runs/{selected.run_id}/event-page",
        params={"limit": 2, "before": first_events["page"]["next_cursor"]},
        headers=headers,
    ).json()

    assert [event["id"] for event in first_events["events"]] == [4, 5]
    assert [event["id"] for event in second_events["events"]] == [2, 3]
    assert first_events["page"]["has_more"] is True
    assert second_events["page"]["has_more"] is True
