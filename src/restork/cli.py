"""Command-line entry point for the Restork Core."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from restork import __version__
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import ApprovalDecision, EffectPhase, Mode
from restork.runtime.runner import Harness
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="restork",
        add_help=False,
        description=("Restork is a local-first agent workspace for Research, Study, and Work."),
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
    create.add_argument("--idempotency-key", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("run_id")
    stream = commands.add_parser("stream", aliases=["events"])
    stream.add_argument("run_id")
    stream.add_argument("--after", type=int, default=0)
    complete = commands.add_parser("complete")
    complete.add_argument("run_id")
    complete.add_argument("--artifact", action="append", required=True)
    cancel = commands.add_parser("cancel")
    cancel.add_argument("run_id")
    cancel.add_argument("--idempotency-key")
    decide = commands.add_parser("approve")
    decide.add_argument("approval_id")
    decide.add_argument("--by", required=True)
    decide.add_argument("--idempotency-key", required=True)
    reject = commands.add_parser("reject")
    reject.add_argument("approval_id")
    reject.add_argument("--by", required=True)
    reject.add_argument("--idempotency-key", required=True)
    resume = commands.add_parser("resume")
    resume.add_argument("run_id")
    resume.add_argument("--idempotency-key", required=True)
    resolve = commands.add_parser("resolve-unknown")
    resolve.add_argument("intent_id")
    resolve.add_argument("--run-id", required=True)
    resolve.add_argument("--outcome", choices=["committed", "failed"], required=True)
    resolve.add_argument("--idempotency-key", required=True)
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
    budgets = SQLiteBudgetStore.create(arguments.state_db)
    if arguments.command == "create":
        task = _task(arguments)
        run = Harness(runs, events, budgets).start(task, idempotency_key=arguments.idempotency_key)
        print(run.run_id)
        return 0
    if arguments.command == "inspect":
        print(runs.get(arguments.run_id).model_dump_json())
        return 0
    if arguments.command in {"stream", "events"}:
        found = events.read(arguments.run_id, after_seq=arguments.after)
        print(json.dumps([event.model_dump(mode="json") for event in found]))
        return 0
    if arguments.command == "cancel":
        key = arguments.idempotency_key or f"cli-cancel:{arguments.run_id}"
        cancelled = Harness(runs, events, budgets).cancel(
            arguments.run_id,
            idempotency_key=key,
        )
        print(cancelled.model_dump_json())
        return 0
    if arguments.command in {"approve", "reject"}:
        decision = (
            ApprovalDecision.APPROVED if arguments.command == "approve" else ApprovalDecision.DENIED
        )
        approved = Harness(runs, events, budgets).decide_approval(
            SQLiteApprovalStore.open(arguments.state_db),
            arguments.approval_id,
            decision,
            arguments.by,
            idempotency_key=arguments.idempotency_key,
        )
        print(approved.model_dump_json())
        return 0
    if arguments.command == "resume":
        resumed = Harness(runs, events, budgets).resume(
            arguments.run_id, idempotency_key=arguments.idempotency_key
        )
        print(resumed.model_dump_json())
        return 0
    if arguments.command == "resolve-unknown":
        intents = SQLiteIntentStore.create(arguments.state_db)
        intent = Harness(runs, events, budgets).resolve_effect(
            intents,
            arguments.run_id,
            arguments.intent_id,
            EffectPhase(arguments.outcome),
            idempotency_key=arguments.idempotency_key,
        )
        print(intent.phase.value)
        return 0
    task = runs.get_task(arguments.run_id)
    completed = Harness(runs, events, budgets).complete(arguments.run_id, task, arguments.artifact)
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
