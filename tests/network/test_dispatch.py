from __future__ import annotations

import asyncio
from hashlib import sha256

import pytest

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import (
    DefaultOutboundGateway,
    OutboundDeniedError,
    OutboundPolicy,
    OutboundRequest,
    OutboundResponse,
)


class RecordingTransport:
    def __init__(self) -> None:
        self.called = False

    def send(self, request: OutboundRequest, timeout_seconds: float) -> OutboundResponse:
        self.called = True
        return OutboundResponse(200, {}, b"{}")


def _envelope(classification: DataClass) -> OutboundEnvelope:
    return OutboundEnvelope(
        destination="https://api.deepseek.com/chat/completions",
        resolved_address_class="public",
        method="POST",
        purpose="test",
        payload_hash=sha256(b"{}").hexdigest(),
        classification=classification,
        redaction_summary="synthetic",
        policy_version="v1",
        policy_decision=PolicyDecision.ALLOWED,
    )


def test_gateway_denies_before_transport_receives_sensitive_payload() -> None:
    transport = RecordingTransport()
    gateway = DefaultOutboundGateway(
        OutboundPolicy(allowed_origins=frozenset({"https://api.deepseek.com"})),
        transport=transport,  # type: ignore[arg-type]
    )
    request = OutboundRequest(_envelope(DataClass.SECRET), b"{}", {})

    with pytest.raises(OutboundDeniedError):
        asyncio.run(gateway.dispatch(request))

    assert transport.called is False
