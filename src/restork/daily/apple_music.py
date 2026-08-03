"""Official Apple Music API public catalog-playlist adapter."""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Callable, Mapping
from datetime import UTC, date, datetime
from hashlib import sha256
from urllib.parse import parse_qsl, quote, urljoin, urlsplit, urlunsplit

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.daily.music import PlaylistDocument, PlaylistItem, PlaylistSource
from restork.network.gateway import (
    OutboundDeniedError,
    OutboundGateway,
    OutboundRequest,
    OutboundResponse,
)

_API_ORIGIN = "https://api.music.apple.com"
_ARTWORK_HOSTS = frozenset(
    {
        "is1-ssl.mzstatic.com",
        "is2-ssl.mzstatic.com",
        "is3-ssl.mzstatic.com",
        "is4-ssl.mzstatic.com",
        "is5-ssl.mzstatic.com",
    }
)
_APPLE_ID = re.compile(r"^[A-Za-z0-9._-]{3,128}$")
_MAXIMUM_TRACKS = 2_000
_MAXIMUM_PAGES = 20


class AppleMusicError(RuntimeError):
    """A bounded official-provider failure that never includes credential material."""


class AppleMusicClient:
    def __init__(
        self,
        gateway: OutboundGateway,
        developer_token: Callable[[], str],
        music_user_token: Callable[[], str] | None = None,
    ) -> None:
        self._gateway = gateway
        self._developer_token = developer_token
        self._music_user_token = music_user_token
        self._cover_cache: dict[str, tuple[bytes, str]] = {}

    async def synchronize(
        self,
        share_url: str,
        *,
        on_date: date,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        del on_date, preferred_genres
        storefront, playlist_id, public_url = parse_apple_music_playlist_url(share_url)
        return await self._synchronize_identity(storefront, playlist_id, public_url)

    async def synchronize_id(
        self,
        source_id: str,
        *,
        on_date: date | None = None,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        del on_date, preferred_genres
        storefront, separator, playlist_id = source_id.partition(":")
        if (
            not separator
            or len(storefront) != 2
            or not storefront.isascii()
            or not storefront.islower()
            or not storefront.isalpha()
            or _APPLE_ID.fullmatch(playlist_id) is None
        ):
            raise ValueError("Apple Music playlist identity is invalid.")
        return await self._synchronize_identity(storefront, playlist_id, "")

    async def _synchronize_identity(
        self, storefront: str, playlist_id: str, submitted_public_url: str
    ) -> PlaylistDocument:
        developer_token = await asyncio.to_thread(self._developer_token)
        _validate_secret(developer_token)
        music_user_token = ""
        if self._music_user_token is not None:
            try:
                music_user_token = await asyncio.to_thread(self._music_user_token)
                _validate_secret(music_user_token)
            except LookupError:
                music_user_token = ""
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {developer_token}",
        }
        if music_user_token:
            headers["Music-User-Token"] = music_user_token
        endpoint = (
            f"{_API_ORIGIN}/v1/catalog/{storefront}/playlists/"
            f"{quote(playlist_id, safe='._-')}?include=tracks"
        )
        root = _json_response(
            await self._dispatch(
                endpoint,
                purpose="daily_music_apple_catalog_playlist_sync",
                source_refs=(f"apple-playlist:{sha256(playlist_id.encode()).hexdigest()[:24]}",),
                headers=headers,
            )
        )
        data = root.get("data")
        if not isinstance(data, list) or len(data) != 1:
            raise AppleMusicError("Apple Music playlist response is incomplete.")
        playlist = _object(data[0], "playlist")
        if (
            _text(playlist.get("id"), "playlist ID", maximum=128) != playlist_id
            or playlist.get("type") != "playlists"
        ):
            raise AppleMusicError("Apple Music response does not match the requested playlist.")
        attributes = _object(playlist.get("attributes"), "playlist attributes")
        title = _text(attributes.get("name"), "playlist title", maximum=300)
        provider_public_url = _public_url(attributes.get("url"), required=False)
        public_url = provider_public_url or submitted_public_url
        if not public_url:
            raise AppleMusicError("Apple Music playlist URL is unavailable.")
        relationships = _object(playlist.get("relationships"), "playlist relationships")
        page = _object(relationships.get("tracks"), "playlist tracks")
        raw_tracks = _track_list(page.get("data"))
        next_url = page.get("next")
        pages = 1
        while next_url is not None:
            if pages >= _MAXIMUM_PAGES or len(raw_tracks) >= _MAXIMUM_TRACKS:
                raise AppleMusicError("Apple Music playlist pagination exceeds its bounds.")
            selected_url = _next_url(next_url, storefront, playlist_id)
            page = _json_response(
                await self._dispatch(
                    selected_url,
                    purpose="daily_music_apple_catalog_playlist_page",
                    source_refs=(
                        f"apple-playlist:{sha256(playlist_id.encode()).hexdigest()[:24]}",
                    ),
                    headers=headers,
                )
            )
            raw_tracks.extend(_track_list(page.get("data")))
            next_url = page.get("next")
            pages += 1
        if not raw_tracks or len(raw_tracks) > _MAXIMUM_TRACKS:
            raise AppleMusicError("Apple Music playlist contains no bounded readable tracks.")
        items = tuple(_track(track, storefront) for track in raw_tracks)
        identities = [item.item_id for item in items]
        if len(identities) != len(set(identities)):
            raise AppleMusicError("Apple Music playlist contains duplicate track identifiers.")
        return PlaylistDocument(
            items=items,
            source=PlaylistSource(
                provider="apple-music",
                source_id=f"{storefront}:{playlist_id}",
                label=title,
                public_url=public_url,
                synced_at=datetime.now(UTC),
                refresh_supported=True,
                experimental=False,
                official_api=True,
                read_only=True,
                requires_user_consent=True,
                supports_charts=False,
            ),
        )

    async def fetch_cover(self, url: str) -> tuple[bytes, str]:
        selected = _artwork_url(url)
        cached = self._cover_cache.get(selected)
        if cached is not None:
            return cached
        response = await self._dispatch(
            selected,
            purpose="daily_music_apple_cover",
            source_refs=(f"apple-cover:{sha256(selected.encode()).hexdigest()[:24]}",),
            headers={"Accept": "image/jpeg,image/png,image/webp"},
        )
        if response.status_code != 200:
            raise AppleMusicError("Apple Music cover returned an error.")
        media_type = _media_type(response.headers)
        if media_type not in {"image/jpeg", "image/png", "image/webp"} or not _valid_image(
            response.payload, media_type
        ):
            raise AppleMusicError("Apple Music cover returned unsupported image data.")
        if len(self._cover_cache) >= 8:
            self._cover_cache.pop(next(iter(self._cover_cache)))
        self._cover_cache[selected] = response.payload, media_type
        return response.payload, media_type

    async def _dispatch(
        self,
        destination: str,
        *,
        purpose: str,
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
            classification=DataClass.PERSONAL,
            redaction_summary=(
                "official Apple Music request; credentials remain in ephemeral headers and "
                "are excluded from the audit envelope"
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
                        **headers,
                    },
                )
            )
        except OutboundDeniedError as error:
            raise AppleMusicError("Apple Music request was denied by outbound policy.") from error


def parse_apple_music_playlist_url(value: str) -> tuple[str, str, str]:
    normalized = value.strip()
    if not normalized or len(normalized) > 2_048:
        raise ValueError("Apple Music playlist share link is empty or too long.")
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as error:
        raise ValueError("Apple Music playlist share link is invalid.") from error
    segments = [segment for segment in parsed.path.split("/") if segment]
    if (
        parsed.scheme != "https"
        or parsed.hostname != "music.apple.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
        or len(segments) != 4
        or segments[1] != "playlist"
        or len(segments[0]) != 2
        or not segments[0].isascii()
        or not segments[0].isalpha()
        or not segments[2]
        or len(segments[2]) > 200
        or _APPLE_ID.fullmatch(segments[3]) is None
    ):
        raise ValueError("Use a public Apple Music catalog-playlist link.")
    storefront = segments[0].lower()
    playlist_id = segments[3]
    public_url = (
        f"https://music.apple.com/{storefront}/playlist/"
        f"{quote(segments[2], safe='._-')}/{quote(playlist_id, safe='._-')}"
    )
    return storefront, playlist_id, public_url


def _track(value: object, storefront: str) -> PlaylistItem:
    track = _object(value, "track")
    track_id = _text(track.get("id"), "track ID", maximum=128)
    if track.get("type") != "songs" or _APPLE_ID.fullmatch(track_id) is None:
        raise AppleMusicError("Apple Music track identity is invalid.")
    attributes = _object(track.get("attributes"), "track attributes")
    genres = attributes.get("genreNames", [])
    if not isinstance(genres, list) or len(genres) > 20:
        raise AppleMusicError("Apple Music genres are invalid.")
    selected_genres = tuple(
        _text(genre, "genre", maximum=80) for genre in genres[:5]
    )
    published_on = _optional_date(attributes.get("releaseDate"))
    facts = [
        f"released {published_on.isoformat()}" if published_on else "",
        f"genre: {' / '.join(selected_genres)}" if selected_genres else "",
    ]
    analysis = "; ".join(fact for fact in facts if fact)
    artwork = attributes.get("artwork")
    cover_url = (
        _artwork_url(_object(artwork, "artwork").get("url")) if artwork is not None else ""
    )
    source_url = _public_url(attributes.get("url"), required=False) or (
        f"https://music.apple.com/{storefront}/song/{quote(track_id, safe='._-')}"
    )
    return PlaylistItem(
        item_id=f"apple-music:{track_id}",
        title=_text(attributes.get("name"), "track name", maximum=300),
        artist=_text(attributes.get("artistName"), "artist name", maximum=300),
        album=_text(
            attributes.get("albumName", ""), "album name", maximum=300, required=False
        ),
        tags=("apple-music", *selected_genres),
        note=(
            f"Apple Music catalog metadata records {analysis}."
            if analysis
            else "No reviewed structured song metadata is available."
        ),
        cover_url=cover_url,
        source_provider="apple-music",
        source_item_id=track_id,
        source_url=source_url,
        genre=" / ".join(selected_genres),
        published_on=published_on,
    )


def _next_url(value: object, storefront: str, playlist_id: str) -> str:
    if not isinstance(value, str) or not value:
        raise AppleMusicError("Apple Music pagination URL is invalid.")
    selected = urljoin(f"{_API_ORIGIN}/", value)
    parsed = urlsplit(selected)
    expected_path = (
        f"/v1/catalog/{storefront}/playlists/{quote(playlist_id, safe='._-')}/tracks"
    )
    if (
        parsed.scheme != "https"
        or parsed.hostname != "api.music.apple.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or parsed.path != expected_path
        or any(key not in {"offset", "limit"} for key, _ in parse_qsl(parsed.query))
    ):
        raise AppleMusicError("Apple Music pagination URL is invalid.")
    return selected


def _public_url(value: object, *, required: bool = True) -> str:
    if value in {None, ""} and not required:
        return ""
    if not isinstance(value, str) or len(value) > 2_048:
        raise AppleMusicError("Apple Music public URL is invalid.")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "music.apple.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
    ):
        raise AppleMusicError("Apple Music public URL is invalid.")
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _artwork_url(value: object) -> str:
    if not isinstance(value, str) or not value or len(value) > 4_096:
        raise AppleMusicError("Apple Music artwork URL is invalid.")
    rendered = value.replace("{w}", "300").replace("{h}", "300").replace("{f}", "jpg")
    parsed = urlsplit(rendered)
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _ARTWORK_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or "{" in rendered
        or not parsed.path.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))
    ):
        raise AppleMusicError("Apple Music artwork URL is invalid.")
    return rendered


def _validate_secret(value: str) -> None:
    if (
        not value
        or len(value) > 16_384
        or any(character.isspace() or ord(character) < 32 for character in value)
    ):
        raise AppleMusicError("Apple Music native credential is invalid.")


def _json_response(response: OutboundResponse) -> dict[str, object]:
    if response.status_code != 200:
        raise AppleMusicError("Apple Music API returned an error.")
    try:
        value = json.loads(response.payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AppleMusicError("Apple Music API returned invalid JSON.") from error
    return _object(value, "response")


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise AppleMusicError(f"Apple Music {label} is invalid.")
    return value


def _track_list(value: object) -> list[object]:
    if not isinstance(value, list):
        raise AppleMusicError("Apple Music track page is invalid.")
    return list(value)


def _text(value: object, label: str, *, maximum: int, required: bool = True) -> str:
    if not isinstance(value, str):
        raise AppleMusicError(f"Apple Music {label} is invalid.")
    selected = " ".join(value.split())
    if (required and not selected) or len(selected) > maximum:
        raise AppleMusicError(f"Apple Music {label} is invalid.")
    return selected


def _optional_date(value: object) -> date | None:
    if value in {None, ""}:
        return None
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


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


__all__ = ["AppleMusicClient", "AppleMusicError", "parse_apple_music_playlist_url"]
