from __future__ import annotations

import ast
import inspect
from pathlib import Path

from fastapi.routing import APIRoute

from restork.api.app import create_app
from restork.api.auth import PairingAuthority
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import OutboundPolicy, evaluate_outbound
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


def test_sec_net_001_core_network_clients_stay_behind_declared_boundaries() -> None:
    source_root = Path(__file__).parents[2] / "src" / "restork"
    network_modules = {"aiohttp", "httpx", "requests", "socket", "urllib.request"}
    allowed = {
        "cli.py",  # Explicit loopback-only Core client.
        "network/gateway.py",
        "network/resolution.py",
    }

    for path in source_root.rglob("*.py"):
        relative = path.relative_to(source_root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=relative)
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        forbidden = {
            module
            for module in imported
            if module in network_modules
            or any(module.startswith(prefix + ".") for prefix in network_modules)
        }
        if forbidden:
            assert relative in allowed, f"undeclared network boundary in {relative}: {forbidden}"

    policy = OutboundPolicy(allowed_origins=frozenset({"https://api.deepseek.com"}))
    hostile_destinations = (
        "http://api.deepseek.com/chat/completions",
        "https://127.0.0.1/chat/completions",
        "https://localhost/chat/completions",
        "https://api.deepseek.com.attacker.invalid/chat/completions",
        "https://name:password@api.deepseek.com/chat/completions",
        "https://api.deepseek.com/chat/completions?token=synthetic",
        "https://api.deepseek.com/chat/completions#payload",
    )
    assert all(
        evaluate_outbound(
            destination=destination,
            classification=DataClass.PUBLIC,
            policy=policy,
        )
        is PolicyDecision.DENIED
        for destination in hostile_destinations
    )
    assert (
        evaluate_outbound(
            destination="https://api.deepseek.com/chat/completions",
            classification=DataClass.PUBLIC,
            policy=policy,
            resolved_address_class="private",
        )
        is PolicyDecision.DENIED
    )


def test_sec_auth_001_every_non_pairing_api_route_has_a_scoped_token_dependency(
    tmp_path: Path,
) -> None:
    database = tmp_path / "state.db"
    app = create_app(
        SQLiteEventStore.create(database),
        PairingAuthority(),
        SQLiteRunStore.create(database),
        SQLiteApprovalStore.open(database),
        SQLiteIntentStore.create(database),
    )
    public_routes = {"/v1/pair", "/v1/cli/pair", "/v1/readiness"}

    for route in app.routes:
        if not isinstance(route, APIRoute) or not route.path.startswith("/v1/"):
            continue
        dependency_calls = [dependency.call for dependency in route.dependant.dependencies]
        if route.path in public_routes:
            assert all(call.__name__ != "dependency" for call in dependency_calls)
            continue
        token_dependencies = [
            call
            for call in dependency_calls
            if call.__name__ == "dependency"
            and "scope" in inspect.getclosurevars(call).nonlocals
        ]
        assert len(token_dependencies) == 1, f"missing scoped auth on {route.path}"

        has_body = route.body_field is not None or any(
            call.__name__ == "require_json" for call in dependency_calls
        )
        if has_body:
            assert any(call.__name__ == "require_json" for call in dependency_calls)
