"""Experimental read-only NetEase Cloud Music public-playlist adapter."""

from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from urllib.parse import parse_qs, urlencode, urlsplit, urlunsplit

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.daily.music import PlaylistDocument, PlaylistItem, PlaylistSource
from restork.network.gateway import (
    OutboundDeniedError,
    OutboundGateway,
    OutboundRequest,
    OutboundResponse,
)

_PLAYLIST_ENDPOINT = "https://music.163.com/api/v6/playlist/detail"
_PUBLIC_PLAYLIST_PREFIX = "https://music.163.com/playlist?id="
_PUBLIC_SONG_PREFIX = "https://music.163.com/song?id="
_SHARE_HOSTS = frozenset({"music.163.com", "www.music.163.com", "y.music.163.com"})
_COVER_HOSTS = frozenset(
    {
        "p1.music.126.net",
        "p2.music.126.net",
        "p3.music.126.net",
        "p4.music.126.net",
    }
)
_IDENTIFIER = re.compile(r"^[0-9]{1,20}$")
_MAXIMUM_TRACKS = 2_000


class NetEaseMusicError(RuntimeError):
    """A bounded provider failure that never includes response or account data."""


@dataclass(frozen=True)
class NetEasePlaylistIdentity:
    playlist_id: str
    public_url: str


def parse_netease_playlist_url(value: str) -> NetEasePlaylistIdentity:
    normalized = value.strip()
    if not normalized or len(normalized) > 2_048:
        raise ValueError("NetEase playlist share link is empty or too long.")
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as error:
        raise ValueError("NetEase playlist share link is invalid.") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _SHARE_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or port not in {None, 443}
    ):
        raise ValueError("Use a credential-free HTTPS NetEase playlist link.")
    candidates: list[str] = []
    if parsed.path in {"/playlist", "/m/playlist"}:
        candidates = parse_qs(parsed.query, keep_blank_values=False).get("id", [])
    if not candidates and parsed.fragment:
        fragment = urlsplit(
            f"https://music.163.com/{parsed.fragment.lstrip('/')}"
        )
        if fragment.path == "/playlist":
            candidates = parse_qs(fragment.query, keep_blank_values=False).get("id", [])
    if len(candidates) != 1 or _IDENTIFIER.fullmatch(candidates[0]) is None:
        raise ValueError("NetEase share link does not contain a valid playlist ID.")
    playlist_id = candidates[0]
    return NetEasePlaylistIdentity(
        playlist_id=playlist_id,
        public_url=f"{_PUBLIC_PLAYLIST_PREFIX}{playlist_id}",
    )


class NetEaseMusicClient:
    def __init__(self, gateway: OutboundGateway) -> None:
        self._gateway = gateway
        self._cover_cache: dict[str, tuple[bytes, str]] = {}

    async def synchronize(
        self,
        share_url: str,
        *,
        on_date: date,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        del on_date, preferred_genres
        identity = parse_netease_playlist_url(share_url)
        return await self.synchronize_id(identity.playlist_id)

    async def synchronize_id(
        self,
        playlist_id: str,
        *,
        on_date: date | None = None,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        del on_date, preferred_genres
        if _IDENTIFIER.fullmatch(playlist_id) is None:
            raise ValueError("NetEase playlist ID is invalid.")
        query = urlencode({"id": playlist_id, "n": "2000", "s": "0"})
        response = await self._dispatch(
            f"{_PLAYLIST_ENDPOINT}?{query}",
            purpose="daily_music_netease_playlist_sync",
            classification=DataClass.PERSONAL,
            source_refs=(f"netease-playlist:{sha256(playlist_id.encode()).hexdigest()[:24]}",),
            headers={"Accept": "application/json"},
        )
        document = _json_response(response)
        if _integer(document.get("code"), "response code") != 200:
            raise NetEaseMusicError("NetEase playlist returned an error.")
        playlist = _object(document.get("playlist"), "playlist")
        if str(_integer(playlist.get("id"), "playlist ID")) != playlist_id:
            raise NetEaseMusicError("NetEase playlist response does not match the requested ID.")
        title = _text(playlist.get("name"), "playlist title", maximum=300)
        raw_tracks = playlist.get("tracks")
        if not isinstance(raw_tracks, list) or not raw_tracks:
            raise NetEaseMusicError("NetEase playlist contains no readable tracks.")
        if len(raw_tracks) > _MAXIMUM_TRACKS:
            raise NetEaseMusicError("NetEase playlist exceeds the 2,000 track limit.")
        items = tuple(_playlist_track(track) for track in raw_tracks)
        identities = [item.item_id for item in items]
        if len(identities) != len(set(identities)):
            raise NetEaseMusicError("NetEase playlist contains duplicate track identifiers.")
        return PlaylistDocument(
            items=items,
            source=PlaylistSource(
                provider="netease",
                source_id=playlist_id,
                label=title,
                public_url=f"{_PUBLIC_PLAYLIST_PREFIX}{playlist_id}",
                synced_at=datetime.now(UTC),
                refresh_supported=True,
                experimental=True,
                official_api=False,
                read_only=True,
                requires_user_consent=False,
                supports_charts=False,
            ),
        )

    async def fetch_cover(self, url: str) -> tuple[bytes, str]:
        selected = _cover_url(url)
        cached = self._cover_cache.get(selected)
        if cached is not None:
            return cached
        response = await self._dispatch(
            selected,
            purpose="daily_music_netease_cover",
            classification=DataClass.PUBLIC,
            source_refs=(f"netease-cover:{sha256(selected.encode()).hexdigest()[:24]}",),
            headers={"Accept": "image/jpeg,image/png,image/webp"},
        )
        if response.status_code != 200:
            raise NetEaseMusicError("NetEase cover returned an error.")
        media_type = _media_type(response.headers)
        if media_type not in {"image/jpeg", "image/png", "image/webp"} or not _valid_image(
            response.payload, media_type
        ):
            raise NetEaseMusicError("NetEase cover returned unsupported image data.")
        if len(self._cover_cache) >= 8:
            self._cover_cache.pop(next(iter(self._cover_cache)))
        self._cover_cache[selected] = response.payload, media_type
        return response.payload, media_type

    async def _dispatch(
        self,
        destination: str,
        *,
        purpose: str,
        classification: DataClass,
        source_refs: tuple[str, ...],
        headers: Mapping[str, str],
    ) -> OutboundResponse:
        envelope = OutboundEnvelope(
            destination=destination,
            resolved_address_class="public",
            method="GET",
            purpose=purpose,
            source_refs=list(source_refs),
            payload_hash=sha256(b"").hexdigest(),
            classification=classification,
            redaction_summary=(
                "only a normalized playlist ID is sent; account and tracking fields are discarded"
                if classification is DataClass.PERSONAL
                else "public NetEase image metadata only"
            ),
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        try:
            return await self._gateway.dispatch(
                OutboundRequest(
                    envelope=envelope,
                    payload=b"",
                    headers={
                        "User-Agent": "Restork/0.1 (+https://github.com/Totoro-qaq/restork)",
                        "Referer": "https://music.163.com/",
                        **headers,
                    },
                )
            )
        except OutboundDeniedError as error:
            raise NetEaseMusicError("NetEase request was denied by outbound policy.") from error


def _playlist_track(value: object) -> PlaylistItem:
    track = _object(value, "playlist track")
    track_id = _integer(track.get("id"), "track ID")
    artists = track.get("ar")
    if not isinstance(artists, list) or not 1 <= len(artists) <= 10:
        raise NetEaseMusicError("NetEase playlist track has no valid artist.")
    artist = " / ".join(
        _text(_object(item, "artist").get("name"), "artist", maximum=100)
        for item in artists
    )[:300]
    album = _object(track.get("al"), "album")
    published_on = _millisecond_date(track.get("publishTime"))
    analysis = (
        f"NetEase public metadata records release date {published_on.isoformat()}."
        if published_on is not None
        else "No reviewed structured song metadata is available."
    )
    return PlaylistItem(
        item_id=f"netease:{track_id}",
        title=_text(track.get("name"), "track title", maximum=300),
        artist=artist,
        album=_text(album.get("name"), "album", maximum=300, required=False),
        tags=("netease",),
        note=analysis,
        cover_url=_cover_url(album.get("picUrl"), required=False),
        source_provider="netease",
        source_item_id=str(track_id),
        source_url=f"{_PUBLIC_SONG_PREFIX}{track_id}",
        published_on=published_on,
    )


def _cover_url(value: object, *, required: bool = True) -> str:
    if value in {None, ""} and not required:
        return ""
    if not isinstance(value, str) or len(value) > 2_048:
        raise NetEaseMusicError("NetEase cover URL is invalid.")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname not in _COVER_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    ):
        raise NetEaseMusicError("NetEase cover URL is invalid.")
    return urlunsplit(("https", parsed.netloc.split(":", 1)[0], parsed.path, "", ""))


def _json_response(response: OutboundResponse) -> dict[str, object]:
    if response.status_code != 200:
        raise NetEaseMusicError("NetEase playlist returned an error.")
    try:
        value = json.loads(response.payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise NetEaseMusicError("NetEase playlist returned invalid JSON.") from error
    return _object(value, "response")


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise NetEaseMusicError(f"NetEase {label} is invalid.")
    return value


def _text(value: object, label: str, *, maximum: int, required: bool = True) -> str:
    if not isinstance(value, str):
        raise NetEaseMusicError(f"NetEase {label} is invalid.")
    selected = " ".join(value.split())
    if (required and not selected) or len(selected) > maximum:
        raise NetEaseMusicError(f"NetEase {label} is invalid.")
    return selected


def _integer(value: object, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise NetEaseMusicError(f"NetEase {label} is invalid.")
    return value


def _millisecond_date(value: object) -> date | None:
    if value in {None, 0}:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise NetEaseMusicError("NetEase release date is invalid.")
    try:
        return datetime.fromtimestamp(value / 1000, tz=UTC).date()
    except (OSError, OverflowError, ValueError) as error:
        raise NetEaseMusicError("NetEase release date is invalid.") from error


def _media_type(headers: Mapping[str, str]) -> str:
    value = next(
        (item for key, item in headers.items() if key.casefold() == "content-type"),
        "",
    )
    return value.split(";", 1)[0].strip().casefold()


def _valid_image(payload: bytes, media_type: str) -> bool:
    if media_type == "image/jpeg":
        return payload.startswith(b"\xff\xd8\xff")
    if media_type == "image/png":
        return payload.startswith(b"\x89PNG\r\n\x1a\n")
    return payload.startswith(b"RIFF") and payload[8:12] == b"WEBP"


__all__ = [
    "NetEaseMusicClient",
    "NetEaseMusicError",
    "NetEasePlaylistIdentity",
    "parse_netease_playlist_url",
]
