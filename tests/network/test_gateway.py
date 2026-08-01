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
            policy=OutboundPolicy(
                allowed_origins=frozenset({"https://api.deepseek.com"}),
                maximum_data_class=DataClass.SECRET,
            ),
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


def test_gateway_rejects_credential_urls_private_addresses_and_confidential_data() -> None:
    policy = OutboundPolicy(allowed_origins=frozenset({"https://api.deepseek.com"}))

    assert (
        evaluate_outbound(
            destination="https://token@api.deepseek.com/chat/completions",
            classification=DataClass.PUBLIC,
            policy=policy,
        )
        is PolicyDecision.DENIED
    )


def test_gateway_allows_only_explicit_non_credential_query_keys() -> None:
    policy = OutboundPolicy(
        allowed_origins=frozenset({"https://api.open-meteo.com"}),
        maximum_data_class=DataClass.PERSONAL,
        allowed_query_keys=frozenset({"latitude", "longitude", "current"}),
    )

    assert (
        evaluate_outbound(
            destination=(
                "https://api.open-meteo.com/v1/forecast"
                "?latitude=0&longitude=0&current=temperature_2m"
            ),
            classification=DataClass.PERSONAL,
            policy=policy,
        )
        is PolicyDecision.ALLOWED
    )
    assert (
        evaluate_outbound(
            destination="https://api.open-meteo.com/v1/forecast?apikey=private",
            classification=DataClass.PERSONAL,
            policy=policy,
        )
        is PolicyDecision.DENIED
    )
    assert (
        evaluate_outbound(
            destination="https://api.deepseek.com/chat/completions?key=token",
            classification=DataClass.PUBLIC,
            policy=policy,
        )
        is PolicyDecision.DENIED
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
    assert (
        evaluate_outbound(
            destination="https://api.deepseek.com/chat/completions",
            classification=DataClass.CONFIDENTIAL,
            policy=policy,
        )
        is PolicyDecision.DENIED
    )
