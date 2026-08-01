"""Command-line entry point for the Restork Core."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from restork import __version__
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode, RunPhase
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="restork",
        add_help=False,
        description=(
            "Restork is a local-first agent workspace for Research, Study, and Work."
        ),
    )
    parser.add_argument("--state-db", type=Path, default=Path("restork.db"))
    parser.add_argument("-h", "--help", action="store_true", help="show this help message and exit")
    parser.add_argument("--version", action="store_true", help="show the Restork version and exit")
    commands = parser.add_subparsers(dest="command")
    create = commands.add_parser("create")
    create.add_argument("--task-id", required=True)
    create.add_argument("--mode", choices=[mode.value for mode in Mode], required=True)
    create.add_argument("--goal", required=True)
    create.add_argument("--scope", required=True)
    create.add_argument("--criterion", action="append", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("run_id")
    events = commands.add_parser("events")
    events.add_argument("run_id")
    events.add_argument("--after", type=int, default=0)
    complete = commands.add_parser("complete")
    complete.add_argument("run_id")
    complete.add_argument("--task-id", required=True)
    complete.add_argument("--mode", choices=[mode.value for mode in Mode], required=True)
    complete.add_argument("--artifact", action="append", required=True)
    cancel = commands.add_parser("cancel")
    cancel.add_argument("run_id")
    decide = commands.add_parser("approve")
    decide.add_argument("approval_id")
    decide.add_argument("--by", required=True)
    reject = commands.add_parser("reject")
    reject.add_argument("approval_id")
    reject.add_argument("--by", required=True)
    resume = commands.add_parser("resume")
    resume.add_argument("run_id")
    resolve = commands.add_parser("resolve-unknown")
    resolve.add_argument("intent_id")
    resolve.add_argument("--outcome", choices=["committed", "failed"], required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the command-line interface and return a process exit status."""
    parser = _parser()
    arguments = parser.parse_args(argv)

    if arguments.version:
        print(f"restork {__version__}")
        return 0

    if arguments.command is None:
        parser.print_help()
        return 0
    runs = SQLiteRunStore.create(arguments.state_db)
    events = SQLiteEventStore.create(arguments.state_db)
    if arguments.command == "create":
        task = _task(arguments)
        run = Harness(runs, events).start(task)
        print(run.run_id)
        return 0
    if arguments.command == "inspect":
        print(runs.get(arguments.run_id).model_dump_json())
        return 0
    if arguments.command == "events":
        found = events.read(arguments.run_id, after_seq=arguments.after)
        print(json.dumps([event.model_dump(mode="json") for event in found]))
        return 0
    if arguments.command == "cancel":
        current = runs.get(arguments.run_id)
        cancelled = runs.transition(
            arguments.run_id, expected_version=current.state_version, next_state=RunPhase.CANCELLED
        )
        print(cancelled.model_dump_json())
        return 0
    if arguments.command in {"approve", "reject"}:
        decision = (
            ApprovalDecision.APPROVED if arguments.command == "approve" else ApprovalDecision.DENIED
        )
        approved = SQLiteApprovalStore.open(arguments.state_db).decide(
            arguments.approval_id, decision, arguments.by
        )
        print(approved.model_dump_json())
        return 0
    if arguments.command == "resume":
        current = runs.get(arguments.run_id)
        if current.state not in {RunPhase.AWAITING_APPROVAL, RunPhase.USER_ACTION_REQUIRED}:
            raise ValueError("only paused runs can be resumed")
        resumed = runs.transition(
            arguments.run_id, expected_version=current.state_version, next_state=RunPhase.RUNNING
        )
        print(resumed.model_dump_json())
        return 0
    if arguments.command == "resolve-unknown":
        intents = SQLiteIntentStore.create(arguments.state_db)
        intent = intents.get(arguments.intent_id)
        if intent.phase is not EffectPhase.UNKNOWN:
            raise ValueError("only unknown effects require reconciliation")
        print(intents.update_phase(arguments.intent_id, EffectPhase(arguments.outcome)).phase.value)
        return 0
    task = _task(arguments)
    completed = Harness(runs, events).complete(arguments.run_id, task, arguments.artifact)
    print(completed.model_dump_json())
    return 0


def _task(arguments: argparse.Namespace) -> TaskSpec:
    return TaskSpec(
        task_id=arguments.task_id,
        mode=Mode(arguments.mode),
        goal=getattr(arguments, "goal", "resume"),
        workspace_scope=getattr(arguments, "scope", "local"),
        completion_criteria=getattr(arguments, "criterion", ["complete"]),
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=10, max_wall_time_seconds=3600),
        created_at=datetime.now(UTC),
    )
