"""Experimental read-only QQ Music playlist and chart adapter."""

from __future__ import annotations

import asyncio
import json
import re
import unicodedata
from collections import Counter
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from hashlib import sha256
from urllib.parse import parse_qs, urlencode, urlsplit

from restork.contracts.outbound import OutboundEnvelope
from restork.contracts.types import DataClass, PolicyDecision
from restork.daily.models import MusicDiscovery
from restork.daily.music import (
    PlaylistDocument,
    PlaylistItem,
    PlaylistSource,
    select_playlist_item,
)
from restork.network.gateway import (
    OutboundDeniedError,
    OutboundGateway,
    OutboundRequest,
    OutboundResponse,
)

_PLAYLIST_ENDPOINT = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg"
_MUSICU_ENDPOINT = "https://u.y.qq.com/cgi-bin/musicu.fcg"
_PUBLIC_PLAYLIST_PREFIX = "https://y.qq.com/n/ryqq_v2/playlist/"
_PUBLIC_SONG_PREFIX = "https://y.qq.com/n/ryqq/songDetail/"
_PUBLIC_CHART_URL = "https://y.qq.com/n/ryqq_v2/toplist/59"
_COVER_PREFIX = "https://y.gtimg.cn/music/photo_new/T002R300x300M000"
_SHARE_HOSTS = frozenset({"i2.y.qq.com", "y.qq.com", "www.y.qq.com"})
_PLAYLIST_PATH = re.compile(r"^/n/ryqq(?:_v2)?/playlist/(?P<id>[0-9]{1,20})/?$")
_IDENTIFIER = re.compile(r"^[0-9]{1,20}$")
_MID = re.compile(r"^[A-Za-z0-9]{5,32}$")
_MAXIMUM_TRACKS = 2_000
_HONG_KONG_CHART_ID = 59


class QQMusicError(RuntimeError):
    """A bounded provider failure that never includes response or account data."""


@dataclass(frozen=True)
class QQMusicPlaylistIdentity:
    playlist_id: str
    public_url: str


@dataclass(frozen=True)
class QQMusicChartEntry:
    rank: int
    song_id: int
    title: str
    artist: str
    album_mid: str


@dataclass(frozen=True)
class QQMusicChart:
    name: str
    updated_on: date | None
    entries: tuple[QQMusicChartEntry, ...]


@dataclass(frozen=True)
class QQMusicSongDetail:
    song_id: int
    song_mid: str
    title: str
    artist: str
    album: str
    album_mid: str
    language: str
    genre: str
    label: str
    published_on: date | None


def parse_qqmusic_playlist_url(value: str) -> QQMusicPlaylistIdentity:
    """Extract only a public playlist ID, discarding all owner/share parameters."""

    normalized = value.strip()
    if not normalized or len(normalized) > 2_048:
        raise ValueError("QQ Music share link is empty or too long.")
    try:
        parsed = urlsplit(normalized)
        port = parsed.port
    except ValueError as error:
        raise ValueError("QQ Music share link is invalid.") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname not in _SHARE_HOSTS
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in {None, 443}
    ):
        raise ValueError("Use a credential-free HTTPS QQ Music playlist link.")
    match = _PLAYLIST_PATH.fullmatch(parsed.path)
    playlist_id = match.group("id") if match is not None else ""
    if not playlist_id and parsed.path.endswith("/details/playlist.html"):
        values = parse_qs(parsed.query, keep_blank_values=False).get("id", [])
        if len(values) == 1:
            playlist_id = values[0]
    if not _IDENTIFIER.fullmatch(playlist_id):
        raise ValueError("QQ Music share link does not contain a valid playlist ID.")
    return QQMusicPlaylistIdentity(
        playlist_id=playlist_id,
        public_url=f"{_PUBLIC_PLAYLIST_PREFIX}{playlist_id}",
    )


class QQMusicClient:
    def __init__(
        self,
        gateway: OutboundGateway,
        *,
        now: Callable[[], datetime] | None = None,
        discovery_scan_limit: int = 30,
        discovery_limit: int = 5,
        detail_concurrency: int = 4,
    ) -> None:
        if not 1 <= discovery_scan_limit <= 50:
            raise ValueError("QQ Music discovery scan limit is invalid")
        if not 1 <= discovery_limit <= 5:
            raise ValueError("QQ Music discovery result limit is invalid")
        if not 1 <= detail_concurrency <= 8:
            raise ValueError("QQ Music detail concurrency is invalid")
        self._gateway = gateway
        self._now = now or (lambda: datetime.now(UTC))
        self._discovery_scan_limit = discovery_scan_limit
        self._discovery_limit = discovery_limit
        self._detail_concurrency = detail_concurrency
        self._cover_cache: dict[str, tuple[bytes, str]] = {}

    async def synchronize(
        self,
        share_url: str,
        *,
        on_date: date,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        identity = parse_qqmusic_playlist_url(share_url)
        return await self.synchronize_id(
            identity.playlist_id,
            on_date=on_date,
            preferred_genres=preferred_genres,
        )

    async def synchronize_id(
        self,
        playlist_id: str,
        *,
        on_date: date,
        preferred_genres: tuple[str, ...] = (),
    ) -> PlaylistDocument:
        if not _IDENTIFIER.fullmatch(playlist_id):
            raise ValueError("QQ Music playlist ID is invalid.")
        title, items = await self._playlist(playlist_id)
        selected = select_playlist_item(items, on_date, preferred_genres)
        selected_detail = await self._safe_song_detail(int(selected.source_item_id))
        chart = await self._safe_chart()
        chart_by_song = {entry.song_id: entry for entry in chart.entries} if chart else {}
        if selected_detail is not None:
            selected = _enrich_item(
                selected,
                selected_detail,
                chart,
                chart_by_song.get(selected_detail.song_id),
            )
            items = tuple(
                selected if item.item_id == selected.item_id else item for item in items
            )
        discoveries = (
            await self._discoveries(items, chart)
            if chart is not None
            else ()
        )
        return PlaylistDocument(
            items=items,
            source=PlaylistSource(
                provider="qqmusic",
                source_id=playlist_id,
                label=title,
                public_url=f"{_PUBLIC_PLAYLIST_PREFIX}{playlist_id}",
                synced_at=self._now(),
                refresh_supported=True,
                experimental=True,
                official_api=False,
                read_only=True,
                requires_user_consent=False,
                supports_charts=True,
            ),
            discoveries=discoveries,
        )

    async def fetch_cover(self, url: str) -> tuple[bytes, str]:
        _require_cover_url(url)
        cached = self._cover_cache.get(url)
        if cached is not None:
            return cached
        response = await self._dispatch(
            url,
            method="GET",
            payload=b"",
            purpose="daily_music_qqmusic_cover",
            classification=DataClass.PUBLIC,
            source_refs=(f"qqmusic-cover:{sha256(url.encode()).hexdigest()[:24]}",),
            headers={"Accept": "image/jpeg,image/png,image/webp"},
        )
        if response.status_code != 200:
            raise QQMusicError("QQ Music cover returned an error.")
        media_type = _media_type(response.headers)
        allowed = {"image/jpeg", "image/png", "image/webp"}
        if media_type not in allowed or not _valid_image(response.payload, media_type):
            raise QQMusicError("QQ Music cover returned unsupported image data.")
        if len(self._cover_cache) >= 8:
            self._cover_cache.pop(next(iter(self._cover_cache)))
        self._cover_cache[url] = response.payload, media_type
        return response.payload, media_type

    async def _playlist(self, playlist_id: str) -> tuple[str, tuple[PlaylistItem, ...]]:
        query = urlencode(
            {
                "type": "1",
                "json": "1",
                "utf8": "1",
                "onlysong": "0",
                "disstid": playlist_id,
                "format": "json",
                "g_tk": "5381",
                "loginUin": "0",
                "hostUin": "0",
                "inCharset": "utf8",
                "outCharset": "utf-8",
                "notice": "0",
                "platform": "yqq.json",
                "needNewCode": "0",
            }
        )
        response = await self._dispatch(
            f"{_PLAYLIST_ENDPOINT}?{query}",
            method="GET",
            payload=b"",
            purpose="daily_music_qqmusic_playlist_sync",
            classification=DataClass.PERSONAL,
            source_refs=(_private_source_ref(playlist_id),),
            headers={"Accept": "application/json"},
        )
        document = _json_response(response, "playlist")
        if _integer(document.get("code"), "playlist code") != 0:
            raise QQMusicError("QQ Music playlist returned an error.")
        raw_lists = document.get("cdlist")
        if not isinstance(raw_lists, list) or len(raw_lists) != 1:
            raise QQMusicError("QQ Music playlist response is incomplete.")
        raw_playlist = _object(raw_lists[0], "playlist")
        returned_id = _text(raw_playlist.get("disstid"), "playlist ID", maximum=20)
        if returned_id != playlist_id:
            raise QQMusicError("QQ Music playlist response does not match the requested ID.")
        title = _text(raw_playlist.get("dissname"), "playlist title", maximum=300)
        raw_tracks = raw_playlist.get("songlist")
        if not isinstance(raw_tracks, list) or not raw_tracks:
            raise QQMusicError("QQ Music playlist contains no readable tracks.")
        if len(raw_tracks) > _MAXIMUM_TRACKS:
            raise QQMusicError("QQ Music playlist exceeds the 2,000 track limit.")
        items = tuple(_playlist_track(track) for track in raw_tracks)
        identities = [item.item_id for item in items]
        if len(identities) != len(set(identities)):
            raise QQMusicError("QQ Music playlist contains duplicate track identifiers.")
        return title, items

    async def _chart(self) -> QQMusicChart:
        payload = _musicu_payload(
            module="musicToplist.ToplistInfoServer",
            method="GetDetail",
            parameters={
                "topId": _HONG_KONG_CHART_ID,
                "offset": 0,
                "num": self._discovery_scan_limit,
                "period": "",
            },
        )
        response = await self._dispatch(
            _MUSICU_ENDPOINT,
            method="POST",
            payload=payload,
            purpose="daily_music_qqmusic_hong_kong_chart",
            classification=DataClass.PUBLIC,
            source_refs=("qqmusic-chart:59",),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        document = _json_response(response, "chart")
        chart_response = _object(document.get("toplist"), "chart response")
        if _integer(chart_response.get("code"), "chart code") != 0:
            raise QQMusicError("QQ Music chart returned an error.")
        data = _object(_object(chart_response.get("data"), "chart data").get("data"), "chart")
        name = _text(data.get("title"), "chart title", maximum=200)
        raw_entries = data.get("song")
        if not isinstance(raw_entries, list) or not raw_entries:
            raise QQMusicError("QQ Music chart contains no entries.")
        entries = tuple(_chart_entry(entry) for entry in raw_entries[: self._discovery_scan_limit])
        return QQMusicChart(
            name=name,
            updated_on=_optional_date(data.get("updateTime")),
            entries=entries,
        )

    async def _song_detail(self, song_id: int) -> QQMusicSongDetail:
        payload = _musicu_payload(
            module="music.pf_song_detail_svr",
            method="get_song_detail_yqq",
            parameters={"song_id": song_id, "song_type": 0, "song_mid": ""},
            key="song",
        )
        response = await self._dispatch(
            _MUSICU_ENDPOINT,
            method="POST",
            payload=payload,
            purpose="daily_music_qqmusic_song_detail",
            classification=DataClass.PUBLIC,
            source_refs=(f"qqmusic-song:{song_id}",),
            headers={"Accept": "application/json", "Content-Type": "application/json"},
        )
        document = _json_response(response, "song detail")
        song_response = _object(document.get("song"), "song response")
        if _integer(song_response.get("code"), "song detail code") != 0:
            raise QQMusicError("QQ Music song detail returned an error.")
        data = _object(song_response.get("data"), "song detail data")
        info = _object(data.get("info"), "song information")
        track = _object(data.get("track_info"), "song track")
        returned_id = _integer(track.get("id"), "song ID")
        if returned_id != song_id:
            raise QQMusicError("QQ Music song detail does not match the requested song.")
        album = _object(track.get("album"), "song album")
        singers = track.get("singer")
        if not isinstance(singers, list) or not singers:
            raise QQMusicError("QQ Music song detail has no artist.")
        artist = " / ".join(
            _text(_object(singer, "song artist").get("name"), "artist name", maximum=100)
            for singer in singers[:10]
        )
        return QQMusicSongDetail(
            song_id=song_id,
            song_mid=_mid(track.get("mid"), "song mid"),
            title=_text(track.get("name"), "song title", maximum=300),
            artist=artist[:300],
            album=_text(album.get("name"), "album title", maximum=300, required=False),
            album_mid=_optional_mid(album.get("mid")),
            language=_information_value(info, "lan", maximum=64),
            genre=_information_value(info, "genre", maximum=128),
            label=_information_value(info, "company", maximum=200),
            published_on=_optional_date(track.get("time_public")),
        )

    async def _safe_song_detail(self, song_id: int) -> QQMusicSongDetail | None:
        try:
            return await self._song_detail(song_id)
        except (ConnectionError, OSError, TimeoutError, TypeError, ValueError, QQMusicError):
            return None

    async def _safe_chart(self) -> QQMusicChart | None:
        try:
            return await self._chart()
        except (ConnectionError, OSError, TimeoutError, TypeError, ValueError, QQMusicError):
            return None

    async def _discoveries(
        self,
        items: tuple[PlaylistItem, ...],
        chart: QQMusicChart,
    ) -> tuple[MusicDiscovery, ...]:
        existing_ids = {item.source_item_id for item in items if item.source_item_id}
        artist_counts, artist_labels = _artist_counts(items)
        semaphore = asyncio.Semaphore(self._detail_concurrency)

        async def detail(entry: QQMusicChartEntry) -> QQMusicSongDetail | None:
            async with semaphore:
                return await self._safe_song_detail(entry.song_id)

        details = await asyncio.gather(*(detail(entry) for entry in chart.entries))
        candidates: list[tuple[int, int, MusicDiscovery]] = []
        for entry, song in zip(chart.entries, details, strict=True):
            if (
                song is None
                or song.language.casefold() != "粤语"
                or str(song.song_id) in existing_ids
            ):
                continue
            affinity_artist, affinity_count = _affinity(
                song.artist,
                artist_counts,
                artist_labels,
            )
            score = entry.rank - min(12, affinity_count * 2)
            recommendation_reason = (
                f"Your playlist contains {affinity_count} track(s) by {affinity_artist}; "
                "this current Cantonese release stays close to that preference."
                if affinity_count
                else (
                    "A current Cantonese entry from the Hong Kong chart that broadens the "
                    "artist range in your private playlist."
                )
            )
            facts = [
                f"language: {song.language}",
                f"genre: {song.genre}" if song.genre else "",
                f"released {song.published_on.isoformat()}" if song.published_on else "",
                f"label: {song.label}" if song.label else "",
            ]
            song_analysis = "QQ Music structured metadata records " + "; ".join(
                fact for fact in facts if fact
            ) + "."
            updated = (
                f" updated {chart.updated_on.isoformat()}" if chart.updated_on else ""
            )
            popularity_reason = (
                f"QQ Music lists it at #{entry.rank} on {chart.name}{updated}; the chart "
                "tracks weekly play heat for Hong Kong releases from the preceding 180 days."
            )
            candidates.append(
                (
                    score,
                    entry.rank,
                    MusicDiscovery(
                        item_id=f"qqmusic:{song.song_mid}",
                        title=song.title,
                        artist=song.artist,
                        album=song.album,
                        language=song.language,
                        genre=song.genre,
                        label=song.label,
                        published_on=song.published_on,
                        chart_name=chart.name,
                        chart_rank=entry.rank,
                        chart_updated_on=chart.updated_on,
                        affinity_artist=affinity_artist,
                        affinity_count=affinity_count,
                        recommendation_reason=recommendation_reason,
                        song_analysis=song_analysis,
                        popularity_reason=popularity_reason,
                        source_url=f"{_PUBLIC_SONG_PREFIX}{song.song_mid}",
                    ),
                )
            )
        candidates.sort(key=lambda value: (value[0], value[1], value[2].item_id))
        return tuple(value[2] for value in candidates[: self._discovery_limit])

    async def _dispatch(
        self,
        destination: str,
        *,
        method: str,
        payload: bytes,
        purpose: str,
        classification: DataClass,
        source_refs: tuple[str, ...],
        headers: Mapping[str, str],
    ) -> OutboundResponse:
        envelope = OutboundEnvelope(
            destination=destination,
            resolved_address_class="public",
            method=method,
            purpose=purpose,
            source_refs=list(source_refs),
            payload_hash=sha256(payload).hexdigest(),
            classification=classification,
            redaction_summary=(
                "only a normalized playlist ID is sent; owner and account fields are discarded"
                if classification is DataClass.PERSONAL
                else "public QQ Music catalog metadata only"
            ),
            policy_version="v1",
            policy_decision=PolicyDecision.ALLOWED,
        )
        selected_headers = {
            "User-Agent": "Restork/0.1 (+https://github.com/Totoro-qaq/restork)",
            "Referer": "https://y.qq.com/",
            **headers,
        }
        try:
            return await self._gateway.dispatch(
                OutboundRequest(
                    envelope=envelope,
                    payload=payload,
                    headers=selected_headers,
                )
            )
        except OutboundDeniedError as error:
            raise QQMusicError("QQ Music request was denied by outbound policy.") from error


def _playlist_track(value: object) -> PlaylistItem:
    track = _object(value, "playlist track")
    song_id = _integer(track.get("songid"), "track ID")
    song_mid = _mid(track.get("songmid"), "track mid")
    singers = track.get("singer")
    if not isinstance(singers, list) or not singers:
        raise QQMusicError("QQ Music playlist track has no artist.")
    artists = " / ".join(
        _text(_object(singer, "track artist").get("name"), "artist", maximum=100)
        for singer in singers[:10]
    )[:300]
    album_mid = _optional_mid(track.get("albummid"))
    return PlaylistItem(
        item_id=f"qqmusic:{song_mid}",
        title=_text(track.get("songname"), "track title", maximum=300),
        artist=artists,
        album=_text(track.get("albumname"), "album", maximum=300, required=False),
        tags=("qqmusic",),
        cover_url=_cover_url(album_mid),
        source_provider="qqmusic",
        source_item_id=str(song_id),
        source_url=f"{_PUBLIC_SONG_PREFIX}{song_mid}",
    )


def _chart_entry(value: object) -> QQMusicChartEntry:
    entry = _object(value, "chart entry")
    return QQMusicChartEntry(
        rank=_integer(entry.get("rank"), "chart rank", minimum=1, maximum=1_000),
        song_id=_integer(entry.get("songId"), "chart song ID"),
        title=_text(entry.get("title"), "chart song title", maximum=300),
        artist=_text(entry.get("singerName"), "chart artist", maximum=300),
        album_mid=_optional_mid(entry.get("albumMid")),
    )


def _enrich_item(
    item: PlaylistItem,
    detail: QQMusicSongDetail,
    chart: QQMusicChart | None,
    chart_entry: QQMusicChartEntry | None,
) -> PlaylistItem:
    facts = [
        f"released {detail.published_on.isoformat()}" if detail.published_on else "",
        f"language: {detail.language}" if detail.language else "",
        f"genre: {detail.genre}" if detail.genre else "",
        f"label: {detail.label}" if detail.label else "",
    ]
    note = "QQ Music structured metadata records " + "; ".join(
        fact for fact in facts if fact
    ) + "."
    popularity_reason = ""
    if chart is not None and chart_entry is not None:
        updated = f" updated {chart.updated_on.isoformat()}" if chart.updated_on else ""
        popularity_reason = (
            f"QQ Music lists it at #{chart_entry.rank} on {chart.name}{updated}; the chart "
            "tracks weekly play heat for Hong Kong releases from the preceding 180 days."
        )
    tags = tuple(dict.fromkeys((*item.tags, detail.language, detail.genre)))
    return replace(
        item,
        title=detail.title or item.title,
        artist=detail.artist or item.artist,
        album=detail.album or item.album,
        tags=tuple(tag for tag in tags if tag),
        note=note,
        cover_url=_cover_url(detail.album_mid) or item.cover_url,
        source_item_id=str(detail.song_id),
        source_url=f"{_PUBLIC_SONG_PREFIX}{detail.song_mid}",
        language=detail.language,
        genre=detail.genre,
        published_on=detail.published_on,
        popularity_reason=popularity_reason,
    )


def _artist_counts(
    items: tuple[PlaylistItem, ...],
) -> tuple[Counter[str], dict[str, str]]:
    counts: Counter[str] = Counter()
    labels: dict[str, str] = {}
    for item in items:
        for artist in _split_artists(item.artist):
            normalized = _normalized_artist(artist)
            if not normalized:
                continue
            counts[normalized] += 1
            labels.setdefault(normalized, artist)
    return counts, labels


def _affinity(
    artists: str,
    counts: Counter[str],
    labels: dict[str, str],
) -> tuple[str, int]:
    matches = [
        (counts[_normalized_artist(artist)], _normalized_artist(artist))
        for artist in _split_artists(artists)
        if _normalized_artist(artist) in counts
    ]
    if not matches:
        return "", 0
    count, normalized = max(matches, key=lambda value: (value[0], value[1]))
    return labels.get(normalized, normalized), count


def _split_artists(value: str) -> tuple[str, ...]:
    return tuple(part.strip() for part in re.split(r"\s*/\s*", value) if part.strip())


def _normalized_artist(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def _information_value(info: dict[str, object], name: str, *, maximum: int) -> str:
    section = info.get(name)
    if not isinstance(section, dict):
        return ""
    content = section.get("content")
    if not isinstance(content, list) or not content or not isinstance(content[0], dict):
        return ""
    return _text(content[0].get("value"), name, maximum=maximum, required=False)


def _musicu_payload(
    *,
    module: str,
    method: str,
    parameters: dict[str, object],
    key: str = "toplist",
) -> bytes:
    return json.dumps(
        {
            "comm": {"ct": 24, "cv": 0},
            key: {"module": module, "method": method, "param": parameters},
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode()


def _json_response(response: OutboundResponse, label: str) -> dict[str, object]:
    if response.status_code != 200:
        raise QQMusicError(f"QQ Music {label} returned an error.")
    if _media_type(response.headers) not in {"application/json", "text/plain"}:
        raise QQMusicError(f"QQ Music {label} returned unsupported content.")
    try:
        document = json.loads(response.payload.decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise QQMusicError(f"QQ Music {label} returned invalid JSON.") from error
    return _object(document, label)


def _reject_constant(value: str) -> None:
    raise ValueError(f"non-finite JSON constant is forbidden: {value}")


def _media_type(headers: Mapping[str, str]) -> str:
    value = next(
        (header for key, header in headers.items() if key.casefold() == "content-type"),
        "",
    )
    return value.partition(";")[0].strip().casefold()


def _object(value: object, label: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise QQMusicError(f"QQ Music {label} has an invalid shape.")
    return value


def _text(
    value: object,
    label: str,
    *,
    maximum: int,
    required: bool = True,
) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise QQMusicError(f"QQ Music {label} is invalid.")
    selected = " ".join(value.split()).strip()
    if (required and not selected) or len(selected) > maximum:
        raise QQMusicError(f"QQ Music {label} exceeds its bounds.")
    return selected


def _integer(
    value: object,
    label: str,
    *,
    minimum: int = 0,
    maximum: int = 10**18,
) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not minimum <= value <= maximum:
        raise QQMusicError(f"QQ Music {label} is invalid.")
    return value


def _mid(value: object, label: str) -> str:
    selected = _text(value, label, maximum=32)
    if not _MID.fullmatch(selected):
        raise QQMusicError(f"QQ Music {label} is invalid.")
    return selected


def _optional_mid(value: object) -> str:
    if value is None or value == "":
        return ""
    return _mid(value, "catalog mid")


def _optional_date(value: object) -> date | None:
    if value is None or value == "" or value == "0000-00-00":
        return None
    if not isinstance(value, str) or len(value) != 10:
        raise QQMusicError("QQ Music date is invalid.")
    try:
        return date.fromisoformat(value)
    except ValueError as error:
        raise QQMusicError("QQ Music date is invalid.") from error


def _cover_url(album_mid: str) -> str:
    return f"{_COVER_PREFIX}{album_mid}.jpg" if album_mid else ""


def _require_cover_url(value: str) -> None:
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "y.gtimg.cn"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/music/photo_new/T002R300x300M000")
        or not parsed.path.endswith(".jpg")
    ):
        raise ValueError("QQ Music cover URL is invalid.")


def _valid_image(payload: bytes, media_type: str) -> bool:
    if not payload:
        return False
    if media_type == "image/jpeg":
        return payload.startswith(b"\xff\xd8\xff")
    if media_type == "image/png":
        return payload.startswith(b"\x89PNG\r\n\x1a\n")
    return payload.startswith(b"RIFF") and payload[8:12] == b"WEBP"


def _private_source_ref(playlist_id: str) -> str:
    digest = sha256(playlist_id.encode()).hexdigest()[:24]
    return f"qqmusic-playlist:{digest}"


__all__ = [
    "QQMusicClient",
    "QQMusicError",
    "QQMusicPlaylistIdentity",
    "parse_qqmusic_playlist_url",
]
