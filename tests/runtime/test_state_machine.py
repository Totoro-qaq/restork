from __future__ import annotations

import pytest

from restork.contracts.types import RunPhase
from restork.runtime.state_machine import InvalidTransition, transition


def test_state_machine_rejects_terminal_reopen() -> None:
    with pytest.raises(InvalidTransition):
        transition(RunPhase.COMPLETED, RunPhase.RUNNING)


def test_unknown_effect_requires_user_action() -> None:
    result = transition(RunPhase.RUNNING, RunPhase.USER_ACTION_REQUIRED)
    assert result is RunPhase.USER_ACTION_REQUIRED
