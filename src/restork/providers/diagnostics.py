"""Bounded DeepSeek configuration, model-access, and synthetic smoke diagnostics."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from hashlib import sha256
from pathlib import Path
from time import perf_counter
from typing import Literal, Protocol
from urllib.error import URLError

from pydantic import BaseModel, ConfigDict, Field

from restork.config.loader import load_config
from restork.config.models import KeychainReference, ProviderConfig
from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import (
    DefaultOutboundGateway,
    OutboundDeniedError,
    OutboundGateway,
    OutboundPolicy,
    OutboundRequest,
    OutboundResponse,
)
from restork.providers.base import (
    ChatCompletionRequest,
    ChatMessage,
    CompletionUsage,
    ProviderErrorKind,
    ProviderResponseError,
)
from restork.providers.deepseek_chat_completions import DeepSeekChatCompletionsProvider
from restork.secrets.store import KeychainSecretStore

ProviderStatus = Literal[
    "not_configured",
    "invalid_configuration",
    "credential_missing",
    "ready",
    "connected",
    "smoke_passed",
    "authentication_failed",
    "insufficient_balance",
    "rate_limited",
    "timeout",
    "provider_unavailable",
    "model_unavailable",
    "invalid_response",
    "policy_denied",
]

_SETUP_COMMAND: Literal["uv run restork provider configure"] = (
    "uv run restork provider configure"
)
_SMOKE_MARKER = "RESTORK_OK"
_REQUEST_ID = re.compile(r"[A-Za-z0-9._:-]{1,128}")


class ProviderDiagnosticRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    smoke: bool = False


class ProviderDiagnosticReport(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    schema_version: Literal[1] = 1
    provider: Literal["deepseek"] = "deepseek"
    model: Literal["deepseek-v4-pro"] = "deepseek-v4-pro"
    status: ProviderStatus
    message: str = Field(min_length=1, max_length=500)
    setup_command: Literal["uv run restork provider configure"] = _SETUP_COMMAND
    config_present: bool
    config_valid: bool
    credential_present: bool
    connection_checked: bool
    connection_ok: bool | None = None
    model_available: bool | None = None
    smoke_checked: bool = False
    smoke_ok: bool | None = None
    restart_required: bool = False
    latency_ms: int | None = Field(default=None, ge=0)
    request_id: str | None = Field(default=None, max_length=128)
    prompt_tokens: int | None = Field(default=None, ge=0)
    completion_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class ProviderDiagnostics(Protocol):
    """Narrow diagnostic surface injected into the local API."""

    def status(self) -> ProviderDiagnosticReport: ...

    async def diagnose(self, *, smoke: bool = False) -> ProviderDiagnosticReport: ...


class ProviderSecretStore(Protocol):
    """Secret operations needed by diagnostics without exposing key material."""

    def exists(self, reference: KeychainReference) -> bool: ...

    def resolve(self, reference: KeychainReference) -> str: ...


class _ResolvedSecret:
    def __init__(self, value: str) -> None:
        self._value = value

    def resolve(self, reference: KeychainReference) -> str:
        del reference
        return self._value


GatewayFactory = Callable[[ProviderConfig], OutboundGateway]


class DeepSeekProviderDiagnostics:
    """Diagnose only provider metadata and a fixed public synthetic completion."""

    def __init__(
        self,
        config_path: Path,
        *,
        keychain: ProviderSecretStore | None = None,
        gateway_factory: GatewayFactory | None = None,
        provider_active: bool | None = None,
    ) -> None:
        self._config_path = config_path
        self._keychain = keychain or KeychainSecretStore()
        self._gateway_factory = gateway_factory or _default_gateway
        self._provider_active = provider_active

    def status(self) -> ProviderDiagnosticReport:
        config, report = self._configuration()
        if config is None:
            return report
        try:
            credential_present = self._keychain.exists(config.api_key_ref)
        except (OSError, ValueError):
            credential_present = False
        if not credential_present:
            return report.model_copy(
                update={
                    "status": "credential_missing",
                    "message": "DeepSeek API key is not available in macOS Keychain.",
                    "credential_present": False,
                }
            )
        return report.model_copy(
            update={
                "status": "ready",
                "message": (
                    "Configuration and Keychain metadata are ready; "
                    "no network check has run."
                ),
                "credential_present": True,
            }
        )

    async def diagnose(self, *, smoke: bool = False) -> ProviderDiagnosticReport:
        local = self.status()
        if local.status != "ready":
            return local
        config, reloaded = self._configuration()
        if config is None:
            return reloaded
        try:
            secret = self._keychain.resolve(config.api_key_ref)
        except (KeyError, LookupError, OSError, PermissionError, ValueError):
            return local.model_copy(
                update={
                    "status": "credential_missing",
                    "message": "DeepSeek API key requires user action in macOS Keychain.",
                    "credential_present": False,
                }
            )
        gateway = self._gateway_factory(config)
        started = perf_counter()
        try:
            response = await gateway.dispatch(_models_request(config, secret))
        except OutboundDeniedError:
            return _failed(
                local,
                "policy_denied",
                "DeepSeek model check was denied by policy",
                started,
            )
        except (TimeoutError, URLError):
            return _failed(local, "timeout", "DeepSeek model check timed out", started)
        except OSError:
            return _failed(
                local,
                "provider_unavailable",
                "DeepSeek model service is unavailable",
                started,
            )
        request_id = _request_id(response)
        if response.status_code != 200:
            return _http_failure(local, response.status_code, started, request_id=request_id)
        try:
            model_available = _model_available(response.payload, config.model)
        except (UnicodeDecodeError, json.JSONDecodeError, KeyError, TypeError, ValueError):
            return _failed(
                local,
                "invalid_response",
                "DeepSeek returned an invalid model-list response",
                started,
                request_id=request_id,
            )
        if not model_available:
            return local.model_copy(
                update={
                    "status": "model_unavailable",
                    "message": "The configured DeepSeek model is not available to this account.",
                    "connection_checked": True,
                    "connection_ok": False,
                    "model_available": False,
                    "latency_ms": _elapsed_ms(started),
                    "request_id": request_id,
                }
            )
        if not smoke:
            return local.model_copy(
                update={
                    "status": "connected",
                    "message": (
                        "DeepSeek authentication succeeded and the configured model "
                        "is available."
                    ),
                    "connection_checked": True,
                    "connection_ok": True,
                    "model_available": True,
                    "latency_ms": _elapsed_ms(started),
                    "request_id": request_id,
                }
            )
        provider = DeepSeekChatCompletionsProvider(
            config,
            gateway,
            _ResolvedSecret(secret),
        )
        try:
            completion = await provider.complete(
                ChatCompletionRequest(
                    messages=[
                        ChatMessage(
                            role="user",
                            content=(
                                "Return exactly RESTORK_OK. "
                                "This is a public synthetic connection test."
                            ),
                        )
                    ],
                    max_tokens=16,
                    thinking_enabled=False,
                    classification=DataClass.PUBLIC,
                    source_refs=("synthetic:provider-doctor",),
                )
            )
        except ProviderResponseError as error:
            return _smoke_provider_failure(
                local,
                error,
                started,
                request_id=request_id,
            )
        except (TimeoutError, URLError):
            return _smoke_failed(
                local,
                "timeout",
                "DeepSeek smoke test timed out",
                started,
                request_id=request_id,
            )
        except OSError:
            return _smoke_failed(
                local,
                "provider_unavailable",
                "DeepSeek smoke test is unavailable",
                started,
                request_id=request_id,
            )
        smoke_ok = completion.content is not None and completion.content.strip() == _SMOKE_MARKER
        if not smoke_ok:
            return local.model_copy(
                update={
                    "status": "invalid_response",
                    "message": "DeepSeek responded, but the fixed smoke marker was not present.",
                    "connection_checked": True,
                    "connection_ok": True,
                    "model_available": True,
                    "smoke_checked": True,
                    "smoke_ok": False,
                    "latency_ms": _elapsed_ms(started),
                    "request_id": request_id,
                    **_usage(completion.usage),
                }
            )
        return local.model_copy(
            update={
                "status": "smoke_passed",
                "message": "The fixed public DeepSeek smoke test passed.",
                "connection_checked": True,
                "connection_ok": True,
                "model_available": True,
                "smoke_checked": True,
                "smoke_ok": True,
                "latency_ms": _elapsed_ms(started),
                "request_id": request_id,
                **_usage(completion.usage),
            }
        )

    def _configuration(self) -> tuple[ProviderConfig | None, ProviderDiagnosticReport]:
        restart_required = self._provider_active is False and self._config_path.is_file()
        if not self._config_path.is_file():
            return None, ProviderDiagnosticReport(
                status="not_configured",
                message="DeepSeek provider configuration has not been created.",
                config_present=False,
                config_valid=False,
                credential_present=False,
                connection_checked=False,
            )
        try:
            config = load_config(self._config_path).provider
        except (OSError, ValueError):
            return None, ProviderDiagnosticReport(
                status="invalid_configuration",
                message="DeepSeek provider configuration is invalid.",
                config_present=True,
                config_valid=False,
                credential_present=False,
                connection_checked=False,
                restart_required=restart_required,
            )
        return config, ProviderDiagnosticReport(
            status="ready",
            message="DeepSeek configuration is valid; Keychain metadata has not been checked.",
            config_present=True,
            config_valid=True,
            credential_present=False,
            connection_checked=False,
            restart_required=restart_required,
        )


def _default_gateway(config: ProviderConfig) -> OutboundGateway:
    return DefaultOutboundGateway(
        OutboundPolicy(
            allowed_origins=frozenset({config.base_url}),
            maximum_data_class=DataClass.PUBLIC,
            maximum_response_bytes=256_000,
        ),
        timeout_seconds=15.0,
    )


def _models_request(config: ProviderConfig, secret: str) -> OutboundRequest:
    payload = b""
    return OutboundRequest(
        envelope=OutboundEnvelope(
            destination=f"{config.base_url}/models",
            resolved_address_class="public",
            method="GET",
            purpose="provider_model_check",
            source_refs=[],
            payload_hash=sha256(payload).hexdigest(),
            classification=DataClass.PUBLIC,
            redaction_summary="credential header is transient and excluded from diagnostics",
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        ),
        payload=payload,
        headers={
            "Authorization": f"Bearer {secret}",
            "Accept": "application/json",
        },
    )


def _model_available(payload: bytes, model: str) -> bool:
    document = json.loads(payload)
    if not isinstance(document, dict):
        raise TypeError("model response is invalid")
    values = document["data"]
    if not isinstance(values, list):
        raise TypeError("model list is invalid")
    identifiers: set[str] = set()
    for item in values:
        if not isinstance(item, dict):
            continue
        identifier = item.get("id")
        if isinstance(identifier, str):
            identifiers.add(identifier)
    return model in identifiers


def _http_failure(
    local: ProviderDiagnosticReport,
    status_code: int,
    started: float,
    *,
    request_id: str | None,
) -> ProviderDiagnosticReport:
    status: ProviderStatus
    if status_code == 401:
        status, message = "authentication_failed", "DeepSeek rejected the API key."
    elif status_code == 402:
        status, message = "insufficient_balance", "DeepSeek account balance is insufficient."
    elif status_code == 429:
        status, message = "rate_limited", "DeepSeek rate limit was reached."
    else:
        status = "provider_unavailable"
        message = (
            "DeepSeek model service is temporarily unavailable."
            if status_code >= 500
            else "DeepSeek rejected the model check."
        )
    return _failed(local, status, message, started, request_id=request_id)


def _smoke_provider_failure(
    local: ProviderDiagnosticReport,
    error: ProviderResponseError,
    started: float,
    *,
    request_id: str | None,
) -> ProviderDiagnosticReport:
    if error.status_code is not None:
        failure = _http_failure(local, error.status_code, started, request_id=request_id)
        return failure.model_copy(
            update={
                "connection_ok": True,
                "model_available": True,
                "smoke_checked": True,
                "smoke_ok": False,
            }
        )
    if error.kind is ProviderErrorKind.POLICY_DENIED:
        status: ProviderStatus = "policy_denied"
    elif error.kind is ProviderErrorKind.USER_ACTION_REQUIRED:
        status = "credential_missing"
    elif error.kind is ProviderErrorKind.INVALID_SCHEMA:
        status = "invalid_response"
    else:
        status = "provider_unavailable"
    return _smoke_failed(
        local,
        status,
        "DeepSeek smoke test did not complete.",
        started,
        request_id=request_id,
    )


def _smoke_failed(
    local: ProviderDiagnosticReport,
    status: ProviderStatus,
    message: str,
    started: float,
    *,
    request_id: str | None,
) -> ProviderDiagnosticReport:
    return local.model_copy(
        update={
            "status": status,
            "message": message,
            "connection_checked": True,
            "connection_ok": True,
            "model_available": True,
            "smoke_checked": True,
            "smoke_ok": False,
            "latency_ms": _elapsed_ms(started),
            "request_id": request_id,
        }
    )


def _failed(
    local: ProviderDiagnosticReport,
    status: ProviderStatus,
    message: str,
    started: float,
    *,
    request_id: str | None = None,
) -> ProviderDiagnosticReport:
    return local.model_copy(
        update={
            "status": status,
            "message": message,
            "connection_checked": True,
            "connection_ok": False,
            "latency_ms": _elapsed_ms(started),
            "request_id": request_id,
        }
    )


def _elapsed_ms(started: float) -> int:
    return max(0, round((perf_counter() - started) * 1000))


def _request_id(response: OutboundResponse) -> str | None:
    for key, value in response.headers.items():
        if key.casefold() in {"x-request-id", "x-ds-request-id", "x-ds-trace-id"}:
            return value if _REQUEST_ID.fullmatch(value) is not None else None
    return None


def _usage(usage: CompletionUsage) -> dict[str, int | None]:
    return {
        "prompt_tokens": usage.prompt_tokens,
        "completion_tokens": usage.completion_tokens,
        "total_tokens": usage.total_tokens,
    }
