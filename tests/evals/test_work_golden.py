from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import DataClass, Mode
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore
from restork.work.models import WorkStartRequest
from restork.work.store import SQLiteWorkStore
from restork.work.workflow import WorkWorkflow


def test_work_golden_cases_remain_planning_only_and_path_private(tmp_path: Path) -> None:
    cases = json.loads((Path(__file__).parent / "work_cases.yaml").read_text())
    for index, case in enumerate(cases):
        root = tmp_path / f"repo-{index}"
        target = root / case["target"]
        target.parent.mkdir(parents=True)
        target.write_text("synthetic source\n", encoding="utf-8")
        database = tmp_path / f"case-{index}.db"
        runs = SQLiteRunStore.create(database)
        events = SQLiteEventStore.create(database)
        budgets = SQLiteBudgetStore.create(database)
        approvals = SQLiteApprovalStore.open(database)
        work = SQLiteWorkStore.create(database)
        task = TaskSpec(
            task_id=case["case_id"],
            mode=Mode.WORK,
            goal=case["goal"],
            workspace_scope="golden",
            completion_criteria=["produce a bounded handoff preview"],
            data_policy=DataPolicy(),
            tool_policy=ToolPolicy(allowed_tools=["handoff_export"]),
            budgets=BudgetSpec(max_steps=8, max_wall_time_seconds=300),
            created_at=datetime.now(UTC),
        )
        run = Harness(runs, events, budgets).start(task)
        workflow = WorkWorkflow(
            work=work,
            runs=runs,
            events=events,
            budgets=budgets,
            approvals=approvals,
            artifact_dir=tmp_path / f"artifacts-{index}",
        )

        plan = workflow.plan(
            run.run_id,
            WorkStartRequest(
                goal=case["goal"],
                workspace_root=str(root),
                target_files=(case["target"],),
                completion_criteria=(
                    "produce a bounded handoff preview",
                    "The postimage hash matches.",
                ),
                verification_commands=(case["verification"],),
                context_data_class=DataClass.PUBLIC,
            ),
        )
        preview = workflow.preview_handoff(
            run.run_id, idempotency_key=f"golden-{index}"
        )

        assert plan.target_files == (case["target"],)
        assert str(root) not in plan.model_dump_json()
        assert preview.envelope.executor_boundary.endswith("no_restork_executor")
        assert preview.envelope.proposed_verification_commands == (case["verification"],)
