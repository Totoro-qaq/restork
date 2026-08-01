"""Fail-closed policy evaluation for every Core-owned outbound request."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision

_DATA_CLASS_ORDER = {
    DataClass.PUBLIC: 0,
    DataClass.PERSONAL: 1,
    DataClass.CONFIDENTIAL: 2,
    DataClass.SECRET: 3,
    DataClass.CREDENTIAL: 4,
}


@dataclass(frozen=True)
class OutboundPolicy:
    allowed_origins: frozenset[str]
    maximum_data_class: DataClass = DataClass.PUBLIC
    maximum_response_bytes: int = 1_000_000


@dataclass(frozen=True)
class OutboundRequest:
    """Ephemeral request bytes; never store this object in SQLite or an event."""

    envelope: OutboundEnvelope
    payload: bytes
    headers: Mapping[str, str]


@dataclass(frozen=True)
class OutboundResponse:
    status_code: int
    headers: Mapping[str, str]
    payload: bytes


class OutboundGateway(Protocol):
    """Minimal network capability exposed to provider adapters."""

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse: ...


class OutboundDeniedError(PermissionError):
    """Raised before any outbound bytes are sent when policy verification fails."""


class _DenyRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        return None


class UrllibTransport:
    """Small transport kept inside the gateway boundary, with redirects disabled."""

    def send(self, request: OutboundRequest, timeout_seconds: float) -> OutboundResponse:
        wire_request = Request(
            request.envelope.destination,
            data=request.payload,
            headers=dict(request.headers),
            method=request.envelope.method,
        )
        opener = build_opener(_DenyRedirects())
        try:
            with opener.open(wire_request, timeout=timeout_seconds) as response:
                payload = response.read()
                return OutboundResponse(response.status, dict(response.headers.items()), payload)
        except HTTPError as error:
            return OutboundResponse(error.code, dict(error.headers.items()), error.read())


class DefaultOutboundGateway:
    """The sole Core-owned HTTP dispatch point for adapters and connectors."""

    def __init__(
        self,
        policy: OutboundPolicy,
        *,
        transport: UrllibTransport | None = None,
        timeout_seconds: float = 30.0,
    ) -> None:
        self._policy = policy
        self._transport = transport or UrllibTransport()
        self._timeout_seconds = timeout_seconds

    async def dispatch(self, request: OutboundRequest) -> OutboundResponse:
        decision = evaluate_outbound(
            destination=request.envelope.destination,
            classification=request.envelope.classification,
            policy=self._policy,
            resolved_address_class=request.envelope.resolved_address_class,
        )
        if decision is not PolicyDecision.ALLOWED:
            raise OutboundDeniedError("outbound request denied by policy")
        if request.envelope.policy_decision is not PolicyDecision.ALLOWED:
            raise OutboundDeniedError("envelope does not carry an allowed policy decision")
        if len(request.payload) > self._policy.maximum_response_bytes:
            raise OutboundDeniedError("request exceeds outbound byte budget")
        response = await asyncio.to_thread(
            self._transport.send, request, self._timeout_seconds
        )
        if len(response.payload) > self._policy.maximum_response_bytes:
            raise OutboundDeniedError("response exceeds outbound byte budget")
        return response


def evaluate_outbound(
    *,
    destination: str,
    classification: DataClass,
    policy: OutboundPolicy,
    resolved_address_class: str = "public",
) -> PolicyDecision:
    """Allow only exact public HTTPS origins, never credential-bearing URLs."""
    if _DATA_CLASS_ORDER[classification] > _DATA_CLASS_ORDER[policy.maximum_data_class]:
        return PolicyDecision.DENIED

    parsed = urlparse(destination)
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or resolved_address_class != "public"
    ):
        return PolicyDecision.DENIED

    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in policy.allowed_origins:
        return PolicyDecision.DENIED
    return PolicyDecision.ALLOWED
