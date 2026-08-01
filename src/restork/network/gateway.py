"""Fail-closed policy evaluation for every Core-owned outbound request."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse

from restork.contracts.types import DataClass, PolicyDecision


@dataclass(frozen=True)
class OutboundPolicy:
    allowed_origins: frozenset[str]


def evaluate_outbound(
    *, destination: str, classification: DataClass, policy: OutboundPolicy
) -> PolicyDecision:
    """Allow only exact HTTPS origins and non-sensitive outbound payload classes."""
    if classification in {DataClass.SECRET, DataClass.CREDENTIAL}:
        return PolicyDecision.DENIED

    parsed = urlparse(destination)
    if parsed.scheme != "https" or parsed.hostname is None:
        return PolicyDecision.DENIED

    origin = f"{parsed.scheme}://{parsed.netloc}"
    if origin not in policy.allowed_origins:
        return PolicyDecision.DENIED
    return PolicyDecision.ALLOWED
