"""Command-line client for the authenticated Restork local API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from restork import __version__
from restork.api.app import create_app
from restork.api.auth import CLI_AUDIENCE, CLI_SCOPES, PairingAuthority
from restork.api.server import make_server
from restork.config.loader import load_config
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import DataClass, Mode
from restork.daily.cache import SQLiteDailyCache
from restork.daily.service import DailyContextService
from restork.daily.weather import OpenMeteoWeather
from restork.dashboard.radar import SQLiteRadarStore
from restork.dashboard.tasks import MarkdownTaskBoard, MarkdownTaskMutator
from restork.knowledge.vault import Vault
from restork.memory.profile import PrivateProfileStore
from restork.memory.service import MemoryService
from restork.memory.store import SQLiteMemoryStore
from restork.network.gateway import DefaultOutboundGateway, OutboundPolicy
from restork.paths import RuntimePaths
from restork.providers.deepseek_chat_completions import DeepSeekChatCompletionsProvider
from restork.research.evidence import (
    DeepSeekResearchSynthesizer,
    DeterministicResearchSynthesizer,
    ResearchSynthesizer,
)
from restork.research.sources import ResearchSourceClient
from restork.research.store import SQLiteResearchStore
from restork.research.workflow import ResearchWorkflow
from restork.runtime.model import ModelRuntime
from restork.secrets import KeychainSecretStore, LocalEncryptionKeyStore
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.budgets import SQLiteBudgetStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore
from restork.storage.transient_blobs import TransientBlobStore
from restork.study.store import SQLiteStudyStore
from restork.study.workflow import StudyWorkflow
from restork.work.store import SQLiteWorkStore
from restork.work.workflow import WorkWorkflow

DEFAULT_API_URL = "http://127.0.0.1:7337"


class LocalApiError(RuntimeError):
    """A safe local-API failure without response-body leakage."""


class LocalApiClient:
    def __init__(self, base_url: str, token: str | None) -> None:
        parsed = urlsplit(base_url)
        try:
            port = parsed.port
        except ValueError as error:
            raise ValueError("RESTORK_API_URL has an invalid port") from error
        if (
            parsed.scheme != "http"
            or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}
            or port is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("RESTORK_API_URL must be an explicit loopback HTTP origin")
        self._base_url = base_url.rstrip("/")
        self._token = token

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, object] | None = None,
        idempotency_key: str | None = None,
        last_event_id: int | None = None,
    ) -> object:
        payload = None
        headers = {"Accept": "application/json"}
        if body is not None:
            payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        if last_event_id is not None:
            headers["Last-Event-ID"] = str(last_event_id)
            headers["Accept"] = "text/event-stream"
        request = Request(
            f"{self._base_url}{path}",
            data=payload,
            headers=headers,
            method=method,
        )
        try:
            # The URL constructor above accepts only a validated loopback HTTP origin.
            with urlopen(request, timeout=30) as response:  # nosec B310
                response_payload = response.read()
                content_type = response.headers.get_content_type()
        except HTTPError as error:
            raise LocalApiError(f"local API returned HTTP {error.code}") from error
        except URLError as error:
            raise LocalApiError("local Restork Core is unavailable") from error
        if not response_payload:
            return None
        if content_type == "text/event-stream":
            return response_payload.decode()
        try:
            return json.loads(response_payload)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise LocalApiError("local API returned an invalid response") from error


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="restork",
        add_help=False,
        description="Restork is a local-first agent workspace for Research, Study, and Work.",
    )
    parser.add_argument(
        "--api-url",
        default=os.environ.get("RESTORK_API_URL", DEFAULT_API_URL),
    )
    parser.add_argument(
        "--state-db",
        type=Path,
        default=RuntimePaths.from_environ().data_dir / "restork.db",
    )
    parser.add_argument("--profile-dir", type=Path)
    parser.add_argument("--vault-dir", type=Path)
    parser.add_argument("-h", "--help", action="store_true", help="show this help message and exit")
    parser.add_argument("--version", action="store_true", help="show the Restork version and exit")
    commands = parser.add_subparsers(dest="command")

    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=7337)
    pair = commands.add_parser("pair")
    pair.add_argument("--code", required=True)

    create = commands.add_parser("create")
    create.add_argument("--task-id", required=True)
    create.add_argument("--mode", choices=[mode.value for mode in Mode], required=True)
    create.add_argument("--goal", required=True)
    create.add_argument("--scope", required=True)
    create.add_argument("--criterion", action="append", required=True)
    create.add_argument(
        "--data-class",
        choices=["public", "personal", "confidential"],
        default="public",
    )
    create.add_argument("--idempotency-key", required=True)
    research = commands.add_parser("research")
    research.add_argument("run_id")
    research.add_argument("--question", required=True)
    research.add_argument("--source", action="append", required=True)
    research.add_argument("--target-note")
    study_diagnostic = commands.add_parser("study-diagnostic")
    study_diagnostic.add_argument("run_id")
    study_diagnostic.add_argument("--objective", required=True)
    study_diagnostic.add_argument("--target-note")
    study_path = commands.add_parser("study-path")
    study_path.add_argument("run_id")
    study_path.add_argument(
        "--answer",
        action="append",
        required=True,
        metavar="QUESTION_ID=VALUE",
    )
    study_practice = commands.add_parser("study-practice")
    study_practice.add_argument("run_id")
    study_practice.add_argument("exercise_id")
    study_practice.add_argument("--answer", required=True)
    study_practice.add_argument("--confidence", type=int, choices=range(1, 6), required=True)
    study_practice.add_argument("--idempotency-key", required=True)
    work_child = commands.add_parser("work-child")
    work_child.add_argument("parent_run_id")
    work_child.add_argument("--task-id", required=True)
    work_child.add_argument("--parent-task-id", required=True)
    work_child.add_argument("--goal", required=True)
    work_child.add_argument("--scope", required=True)
    work_child.add_argument("--criterion", action="append", required=True)
    work_child.add_argument(
        "--data-class",
        choices=["public", "personal", "confidential"],
        default="public",
    )
    work_child.add_argument("--idempotency-key", required=True)
    work_plan = commands.add_parser("work-plan")
    work_plan.add_argument("run_id")
    work_plan.add_argument("--goal", required=True)
    work_plan.add_argument("--workspace-root", type=Path, required=True)
    work_plan.add_argument("--target", action="append", required=True)
    work_plan.add_argument("--context", action="append", default=[])
    work_plan.add_argument("--constraint", action="append", default=[])
    work_plan.add_argument("--non-goal", action="append", default=[])
    work_plan.add_argument("--criterion", action="append", required=True)
    work_plan.add_argument("--verify-command", action="append", default=[])
    work_plan.add_argument(
        "--context-data-class",
        choices=["public", "personal", "confidential"],
        default="public",
    )
    work_preview = commands.add_parser("work-handoff-preview")
    work_preview.add_argument("run_id")
    work_preview.add_argument("--idempotency-key", required=True)
    work_export = commands.add_parser("work-handoff-export")
    work_export.add_argument("run_id")
    work_export.add_argument("approval_id")
    work_export.add_argument("--idempotency-key", required=True)
    work_verify = commands.add_parser("work-verify")
    work_verify.add_argument("run_id")
    work_verify.add_argument("--manifest", type=Path, required=True)
    work_verify.add_argument("--idempotency-key", required=True)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("run_id")
    stream = commands.add_parser("stream", aliases=["events"])
    stream.add_argument("run_id")
    stream.add_argument("--after", type=int, default=0)
    cancel = commands.add_parser("cancel")
    cancel.add_argument("run_id")
    cancel.add_argument("--idempotency-key", required=True)
    approve = commands.add_parser("approve")
    approve.add_argument("approval_id")
    approve.add_argument("--by", required=True)
    approve.add_argument("--idempotency-key", required=True)
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
    commands.add_parser("health")
    commands.add_parser("capabilities")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit status."""
    parser = _parser()
    arguments = parser.parse_args(argv)
    if arguments.version:
        print(f"restork {__version__}")
        return 0
    if arguments.command is None:
        parser.print_help()
        return 0
    if arguments.command == "serve":
        return _serve(
            arguments.state_db,
            arguments.port,
            arguments.profile_dir,
            arguments.vault_dir,
        )

    try:
        client = LocalApiClient(arguments.api_url, os.environ.get("RESTORK_CLI_TOKEN"))
        if arguments.command == "pair":
            response = client.request("POST", "/v1/cli/pair", body={"code": arguments.code})
            print(_mapping(response)["access_token"])
            return 0
        if not os.environ.get("RESTORK_CLI_TOKEN"):
            raise LocalApiError("RESTORK_CLI_TOKEN is required; run `restork pair` first")
        return _run_authenticated(client, arguments)
    except (LocalApiError, ValueError, KeyError) as error:
        print(f"restork: {error}", file=sys.stderr)
        return 2


def _serve(
    database: Path,
    port: int,
    profile_dir: Path | None = None,
    vault_dir: Path | None = None,
) -> int:
    pairing = PairingAuthority()
    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    runtime_paths = RuntimePaths.from_environ()
    database.parent.mkdir(parents=True, exist_ok=True)
    selected_profile = profile_dir or runtime_paths.config_dir / "profiles" / "default"
    profile_store = PrivateProfileStore(selected_profile)
    selected_vault = Vault(vault_dir) if vault_dir is not None else None
    event_store = SQLiteEventStore.create(database)
    run_store = SQLiteRunStore.create(database)
    budget_store = SQLiteBudgetStore.create(database)
    memory = MemoryService(
        SQLiteMemoryStore.create(database),
        profile_store,
        runtime_paths.data_dir / "artifacts",
    )
    task_board = MarkdownTaskBoard(selected_vault)
    approval_store = SQLiteApprovalStore.open(database)
    task_mutations = (
        MarkdownTaskMutator.create(
            task_board,
            database,
            approval_store,
            runtime_paths.data_dir / "write-journal",
        )
        if task_board.configured
        else None
    )
    daily = DailyContextService(
        profile_store,
        OpenMeteoWeather(
            DefaultOutboundGateway(
                OutboundPolicy(
                    allowed_origins=frozenset({"https://api.open-meteo.com"}),
                    maximum_data_class=DataClass.PERSONAL,
                    maximum_response_bytes=500_000,
                    allowed_query_keys=frozenset(
                        {
                            "latitude",
                            "longitude",
                            "current",
                            "timezone",
                            "forecast_days",
                        }
                    ),
                )
            ),
            SQLiteDailyCache.create(database),
        ),
    )
    research_store = SQLiteResearchStore.create(database)
    study_store = SQLiteStudyStore.create(database)
    work_store = SQLiteWorkStore.create(database)
    config_path = runtime_paths.config_dir / "config.toml"
    synthesizer: ResearchSynthesizer
    if config_path.is_file():
        provider_config = load_config(config_path).provider
        provider = DeepSeekChatCompletionsProvider(
            provider_config,
            DefaultOutboundGateway(
                OutboundPolicy(
                    allowed_origins=frozenset({provider_config.base_url}),
                    maximum_data_class=DataClass.PERSONAL,
                    maximum_response_bytes=4_000_000,
                )
            ),
            KeychainSecretStore(),
        )
        transient_key = LocalEncryptionKeyStore().load_or_create(
            runtime_paths.data_dir / "transient.key",
            require_existing=TransientBlobStore.contains_payloads(database),
        )
        transient_blobs = TransientBlobStore.create(database, transient_key)
        synthesizer = DeepSeekResearchSynthesizer(
            ModelRuntime(
                event_store,
                budget_store,
                transient_blobs=transient_blobs,
            ),
            provider,
        )
    else:
        synthesizer = DeterministicResearchSynthesizer()
    research_workflow = ResearchWorkflow(
        sources=ResearchSourceClient(),
        synthesizer=synthesizer,
        artifacts=research_store,
        runs=run_store,
        events=event_store,
        budgets=budget_store,
        vault=selected_vault,
    )
    study_workflow = StudyWorkflow(
        study=study_store,
        runs=run_store,
        events=event_store,
        budgets=budget_store,
        vault=selected_vault,
    )
    work_workflow = WorkWorkflow(
        work=work_store,
        runs=run_store,
        events=event_store,
        budgets=budget_store,
        approvals=approval_store,
        artifact_dir=runtime_paths.data_dir / "artifacts",
    )
    app = create_app(
        event_store,
        pairing,
        run_store,
        approval_store,
        SQLiteIntentStore.create(database),
        memory,
        task_board,
        task_mutations,
        SQLiteRadarStore.create(database),
        budget_store,
        daily=daily,
        research=research_workflow,
        research_artifacts=research_store,
        study=study_workflow,
        study_artifacts=study_store,
        work=work_workflow,
    )
    print(f"Web pairing code: {pairing.pairing_code}")
    print(f"CLI pairing code: {cli_code}", flush=True)
    make_server(app, port).run()
    return 0


def _run_authenticated(client: LocalApiClient, arguments: argparse.Namespace) -> int:
    if arguments.command == "create":
        response = client.request(
            "POST",
            "/v1/runs",
            body=_task(arguments).model_dump(mode="json"),
            idempotency_key=arguments.idempotency_key,
        )
        print(_mapping(response)["run_id"])
        return 0
    if arguments.command == "research":
        body: dict[str, object] = {
            "schema_version": 1,
            "question": arguments.question,
            "sources": [
                {"schema_version": 1, "url": source, "kind": None}
                for source in arguments.source
            ],
            "target_note": arguments.target_note,
        }
        _print_json(
            client.request(
                "POST",
                f"/v1/research/runs/{arguments.run_id}/execute",
                body=body,
            )
        )
        return 0
    if arguments.command == "study-diagnostic":
        _print_json(
            client.request(
                "POST",
                f"/v1/study/runs/{arguments.run_id}/diagnostic",
                body={
                    "schema_version": 1,
                    "objective": arguments.objective,
                    "target_note": arguments.target_note,
                },
            )
        )
        return 0
    if arguments.command == "study-path":
        answers = _parse_answers(arguments.answer)
        _print_json(
            client.request(
                "POST",
                f"/v1/study/runs/{arguments.run_id}/path",
                body={"schema_version": 1, "answers": answers},
            )
        )
        return 0
    if arguments.command == "study-practice":
        _print_json(
            client.request(
                "POST",
                (
                    f"/v1/study/runs/{arguments.run_id}/exercises/"
                    f"{arguments.exercise_id}/attempt"
                ),
                body={
                    "schema_version": 1,
                    "answer": arguments.answer,
                    "confidence": arguments.confidence,
                },
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "work-child":
        response = client.request(
            "POST",
            f"/v1/runs/{arguments.parent_run_id}/work-child",
            body=_work_child_task(arguments).model_dump(mode="json"),
            idempotency_key=arguments.idempotency_key,
        )
        print(_mapping(response)["run_id"])
        return 0
    if arguments.command == "work-plan":
        workspace_root = _workspace_root(arguments.workspace_root)
        _print_json(
            client.request(
                "POST",
                f"/v1/work/runs/{arguments.run_id}/plan",
                body={
                    "schema_version": 1,
                    "goal": arguments.goal,
                    "workspace_root": str(workspace_root),
                    "target_files": arguments.target,
                    "context_files": arguments.context,
                    "constraints": arguments.constraint,
                    "non_goals": arguments.non_goal,
                    "completion_criteria": arguments.criterion,
                    "verification_commands": arguments.verify_command,
                    "context_data_class": arguments.context_data_class,
                },
            )
        )
        return 0
    if arguments.command == "work-handoff-preview":
        _print_json(
            client.request(
                "POST",
                f"/v1/work/runs/{arguments.run_id}/handoff/preview",
                body={},
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "work-handoff-export":
        _print_json(
            client.request(
                "POST",
                f"/v1/work/runs/{arguments.run_id}/handoff/export",
                body={"approval_id": arguments.approval_id},
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "work-verify":
        _print_json(
            client.request(
                "POST",
                f"/v1/work/runs/{arguments.run_id}/verify",
                body=_load_json_object(arguments.manifest),
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "inspect":
        _print_json(client.request("GET", f"/v1/runs/{arguments.run_id}"))
        return 0
    if arguments.command in {"stream", "events"}:
        response = client.request(
            "GET",
            f"/v1/runs/{arguments.run_id}/events",
            last_event_id=arguments.after,
        )
        print(cast(str, response), end="")
        return 0
    if arguments.command == "cancel":
        _print_json(
            client.request(
                "POST",
                f"/v1/runs/{arguments.run_id}/cancel",
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command in {"approve", "reject"}:
        _print_json(
            client.request(
                "POST",
                f"/v1/approvals/{arguments.approval_id}",
                body={
                    "decision": arguments.command,
                    "decided_by": arguments.by,
                },
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "resume":
        _print_json(
            client.request(
                "POST",
                f"/v1/runs/{arguments.run_id}/resume",
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command == "resolve-unknown":
        _print_json(
            client.request(
                "POST",
                f"/v1/runs/{arguments.run_id}/effects/{arguments.intent_id}/resolve",
                body={"outcome": arguments.outcome},
                idempotency_key=arguments.idempotency_key,
            )
        )
        return 0
    if arguments.command in {"health", "capabilities"}:
        _print_json(client.request("GET", f"/v1/{arguments.command}"))
        return 0
    raise ValueError("unsupported command")


def _task(arguments: argparse.Namespace) -> TaskSpec:
    mode = Mode(arguments.mode)
    tools = {
        Mode.RESEARCH: ["vault_search", "source_read"],
        Mode.STUDY: ["vault_search", "practice"],
        Mode.WORK: ["vault_search", "handoff_export"],
    }[mode]
    return TaskSpec(
        task_id=arguments.task_id,
        mode=mode,
        goal=arguments.goal,
        workspace_scope=arguments.scope,
        completion_criteria=arguments.criterion,
        data_policy=DataPolicy(
            maximum_outbound_class=DataClass(arguments.data_class),
            allow_private_previews=arguments.data_class != "public",
        ),
        tool_policy=ToolPolicy(allowed_tools=tools),
        budgets=BudgetSpec(
            max_steps=10,
            max_wall_time_seconds=3600,
            max_child_tasks=1 if mode is not Mode.WORK else 0,
        ),
        created_at=datetime.now(UTC),
    )


def _work_child_task(arguments: argparse.Namespace) -> TaskSpec:
    data_class = DataClass(arguments.data_class)
    return TaskSpec(
        task_id=arguments.task_id,
        parent_task_id=arguments.parent_task_id,
        mode=Mode.WORK,
        goal=arguments.goal,
        workspace_scope=arguments.scope,
        completion_criteria=arguments.criterion,
        data_policy=DataPolicy(
            maximum_outbound_class=data_class,
            allow_private_previews=data_class is not DataClass.PUBLIC,
        ),
        tool_policy=ToolPolicy(
            allowed_tools=["vault_search", "handoff_export"]
        ),
        budgets=BudgetSpec(max_steps=10, max_wall_time_seconds=3600),
        created_at=datetime.now(UTC),
    )


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise LocalApiError("local API returned an invalid object")
    return cast(dict[str, object], value)


def _parse_answers(values: Sequence[str]) -> dict[str, str]:
    answers: dict[str, str] = {}
    for value in values:
        question_id, separator, answer = value.partition("=")
        if not separator or not question_id or not answer:
            raise ValueError("--answer must use QUESTION_ID=VALUE")
        if question_id in answers:
            raise ValueError(f"duplicate diagnostic answer: {question_id}")
        answers[question_id] = answer
    return answers


def _load_json_object(path: Path) -> dict[str, object]:
    try:
        resolved = path.expanduser().resolve(strict=True)
        is_file = resolved.is_file()
        size = resolved.stat().st_size
    except OSError as error:
        raise ValueError("Work result manifest is not a readable local file") from error
    if not is_file or size > 2_000_000:
        raise ValueError("Work result manifest must be a JSON file of at most 2 MB")
    try:
        value = json.loads(resolved.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Work result manifest is not valid UTF-8 JSON") from error
    if not isinstance(value, dict):
        raise ValueError("Work result manifest must contain one JSON object")
    return cast(dict[str, object], value)


def _workspace_root(path: Path) -> Path:
    try:
        resolved = path.expanduser().resolve(strict=True)
    except OSError as error:
        raise ValueError("Work workspace root is not a readable local directory") from error
    if not resolved.is_dir():
        raise ValueError("Work workspace root is not a readable local directory")
    return resolved


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
