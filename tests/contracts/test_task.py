from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from restork.contracts.task import BudgetSpec, DataPolicy, Mode, TaskSpec, ToolPolicy
from restork.contracts.types import DataClass


def test_task_spec_is_versioned_and_rejects_unknown_fields() -> None:
    task = TaskSpec(
        task_id="task-001",
        mode=Mode.RESEARCH,
        goal="Summarize public source material.",
        workspace_scope="vault:research",
        constraints=["read-only"],
        completion_criteria=["produce an evidence note"],
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault.read"]),
        budgets=BudgetSpec(max_steps=5, max_wall_time_seconds=60),
        created_at=datetime.now(UTC),
    )

    assert task.schema_version == 1
    assert task.model_dump(mode="json")["mode"] == "research"
    assert task.budgets.reasoning_effort == "high"
    assert task.budgets.model_copy(update={"reasoning_effort": "max"}).reasoning_effort == "max"

    with pytest.raises(ValidationError):
        TaskSpec.model_validate({**task.model_dump(mode="json"), "surprise": "nope"})
    with pytest.raises(ValidationError, match="never be outbound"):
        DataPolicy(maximum_outbound_class=DataClass.SECRET)
