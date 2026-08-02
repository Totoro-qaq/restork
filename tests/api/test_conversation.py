from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode
from restork.conversation.service import ConversationService
from restork.conversation.store import SQLiteConversationStore
from restork.providers.base import ChatCompletion, ChatCompletionRequest, CompletionUsage
from restork.runtime.model import ModelRuntime
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


class ApiConversationProvider:
    def __init__(self) -> None:
        self.calls = 0

    async def complete(self, request: ChatCompletionRequest) -> ChatCompletion:
        assert request.tools == ()
        self.calls += 1
        return ChatCompletion(
            completion_id="api-chat",
            model="synthetic",
            content="A bounded synthetic answer.",
            usage=CompletionUsage(total_tokens=4),
        )


def test_conversation_api_is_scoped_idempotent_and_paginated(tmp_path: Path) -> None:
    database = tmp_path / "state.db"
    events = SQLiteEventStore.create(database)
    runs = SQLiteRunStore.create(database)
    budgets = SQLiteBudgetStore.create(database)
    task = TaskSpec(
        task_id="api-conversation",
        mode=Mode.STUDY,
        goal="Learn a synthetic topic.",
        workspace_scope="synthetic",
        completion_criteria=["explain it clearly"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["practice"]),
        budgets=BudgetSpec(
            max_steps=8,
            max_wall_time_seconds=120,
            max_tokens=2_000,
        ),
        created_at=datetime.now(UTC),
    )
    run = Harness(runs, events, budgets).start(task, idempotency_key="api-run")
    provider = ApiConversationProvider()
    conversation = ConversationService(
        conversations=SQLiteConversationStore.create(database),
        runs=runs,
        events=events,
        model_runtime=ModelRuntime(events, budgets),
        provider=provider,
    )
    pairing = PairingAuthority()
    client = TestClient(
        create_app(
            events,
            pairing,
            runs,
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            conversation=conversation,
        )
    )
    path = f"/v1/runs/{run.run_id}/conversation"

    assert client.get(path).status_code == 401
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    auth = {"Authorization": f"Bearer {token}"}
    assert client.post(path, json={"content": "hello"}, headers=auth).status_code == 400
    headers = {**auth, "Idempotency-Key": "api-message"}

    first = client.post(path, json={"content": "hello"}, headers=headers)
    replay = client.post(path, json={"content": "hello"}, headers=headers)
    page = client.get(f"{path}?limit=1", headers=auth)

    assert first.status_code == 200
    assert replay.json() == first.json()
    assert provider.calls == 1
    assert page.status_code == 200
    assert [turn["turn_id"] for turn in page.json()["turns"]] == [
        first.json()["turn_id"]
    ]
    assert page.json()["page"] == {
        "limit": 1,
        "has_more": False,
        "next_cursor": None,
    }
