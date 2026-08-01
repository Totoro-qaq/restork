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
from restork.contracts.task import BudgetSpec, DataPolicy, TaskSpec, ToolPolicy
from restork.contracts.types import Mode
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore

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
    parser.add_argument("--state-db", type=Path, default=Path("restork.db"))
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
    create.add_argument("--idempotency-key", required=True)
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
        return _serve(arguments.state_db, arguments.port)

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


def _serve(database: Path, port: int) -> int:
    pairing = PairingAuthority()
    cli_code = pairing.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    app = create_app(
        SQLiteEventStore.create(database),
        pairing,
        SQLiteRunStore.create(database),
        SQLiteApprovalStore.open(database),
        SQLiteIntentStore.create(database),
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
    return TaskSpec(
        task_id=arguments.task_id,
        mode=Mode(arguments.mode),
        goal=arguments.goal,
        workspace_scope=arguments.scope,
        completion_criteria=arguments.criterion,
        data_policy=DataPolicy(),
        tool_policy=ToolPolicy(allowed_tools=["vault_search"]),
        budgets=BudgetSpec(max_steps=10, max_wall_time_seconds=3600),
        created_at=datetime.now(UTC),
    )


def _mapping(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise LocalApiError("local API returned an invalid object")
    return cast(dict[str, object], value)


def _print_json(value: object) -> None:
    print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
