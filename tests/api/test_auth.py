from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from restork.api.auth import (
    CLI_AUDIENCE,
    CLI_SCOPES,
    RUNS_READ,
    RUNS_WRITE,
    WEB_AUDIENCE,
    PairingAuthority,
)


def test_pairing_is_single_use_audience_bound_and_scope_bound() -> None:
    authority = PairingAuthority()
    token = authority.pair(authority.pairing_code, WEB_AUDIENCE)

    assert authority.verify(token.value, WEB_AUDIENCE, {RUNS_READ}) == token
    with pytest.raises(PermissionError, match="pairing"):
        authority.pair(authority.pairing_code, WEB_AUDIENCE)
    with pytest.raises(PermissionError, match="audience"):
        authority.verify(token.value, CLI_AUDIENCE, {RUNS_READ})

    limited_code = authority.new_pairing_code(WEB_AUDIENCE, {RUNS_READ})
    limited = authority.pair(limited_code, WEB_AUDIENCE)
    with pytest.raises(PermissionError, match="scope"):
        authority.verify(limited.value, WEB_AUDIENCE, {RUNS_WRITE})


def test_cli_pairing_rotation_revocation_and_expiry() -> None:
    now = [datetime(2026, 8, 2, tzinfo=UTC)]
    authority = PairingAuthority(ttl_seconds=60, clock=lambda: now[0])
    code = authority.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    token = authority.pair(code, CLI_AUDIENCE)
    replacement = authority.rotate(token.value, CLI_AUDIENCE)

    with pytest.raises(PermissionError, match="invalid"):
        authority.verify(token.value, CLI_AUDIENCE)
    assert replacement.audience == CLI_AUDIENCE
    assert replacement.scopes == CLI_SCOPES

    authority.revoke(replacement.value)
    with pytest.raises(PermissionError, match="invalid"):
        authority.verify(replacement.value, CLI_AUDIENCE)

    expiring_code = authority.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)
    expiring = authority.pair(expiring_code, CLI_AUDIENCE)
    now[0] += timedelta(seconds=61)
    with pytest.raises(PermissionError, match="expired"):
        authority.verify(expiring.value, CLI_AUDIENCE)


def test_wrong_audience_consumes_pairing_challenge() -> None:
    authority = PairingAuthority()
    code = authority.new_pairing_code(CLI_AUDIENCE, CLI_SCOPES)

    with pytest.raises(PermissionError, match="wrong audience"):
        authority.pair(code, WEB_AUDIENCE)
    with pytest.raises(PermissionError, match="invalid pairing"):
        authority.pair(code, CLI_AUDIENCE)
