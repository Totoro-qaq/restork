"""Single-use local pairing and short-lived bearer tokens."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta


@dataclass(frozen=True)
class AccessToken:
    value: str
    audience: str
    expires_at: datetime


class PairingAuthority:
    def __init__(self, *, ttl_seconds: int = 300) -> None:
        self._code = secrets.token_urlsafe(24)
        self._ttl = timedelta(seconds=ttl_seconds)
        self._tokens: dict[str, AccessToken] = {}

    @property
    def pairing_code(self) -> str:
        return self._code

    def pair(self, code: str, audience: str) -> AccessToken:
        if not secrets.compare_digest(code, self._code):
            raise PermissionError("invalid pairing code")
        self._code = ""
        token = AccessToken(secrets.token_urlsafe(32), audience, datetime.now(UTC) + self._ttl)
        self._tokens[token.value] = token
        return token

    def verify(self, value: str, audience: str) -> None:
        token = self._tokens.get(value)
        if token is None or token.audience != audience or token.expires_at <= datetime.now(UTC):
            raise PermissionError("invalid or expired access token")

    def revoke(self, value: str) -> None:
        self._tokens.pop(value, None)

    def rotate(self, value: str, audience: str) -> AccessToken:
        self.verify(value, audience)
        self.revoke(value)
        token = AccessToken(secrets.token_urlsafe(32), audience, datetime.now(UTC) + self._ttl)
        self._tokens[token.value] = token
        return token
