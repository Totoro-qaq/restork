from __future__ import annotations

import asyncio
import json
from pathlib import Path

from restork.config.models import KeychainReference
from restork.network.gateway import OutboundRequest, OutboundResponse
from restork.providers.diagnostics import DeepSeekProviderDiagnostics


class FakeKeychain:
    def __init__(self, *, exists: bool = True, secret: str = "synthetic-secret") -> None:
        self.present = exists
        self.secret = secret
        self.references: list[KeychainReference] = []

    def exists(self, reference: KeychainReference) -> bool:
        self.references.append(reference)
        return self.present

    def resolve(self, reference: KeychainReference) -> str:
        self.references.append(reference)
        if not self.present:
            raise LookupError("missing")
        return self.secret


class SequenceGateway:
    def __init__(self, responses: list[OutboundResponse]) -> None:
        self.responses = responses
        self.requests: list[OutboundRequest] = []

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        self.requests.append(request)
        return self.responses.pop(0)


def _write_config(path: Path) -> None:
    path.write_text(
        "[provider]\n"
        'name = "deepseek"\n'
        'model = "deepseek-v4-pro"\n'
        'base_url = "https://api.deepseek.com"\n'
        'api_key_ref = "keychain:restork/provider/deepseek"\n'
        "thinking_enabled = true\n"
        'reasoning_effort = "high"\n',
        encoding="utf-8",
    )


def test_provider_status_is_local_only_and_reports_setup_states(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"

    missing = DeepSeekProviderDiagnostics(config_path, keychain=FakeKeychain()).status()
    assert missing.status == "not_configured"
    assert missing.setup_command == "uv run restork provider configure"

    config_path.write_text("[provider]\napi_key = 'forbidden'", encoding="utf-8")
    invalid = DeepSeekProviderDiagnostics(config_path, keychain=FakeKeychain()).status()
    assert invalid.status == "invalid_configuration"

    _write_config(config_path)
    absent = DeepSeekProviderDiagnostics(
        config_path,
        keychain=FakeKeychain(exists=False),
        provider_active=False,
    ).status()
    assert absent.status == "credential_missing"
    assert absent.restart_required is True
    assert absent.connection_checked is False


def test_model_diagnostic_is_bounded_and_keeps_secret_out_of_report(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.toml"
    _write_config(config_path)
    gateway = SequenceGateway(
        [
            OutboundResponse(
                200,
                {"x-request-id": "request-models-1"},
                b'{"data":[{"id":"deepseek-v4-pro"}]}',
            )
        ]
    )
    keychain = FakeKeychain()
    diagnostics = DeepSeekProviderDiagnostics(
        config_path,
        keychain=keychain,
        gateway_factory=lambda _: gateway,
        provider_active=True,
    )

    report = asyncio.run(diagnostics.diagnose())

    assert report.status == "connected"
    assert report.model_available is True
    assert report.request_id == "request-models-1"
    assert len(gateway.requests) == 1
    request = gateway.requests[0]
    assert request.envelope.destination == "https://api.deepseek.com/models"
    assert request.envelope.method == "GET"
    assert request.envelope.source_refs == []
    assert request.payload == b""
    assert request.headers["Authorization"] == "Bearer synthetic-secret"
    assert "synthetic-secret" not in request.envelope.model_dump_json()
    assert "synthetic-secret" not in report.model_dump_json()


def test_opt_in_smoke_uses_only_a_fixed_public_prompt_and_returns_metadata(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.toml"
    _write_config(config_path)
    gateway = SequenceGateway(
        [
            OutboundResponse(200, {}, b'{"data":[{"id":"deepseek-v4-pro"}]}'),
            OutboundResponse(
                200,
                {},
                (
                    b'{"id":"smoke-1","model":"deepseek-v4-pro","choices":'
                    b'[{"message":{"content":"RESTORK_OK"},"finish_reason":"stop"}],'
                    b'"usage":{"prompt_tokens":8,"completion_tokens":2,"total_tokens":10}}'
                ),
            ),
        ]
    )
    diagnostics = DeepSeekProviderDiagnostics(
        config_path,
        keychain=FakeKeychain(),
        gateway_factory=lambda _: gateway,
    )

    report = asyncio.run(diagnostics.diagnose(smoke=True))

    assert report.status == "smoke_passed"
    assert report.smoke_ok is True
    assert report.total_tokens == 10
    assert len(gateway.requests) == 2
    payload = json.loads(gateway.requests[1].payload)
    assert payload["messages"] == [
        {
            "role": "user",
            "content": (
                "Return exactly RESTORK_OK. "
                "This is a public synthetic connection test."
            ),
        }
    ]
    assert payload["max_tokens"] == 16
    assert payload["thinking"] == {"type": "disabled"}
    serialized = report.model_dump_json()
    assert "synthetic-secret" not in serialized
    assert "RESTORK_OK" not in serialized


def test_provider_diagnostic_normalizes_auth_and_model_failures(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    _write_config(config_path)

    for response, expected in (
        (OutboundResponse(401, {}, b"{}"), "authentication_failed"),
        (OutboundResponse(429, {}, b"{}"), "rate_limited"),
        (OutboundResponse(200, {}, b'{"data":[{"id":"another-model"}]}'), "model_unavailable"),
    ):
        gateway = SequenceGateway([response])
        report = asyncio.run(
            DeepSeekProviderDiagnostics(
                config_path,
                keychain=FakeKeychain(),
                gateway_factory=lambda _config, gateway=gateway: gateway,
            ).diagnose()
        )
        assert report.status == expected
        assert report.connection_ok is False
