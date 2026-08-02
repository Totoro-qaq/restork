from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from restork.api.app import create_app
from restork.api.auth import RUNS_READ, WEB_AUDIENCE, PairingAuthority
from restork.providers.diagnostics import ProviderDiagnosticReport
from restork.storage.approvals import SQLiteApprovalStore
from restork.storage.events import SQLiteEventStore
from restork.storage.intents import SQLiteIntentStore
from restork.storage.runs import SQLiteRunStore


class FakeProviderDiagnostics:
    def __init__(self) -> None:
        self.smoke_requests: list[bool] = []

    def status(self) -> ProviderDiagnosticReport:
        return ProviderDiagnosticReport(
            status="ready",
            message="Configuration and Keychain metadata are ready.",
            config_present=True,
            config_valid=True,
            credential_present=True,
            connection_checked=False,
        )

    async def diagnose(self, *, smoke: bool = False) -> ProviderDiagnosticReport:
        self.smoke_requests.append(smoke)
        return ProviderDiagnosticReport(
            status="smoke_passed" if smoke else "connected",
            message="Synthetic diagnostic complete.",
            config_present=True,
            config_valid=True,
            credential_present=True,
            connection_checked=True,
            connection_ok=True,
            model_available=True,
            smoke_checked=smoke,
            smoke_ok=True if smoke else None,
            total_tokens=10 if smoke else None,
        )


def _client(
    database: Path,
    pairing: PairingAuthority,
    diagnostics: FakeProviderDiagnostics | None,
) -> TestClient:
    return TestClient(
        create_app(
            SQLiteEventStore.create(database),
            pairing,
            SQLiteRunStore.create(database),
            SQLiteApprovalStore.open(database),
            SQLiteIntentStore.create(database),
            provider_diagnostics=diagnostics,
        )
    )


def test_provider_status_and_diagnostics_are_authenticated_and_keyless(
    tmp_path: Path,
) -> None:
    pairing = PairingAuthority()
    diagnostics = FakeProviderDiagnostics()
    client = _client(tmp_path / "state.db", pairing, diagnostics)
    assert client.get("/v1/providers/deepseek").status_code == 401
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]
    auth = {"Authorization": f"Bearer {token}"}

    status = client.get("/v1/providers/deepseek", headers=auth)
    smoke = client.post(
        "/v1/providers/deepseek/diagnostics",
        headers=auth,
        json={"smoke": True},
    )

    assert status.status_code == 200
    assert status.json()["setup_command"] == "uv run restork provider configure"
    assert smoke.status_code == 200
    assert smoke.json()["status"] == "smoke_passed"
    assert diagnostics.smoke_requests == [True]
    assert "api_key" not in smoke.text.casefold()
    assert "secret" not in smoke.text.casefold()


def test_provider_diagnostic_requires_write_scope_and_strict_json(tmp_path: Path) -> None:
    pairing = PairingAuthority()
    diagnostics = FakeProviderDiagnostics()
    client = _client(tmp_path / "state.db", pairing, diagnostics)
    code = pairing.new_pairing_code(WEB_AUDIENCE, {RUNS_READ})
    token = client.post("/v1/pair", json={"code": code}).json()["access_token"]
    auth = {"Authorization": f"Bearer {token}"}

    assert client.get("/v1/providers/deepseek", headers=auth).status_code == 200
    assert (
        client.post(
            "/v1/providers/deepseek/diagnostics",
            headers=auth,
            json={"smoke": False},
        ).status_code
        == 403
    )

    full_pairing = PairingAuthority()
    full = _client(tmp_path / "full.db", full_pairing, diagnostics)
    full_token = full.post(
        "/v1/pair",
        json={"code": full_pairing.pairing_code},
    ).json()["access_token"]
    full_auth = {"Authorization": f"Bearer {full_token}"}
    assert (
        full.post(
            "/v1/providers/deepseek/diagnostics",
            headers={**full_auth, "Content-Type": "text/plain"},
            content='{"smoke":false}',
        ).status_code
        == 415
    )
    rejected = full.post(
        "/v1/providers/deepseek/diagnostics",
        headers=full_auth,
        json={"smoke": False, "api_key": "must-not-echo"},
    )
    assert rejected.status_code == 422
    assert "must-not-echo" not in rejected.text


def test_provider_routes_fail_closed_when_service_is_absent(tmp_path: Path) -> None:
    pairing = PairingAuthority()
    client = _client(tmp_path / "state.db", pairing, None)
    token = client.post("/v1/pair", json={"code": pairing.pairing_code}).json()[
        "access_token"
    ]

    response = client.get(
        "/v1/providers/deepseek",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 503
