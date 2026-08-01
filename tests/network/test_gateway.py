from __future__ import annotations

from restork.contracts.types import DataClass, PolicyDecision
from restork.network.gateway import OutboundPolicy, evaluate_outbound


def test_gateway_allows_only_exact_public_origin() -> None:
    result = evaluate_outbound(
        destination="https://api.deepseek.com/chat/completions",
        classification=DataClass.PUBLIC,
        policy=OutboundPolicy(allowed_origins=frozenset({"https://api.deepseek.com"})),
    )

    assert result is PolicyDecision.ALLOWED


def test_gateway_rejects_subdomain_and_secret_payloads() -> None:
    policy = OutboundPolicy(allowed_origins=frozenset({"https://api.deepseek.com"}))

    assert (
        evaluate_outbound(
            destination="https://api.deepseek.com.attacker.test/chat/completions",
            classification=DataClass.PUBLIC,
            policy=policy,
        )
        is PolicyDecision.DENIED
    )
    assert (
        evaluate_outbound(
            destination="https://api.deepseek.com/chat/completions",
            classification=DataClass.SECRET,
            policy=policy,
        )
        is PolicyDecision.DENIED
    )
