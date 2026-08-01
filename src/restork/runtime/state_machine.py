"""Explicit V1 run-state transition rules."""

from __future__ import annotations

from restork.contracts.types import RunPhase


class InvalidTransition(ValueError):
    """Raised when a persisted run state cannot move to the requested state."""


_ALLOWED_TRANSITIONS: dict[RunPhase, frozenset[RunPhase]] = {
    RunPhase.CREATED: frozenset({RunPhase.PLANNING, RunPhase.CANCELLED}),
    RunPhase.PLANNING: frozenset({RunPhase.RUNNING, RunPhase.FAILED, RunPhase.CANCELLED}),
    RunPhase.RUNNING: frozenset(
        {
            RunPhase.AWAITING_APPROVAL,
            RunPhase.USER_ACTION_REQUIRED,
            RunPhase.VERIFYING,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.AWAITING_APPROVAL: frozenset(
        {RunPhase.RUNNING, RunPhase.FAILED, RunPhase.CANCELLED}
    ),
    RunPhase.USER_ACTION_REQUIRED: frozenset(
        {RunPhase.RUNNING, RunPhase.FAILED, RunPhase.CANCELLED}
    ),
    RunPhase.VERIFYING: frozenset(
        {
            RunPhase.RUNNING,
            RunPhase.USER_ACTION_REQUIRED,
            RunPhase.COMPLETED,
            RunPhase.FAILED,
            RunPhase.CANCELLED,
        }
    ),
    RunPhase.COMPLETED: frozenset(),
    RunPhase.FAILED: frozenset(),
    RunPhase.CANCELLED: frozenset(),
}


def transition(current: RunPhase, next_state: RunPhase) -> RunPhase:
    """Validate one state change without mutating a persistence layer."""
    if next_state not in _ALLOWED_TRANSITIONS[current]:
        msg = f"invalid transition: {current.value} -> {next_state.value}"
        raise InvalidTransition(msg)
    return next_state
