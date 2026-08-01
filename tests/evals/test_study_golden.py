from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode
from restork.runtime.runner import Harness
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.runs import SQLiteRunStore
from restork.study.models import DiagnosticSubmission, StudyStartRequest
from restork.study.store import SQLiteStudyStore
from restork.study.workflow import StudyWorkflow


def test_study_golden_paths_are_diagnostic_first_and_answer_free(tmp_path: Path) -> None:
    cases = json.loads((Path(__file__).parent / "study_cases.yaml").read_text())
    for index, case in enumerate(cases):
        database = tmp_path / f"case-{index}.db"
        runs = SQLiteRunStore.create(database)
        events = SQLiteEventStore.create(database)
        budgets = SQLiteBudgetStore.create(database)
        study = SQLiteStudyStore.create(database)
        task = TaskSpec(
            task_id=case["case_id"],
            mode=Mode.STUDY,
            goal=case["objective"],
            workspace_scope="golden",
            completion_criteria=["create an answer-free practice path"],
            data_policy=DataPolicy(),
            tool_policy=ToolPolicy(allowed_tools=["vault_search", "practice"]),
            budgets=BudgetSpec(max_steps=8, max_wall_time_seconds=300),
            created_at=datetime(2026, 8, 2, tzinfo=UTC),
        )
        run = Harness(runs, events, budgets).start(task)
        workflow = StudyWorkflow(
            study=study,
            runs=runs,
            events=events,
            budgets=budgets,
            now=lambda: datetime(2026, 8, 2, tzinfo=UTC),
        )

        diagnostic = workflow.prepare(
            run.run_id, StudyStartRequest(objective=case["objective"])
        )
        artifact = workflow.submit_diagnostic(
            run.run_id,
            DiagnosticSubmission(
                answers={
                    question.question_id: (
                        case["rating"] if position == 0 else "A diagnostic explanation."
                    )
                    for position, question in enumerate(diagnostic.questions)
                }
            ),
        )

        assert artifact.readiness_signal == case["expected_readiness"]
        assert artifact.learning_path[-1].title == "Active recall and transfer"
        assert all(exercise.answer_revealed is False for exercise in artifact.exercises)
        assert all("answer" not in exercise.prompt.casefold() for exercise in artifact.exercises)
