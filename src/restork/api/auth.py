"""Single-use local pairing and audience/scope-bound bearer tokens."""

from __future__ import annotations

import secrets
from collections.abc import Callable, Collection
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

WEB_AUDIENCE = "restork-web"
CLI_AUDIENCE = "restork-cli"

RUNS_READ = "runs:read"
RUNS_WRITE = "runs:write"
APPROVALS_READ = "approvals:read"
APPROVALS_DECIDE = "approvals:decide"
EFFECTS_RESOLVE = "effects:resolve"
TOKENS_MANAGE = "tokens:manage"
MEMORY_READ = "memory:read"
MEMORY_WRITE = "memory:write"
TASKS_READ = "tasks:read"
TASKS_WRITE = "tasks:write"
RADAR_READ = "radar:read"
RADAR_WRITE = "radar:write"
DAILY_READ = "daily:read"

WEB_SCOPES = frozenset(
    {
        RUNS_READ,
        RUNS_WRITE,
        APPROVALS_READ,
        APPROVALS_DECIDE,
        EFFECTS_RESOLVE,
        TOKENS_MANAGE,
        MEMORY_READ,
        MEMORY_WRITE,
        TASKS_READ,
        TASKS_WRITE,
        RADAR_READ,
        RADAR_WRITE,
        DAILY_READ,
    }
)
CLI_SCOPES = WEB_SCOPES

_AUDIENCE_MAX_SCOPES = {
    WEB_AUDIENCE: WEB_SCOPES,
    CLI_AUDIENCE: CLI_SCOPES,
}


class InvalidAccessToken(PermissionError):
    """Raised when bearer material is absent from authority or has expired."""


class InsufficientAccessToken(PermissionError):
    """Raised when a valid token has the wrong audience or scopes."""


@dataclass(frozen=True)
class AccessToken:
    value: str = field(repr=False)
    audience: str
    scopes: frozenset[str]
    expires_at: datetime


@dataclass(frozen=True)
class _PairingChallenge:
    code: str = field(repr=False)
    audience: str
    scopes: frozenset[str]
    expires_at: datetime


class PairingAuthority:
    def __init__(
        self,
        *,
        ttl_seconds: int = 300,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if ttl_seconds < 1:
            raise ValueError("token TTL must be positive")
        self._clock = clock or (lambda: datetime.now(UTC))
        self._ttl = timedelta(seconds=ttl_seconds)
        self._tokens: dict[str, AccessToken] = {}
        self._challenges: dict[str, _PairingChallenge] = {}
        self._initial_code = self.new_pairing_code(WEB_AUDIENCE, WEB_SCOPES)

    @property
    def pairing_code(self) -> str:
        """Return the initial Web pairing code for foreground startup display."""
        return self._initial_code

    def new_pairing_code(self, audience: str, scopes: Collection[str]) -> str:
        allowed_scopes = _AUDIENCE_MAX_SCOPES.get(audience)
        requested_scopes = frozenset(scopes)
        if allowed_scopes is None:
            raise ValueError("unsupported token audience")
        if not requested_scopes or not requested_scopes <= allowed_scopes:
            raise ValueError("pairing scopes exceed the audience policy")
        code = secrets.token_urlsafe(24)
        self._challenges[code] = _PairingChallenge(
            code=code,
            audience=audience,
            scopes=requested_scopes,
            expires_at=self._clock() + self._ttl,
        )
        return code

    def pair(self, code: str, audience: str) -> AccessToken:
        challenge_key = next(
            (
                candidate
                for candidate in self._challenges
                if secrets.compare_digest(code, candidate)
            ),
            None,
        )
        if challenge_key is None:
            raise PermissionError("invalid pairing code")
        challenge = self._challenges.pop(challenge_key)
        if challenge.expires_at <= self._clock():
            raise PermissionError("expired pairing code")
        if challenge.audience != audience:
            raise PermissionError("pairing code has the wrong audience")
        token = AccessToken(
            secrets.token_urlsafe(32),
            challenge.audience,
            challenge.scopes,
            self._clock() + self._ttl,
        )
        self._tokens[token.value] = token
        return token

    def verify(
        self,
        value: str,
        audiences: Collection[str] | str,
        required_scopes: Collection[str] = (),
    ) -> AccessToken:
        allowed_audiences = {audiences} if isinstance(audiences, str) else set(audiences)
        token = self._tokens.get(value)
        if token is None or token.expires_at <= self._clock():
            self._tokens.pop(value, None)
            raise InvalidAccessToken("invalid or expired access token")
        if token.audience not in allowed_audiences:
            raise InsufficientAccessToken("access token has the wrong audience")
        missing_scopes = set(required_scopes) - token.scopes
        if missing_scopes:
            raise InsufficientAccessToken("access token lacks the required scope")
        return token

    def revoke(self, value: str) -> None:
        self._tokens.pop(value, None)

    def rotate(self, value: str, audiences: Collection[str] | str) -> AccessToken:
        current = self.verify(value, audiences, {TOKENS_MANAGE})
        self.revoke(value)
        token = AccessToken(
            secrets.token_urlsafe(32),
            current.audience,
            current.scopes,
            self._clock() + self._ttl,
        )
        self._tokens[token.value] = token
        return token
