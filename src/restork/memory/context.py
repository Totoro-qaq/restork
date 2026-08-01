"""Deterministic token-window selection without hidden model calls."""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from restork.contracts.types import DataClass
from restork.memory.models import (
    ContextCandidate,
    ContextSelection,
    MemoryLayer,
    SelectedContextItem,
)
from restork.providers.base import ChatMessage

_LAYER_PRIORITY = {
    MemoryLayer.WORKING: 0,
    MemoryLayer.PROFILE: 1,
    MemoryLayer.SEMANTIC: 2,
    MemoryLayer.EPISODIC: 3,
}
_DATA_PRIORITY = {
    DataClass.PUBLIC: 0,
    DataClass.PERSONAL: 1,
    DataClass.CONFIDENTIAL: 2,
    DataClass.SECRET: 3,
    DataClass.CREDENTIAL: 4,
}


def estimate_tokens(text: str) -> int:
    """Return a conservative deterministic estimate suitable for local budgeting."""
    return max(1, (len(text.encode("utf-8")) + 3) // 4 + 4)


class WorkingContextSelector:
    def select(
        self,
        candidates: Iterable[ContextCandidate],
        *,
        max_tokens: int,
        reserve_tokens: int = 0,
    ) -> ContextSelection:
        if max_tokens < 1 or reserve_tokens < 0 or reserve_tokens >= max_tokens:
            raise ValueError("context budget must leave at least one available token")
        available = max_tokens - reserve_tokens
        unique: dict[str, ContextCandidate] = {}
        for candidate in candidates:
            previous = unique.get(candidate.candidate_id)
            if previous is not None and previous != candidate:
                raise ValueError("context candidate IDs must bind to one immutable value")
            unique[candidate.candidate_id] = candidate
        ordered = sorted(unique.values(), key=_candidate_sort_key)
        selected: list[SelectedContextItem] = []
        dropped: list[str] = []
        consumed = 0
        for candidate in ordered:
            tokens = estimate_tokens(candidate.content)
            if consumed + tokens > available:
                dropped.append(candidate.candidate_id)
                continue
            selected.append(
                SelectedContextItem(
                    candidate_id=candidate.candidate_id,
                    layer=candidate.layer,
                    content=candidate.content,
                    data_class=candidate.data_class,
                    estimated_tokens=tokens,
                    source_ref=candidate.source_ref,
                )
            )
            consumed += tokens
        maximum = max(
            (item.data_class for item in selected),
            key=lambda value: _DATA_PRIORITY[value],
            default=DataClass.PUBLIC,
        )
        return ContextSelection(
            items=tuple(selected),
            selected_ids=tuple(item.candidate_id for item in selected),
            dropped_ids=tuple(dropped),
            estimated_tokens=consumed,
            available_tokens=available,
            maximum_data_class=maximum,
        )


def _candidate_sort_key(candidate: ContextCandidate) -> tuple[object, ...]:
    return (
        0 if candidate.explicit else 1,
        _LAYER_PRIORITY[candidate.layer],
        -candidate.score,
        -candidate.created_at.timestamp(),
        candidate.candidate_id,
    )


class MessageWindow:
    """Select complete recent chat groups while preserving system and tool pairing."""

    def __init__(self, max_tokens: int = 32_000) -> None:
        if max_tokens < 32:
            raise ValueError("message window must be at least 32 estimated tokens")
        self._max_tokens = max_tokens

    @property
    def max_tokens(self) -> int:
        return self._max_tokens

    def select(self, messages: Sequence[ChatMessage]) -> tuple[tuple[ChatMessage, ...], int, int]:
        if not messages:
            raise ValueError("message window requires at least one message")
        systems = tuple(message for message in messages if message.role == "system")
        groups = _message_groups(tuple(message for message in messages if message.role != "system"))
        selected_groups: list[tuple[ChatMessage, ...]] = []
        consumed = sum(_message_tokens(message) for message in systems)
        if consumed >= self._max_tokens:
            raise ValueError("system messages exceed the working-context budget")
        for group in reversed(groups):
            group_tokens = sum(_message_tokens(message) for message in group)
            if consumed + group_tokens > self._max_tokens:
                continue
            selected_groups.append(group)
            consumed += group_tokens
        selected_groups.reverse()
        selected = (*systems, *(message for group in selected_groups for message in group))
        if not selected or all(message.role == "system" for message in selected):
            raise ValueError("latest conversation turn exceeds the working-context budget")
        dropped = len(messages) - len(selected)
        return tuple(selected), consumed, dropped


def _message_groups(messages: tuple[ChatMessage, ...]) -> list[tuple[ChatMessage, ...]]:
    groups: list[list[ChatMessage]] = []
    for message in messages:
        if message.role == "user" or not groups:
            groups.append([message])
        else:
            groups[-1].append(message)
    return [tuple(group) for group in groups]


def _message_tokens(message: ChatMessage) -> int:
    parts = [message.role, message.content or "", message.reasoning_content or ""]
    parts.extend(call.name for call in message.tool_calls)
    parts.extend(str(call.arguments) for call in message.tool_calls)
    if message.tool_call_id:
        parts.append(message.tool_call_id)
    return estimate_tokens("\n".join(parts))
