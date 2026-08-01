from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from restork.contracts.types import DataClass
from restork.memory.context import MessageWindow, WorkingContextSelector, estimate_tokens
from restork.memory.models import ContextCandidate, MemoryLayer
from restork.providers.base import ChatMessage, ToolCall


def _candidate(
    candidate_id: str,
    layer: MemoryLayer,
    content: str,
    *,
    score: int = 0,
    explicit: bool = False,
    age_minutes: int = 0,
    data_class: DataClass = DataClass.PUBLIC,
) -> ContextCandidate:
    return ContextCandidate(
        candidate_id=candidate_id,
        layer=layer,
        content=content,
        data_class=data_class,
        created_at=datetime.now(UTC) - timedelta(minutes=age_minutes),
        score=score,
        explicit=explicit,
    )


def test_selector_prioritizes_explicit_and_recent_context_with_manifest() -> None:
    candidates = (
        _candidate("old", MemoryLayer.WORKING, "old turn", age_minutes=30),
        _candidate("new", MemoryLayer.WORKING, "new turn", age_minutes=1),
        _candidate(
            "profile",
            MemoryLayer.PROFILE,
            "concise answers",
            explicit=True,
            data_class=DataClass.PERSONAL,
        ),
        _candidate("semantic", MemoryLayer.SEMANTIC, "related note", score=50),
    )
    budget = estimate_tokens("concise answers") + estimate_tokens("new turn")

    result = WorkingContextSelector().select(candidates, max_tokens=budget)

    assert result.selected_ids == ("profile", "new")
    assert set(result.dropped_ids) == {"old", "semantic"}
    assert result.maximum_data_class is DataClass.PERSONAL
    assert result.estimated_tokens <= result.available_tokens


def test_selector_deduplicates_identical_candidates_and_rejects_rebinding() -> None:
    candidate = _candidate("same", MemoryLayer.WORKING, "one")
    result = WorkingContextSelector().select((candidate, candidate), max_tokens=100)
    assert result.selected_ids == ("same",)

    rebound = candidate.model_copy(update={"content": "different"})
    with pytest.raises(ValueError, match="immutable"):
        WorkingContextSelector().select((candidate, rebound), max_tokens=100)


def test_secret_and_credential_candidates_fail_before_selection() -> None:
    for data_class in (DataClass.SECRET, DataClass.CREDENTIAL):
        with pytest.raises(ValidationError, match="cannot enter working context"):
            _candidate("denied", MemoryLayer.WORKING, "never", data_class=data_class)


def test_message_window_keeps_system_and_complete_recent_tool_group() -> None:
    call = ToolCall(tool_call_id="call-1", name="vault_search", arguments={"query": "x"})
    messages = (
        ChatMessage(role="system", content="policy"),
        ChatMessage(role="user", content="old " * 100),
        ChatMessage(role="assistant", content="old response " * 100),
        ChatMessage(role="user", content="new request"),
        ChatMessage(role="assistant", tool_calls=(call,)),
        ChatMessage(role="tool", content="result", tool_call_id="call-1"),
    )
    recent_tokens = sum(
        estimate_tokens(part)
        for part in (
            "system\npolicy\n",
            "user\nnew request\n",
            "assistant\n\nvault_search\n{'query': 'x'}",
            "tool\nresult\n\ncall-1",
        )
    )
    window = MessageWindow(max_tokens=max(64, recent_tokens + 20))

    selected, consumed, dropped = window.select(messages)

    assert selected[0].role == "system"
    assert [message.role for message in selected[-3:]] == ["user", "assistant", "tool"]
    assert selected[-1].tool_call_id == "call-1"
    assert dropped == 2
    assert consumed <= window.max_tokens


def test_message_window_fails_when_latest_turn_cannot_fit() -> None:
    window = MessageWindow(max_tokens=32)
    with pytest.raises(ValueError, match="latest conversation"):
        window.select(
            (
                ChatMessage(role="system", content="policy"),
                ChatMessage(role="user", content="oversized " * 200),
            )
        )
