//! Experimental, read-only QQ Music catalog connector.
//!
//! Only a normalized playlist ID leaves the process. Share-owner, avatar,
//! tracking, cookie, and login fields are neither sent nor persisted.

use std::collections::{BTreeMap, BTreeSet};

use chrono::{NaiveDate, Utc};
use futures_util::{StreamExt, stream};
use reqwest::{Response, header};
use serde::Deserialize;
use serde_json::json;
use url::Url;

use super::{
    DailyClient, DailyError, MusicDiscovery, MusicSourceDocument, MusicSourceSummary, PlaylistItem,
    bounded_json, music_snapshot, validate_playlist_item,
};

const PLAYLIST_ENDPOINT: &str = "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg";
const MUSICU_ENDPOINT: &str = "https://u.y.qq.com/cgi-bin/musicu.fcg";
const PUBLIC_PLAYLIST_PREFIX: &str = "https://y.qq.com/n/ryqq_v2/playlist/";
const PUBLIC_SONG_PREFIX: &str = "https://y.qq.com/n/ryqq/songDetail/";
const COVER_PREFIX: &str = "https://y.gtimg.cn/music/photo_new/T002R300x300M000";
const MAX_TRACKS: usize = 2_000;
const DISCOVERY_SCAN_LIMIT: usize = 30;
const DISCOVERY_LIMIT: usize = 5;
const COVER_LIMIT: usize = 1_000_000;

pub type QqMusicDocument = MusicSourceDocument;

#[derive(Clone, Debug)]
struct ChartEntry {
    rank: usize,
    song_id: u64,
}

#[derive(Clone, Debug)]
struct Chart {
    name: String,
    updated_on: Option<String>,
    entries: Vec<ChartEntry>,
}

#[derive(Clone, Debug)]
struct SongDetail {
    song_id: u64,
    song_mid: String,
    title: String,
    artist: String,
    album: String,
    album_mid: String,
    language: String,
    genre: String,
    label: String,
    published_on: Option<String>,
}

/// Extract only the numeric playlist identifier from a credential-free share URL.
pub fn parse_qqmusic_playlist_id(share_url: &str) -> Result<String, DailyError> {
    if share_url.is_empty() || share_url.len() > 2_048 {
        return Err(DailyError::InvalidInput);
    }
    let parsed = Url::parse(share_url).map_err(|_| DailyError::InvalidInput)?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("i2.y.qq.com" | "y.qq.com" | "www.y.qq.com")
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.fragment().is_some()
    {
        return Err(DailyError::InvalidInput);
    }
    let segments = parsed
        .path_segments()
        .map(|segments| segments.filter(|part| !part.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    let mut identifier = match segments.as_slice() {
        ["n", "ryqq", "playlist", value] | ["n", "ryqq_v2", "playlist", value] => {
            (*value).to_owned()
        }
        _ => String::new(),
    };
    if identifier.is_empty() && parsed.path() == "/n3/other/pages/details/playlist.html" {
        let values = parsed
            .query_pairs()
            .filter(|(key, _)| key == "id")
            .map(|(_, value)| value.into_owned())
            .collect::<Vec<_>>();
        if values.len() == 1 {
            identifier = values[0].clone();
        }
    }
    if !valid_numeric_id(&identifier) {
        return Err(DailyError::InvalidInput);
    }
    Ok(identifier)
}

impl DailyClient {
    pub async fn sync_qq_music(
        &self,
        share_url: &str,
        local_date: &str,
    ) -> Result<QqMusicDocument, DailyError> {
        let playlist_id = parse_qqmusic_playlist_id(share_url)?;
        self.sync_qq_music_id(&playlist_id, local_date).await
    }

    pub async fn sync_qq_music_id(
        &self,
        playlist_id: &str,
        local_date: &str,
    ) -> Result<QqMusicDocument, DailyError> {
        if !valid_numeric_id(playlist_id)
            || NaiveDate::parse_from_str(local_date, "%Y-%m-%d").is_err()
        {
            return Err(DailyError::InvalidInput);
        }
        let (label, mut items) = self.qq_playlist(playlist_id).await?;
        let selected = music_snapshot(&items, local_date)
            .recommendation
            .ok_or(DailyError::InvalidResponse)?;
        let selected_index = items
            .iter()
            .position(|item| item.item_id == selected.item_id)
            .ok_or(DailyError::InvalidResponse)?;
        let selected_song_id = items[selected_index]
            .source_item_id
            .parse::<u64>()
            .map_err(|_| DailyError::InvalidResponse)?;
        let selected_detail = self.qq_song_detail(selected_song_id).await.ok();
        let chart = self.qq_hong_kong_chart().await.ok();
        if let Some(detail) = selected_detail {
            let chart_rank = chart.as_ref().and_then(|chart| {
                chart
                    .entries
                    .iter()
                    .find(|entry| entry.song_id == detail.song_id)
                    .map(|entry| (chart, entry.rank))
            });
            items[selected_index] = enrich_selected(&items[selected_index], &detail, chart_rank);
        }
        let discoveries = match chart.as_ref() {
            Some(chart) => self.qq_discoveries(&items, chart).await,
            None => Vec::new(),
        };
        let synced_at = Utc::now().to_rfc3339();
        Ok(QqMusicDocument {
            provider: "qqmusic".to_owned(),
            source_identity: playlist_id.to_owned(),
            source: MusicSourceSummary {
                provider: "qqmusic".to_owned(),
                label,
                item_count: items.len(),
                synced_at: Some(synced_at),
                public_url: format!("{PUBLIC_PLAYLIST_PREFIX}{playlist_id}"),
                refresh_supported: true,
                experimental: true,
                official_api: false,
                read_only: true,
                requires_user_consent: false,
                supports_charts: true,
            },
            items,
            discoveries,
        })
    }

    pub async fn qq_music_cover(&self, cover_url: &str) -> Result<(Vec<u8>, String), DailyError> {
        validate_cover_url(cover_url)?;
        let response = self
            .client
            .get(cover_url)
            .header(header::ACCEPT, "image/jpeg,image/png,image/webp")
            .header(header::REFERER, "https://y.qq.com/")
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        bounded_image(response).await
    }

    async fn qq_playlist(
        &self,
        playlist_id: &str,
    ) -> Result<(String, Vec<PlaylistItem>), DailyError> {
        let response = self
            .client
            .get(PLAYLIST_ENDPOINT)
            .query(&[
                ("type", "1"),
                ("json", "1"),
                ("utf8", "1"),
                ("onlysong", "0"),
                ("disstid", playlist_id),
                ("format", "json"),
                ("g_tk", "5381"),
                ("loginUin", "0"),
                ("hostUin", "0"),
                ("inCharset", "utf8"),
                ("outCharset", "utf-8"),
                ("notice", "0"),
                ("platform", "yqq.json"),
                ("needNewCode", "0"),
            ])
            .header(header::ACCEPT, "application/json")
            .header(header::REFERER, "https://y.qq.com/")
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let document: PlaylistResponse = bounded_json(response).await?;
        if document.code != 0 || document.cdlist.len() != 1 {
            return Err(DailyError::InvalidResponse);
        }
        let playlist = document
            .cdlist
            .into_iter()
            .next()
            .ok_or(DailyError::InvalidResponse)?;
        if playlist.disstid != playlist_id
            || playlist.songlist.is_empty()
            || playlist.songlist.len() > MAX_TRACKS
        {
            return Err(DailyError::InvalidResponse);
        }
        let label = remote_text(&playlist.dissname, 300)?;
        let mut identities = BTreeSet::new();
        let mut items = Vec::with_capacity(playlist.songlist.len());
        for track in playlist.songlist {
            let song_mid = remote_mid(&track.songmid)?;
            let item_id = format!("qqmusic-{song_mid}");
            if !identities.insert(item_id.clone()) {
                return Err(DailyError::InvalidResponse);
            }
            let artist = singers(&track.singer)?;
            let album_mid = optional_mid(&track.albummid)?;
            let item = PlaylistItem {
                item_id,
                title: remote_text(&track.songname, 300)?,
                artist,
                album: optional_text(&track.albumname, 300)?,
                tags: vec!["qqmusic".to_owned()],
                analysis: String::new(),
                cover_url: cover_url(&album_mid),
                source_provider: "qqmusic".to_owned(),
                source_item_id: track.songid.to_string(),
                source_url: format!("{PUBLIC_SONG_PREFIX}{song_mid}"),
                language: String::new(),
                genre: String::new(),
                published_on: None,
                popularity_reason: String::new(),
            };
            validate_playlist_item(&item).map_err(|_| DailyError::InvalidResponse)?;
            items.push(item);
        }
        Ok((label, items))
    }

    async fn qq_hong_kong_chart(&self) -> Result<Chart, DailyError> {
        let response = self
            .client
            .post(MUSICU_ENDPOINT)
            .header(header::ACCEPT, "application/json")
            .header(header::REFERER, "https://y.qq.com/")
            .json(&json!({
                "comm": {"ct": 24, "cv": 0},
                "toplist": {
                    "module": "musicToplist.ToplistInfoServer",
                    "method": "GetDetail",
                    "param": {"topId": 59, "offset": 0, "num": DISCOVERY_SCAN_LIMIT, "period": ""}
                }
            }))
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let document: ChartResponse = bounded_json(response).await?;
        if document.toplist.code != 0 {
            return Err(DailyError::InvalidResponse);
        }
        let chart = document.toplist.data.data;
        let name = remote_text(&chart.title, 200)?;
        let updated_on = optional_date(&chart.update_time)?;
        if chart.song.is_empty() {
            return Err(DailyError::InvalidResponse);
        }
        let mut entries = Vec::new();
        for entry in chart.song.into_iter().take(DISCOVERY_SCAN_LIMIT) {
            if entry.rank == 0 || entry.rank > 1_000 || entry.song_id == 0 {
                return Err(DailyError::InvalidResponse);
            }
            entries.push(ChartEntry {
                rank: entry.rank,
                song_id: entry.song_id,
            });
        }
        Ok(Chart {
            name,
            updated_on,
            entries,
        })
    }

    async fn qq_song_detail(&self, song_id: u64) -> Result<SongDetail, DailyError> {
        if song_id == 0 {
            return Err(DailyError::InvalidInput);
        }
        let response = self
            .client
            .post(MUSICU_ENDPOINT)
            .header(header::ACCEPT, "application/json")
            .header(header::REFERER, "https://y.qq.com/")
            .json(&json!({
                "comm": {"ct": 24, "cv": 0},
                "song": {
                    "module": "music.pf_song_detail_svr",
                    "method": "get_song_detail_yqq",
                    "param": {"song_id": song_id, "song_type": 0, "song_mid": ""}
                }
            }))
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let document: SongResponse = bounded_json(response).await?;
        if document.song.code != 0 || document.song.data.track_info.id != song_id {
            return Err(DailyError::InvalidResponse);
        }
        let track = document.song.data.track_info;
        let info = document.song.data.info;
        Ok(SongDetail {
            song_id,
            song_mid: remote_mid(&track.mid)?,
            title: remote_text(&track.name, 300)?,
            artist: singers(&track.singer)?,
            album: optional_text(&track.album.name, 300)?,
            album_mid: optional_mid(&track.album.mid)?,
            language: information_value(info.lan.as_ref(), 64)?,
            genre: information_value(info.genre.as_ref(), 128)?,
            label: information_value(info.company.as_ref(), 200)?,
            published_on: optional_date(&track.time_public)?,
        })
    }

    async fn qq_discoveries(&self, items: &[PlaylistItem], chart: &Chart) -> Vec<MusicDiscovery> {
        let existing = items
            .iter()
            .map(|item| item.source_item_id.clone())
            .collect::<BTreeSet<_>>();
        let artist_counts = artist_counts(items);
        let details = stream::iter(chart.entries.iter().cloned())
            .map(|entry| async move {
                let detail = self.qq_song_detail(entry.song_id).await.ok();
                (entry, detail)
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        let mut candidates = Vec::new();
        for (entry, detail) in details {
            let Some(detail) = detail else { continue };
            if detail.language != "粤语" || existing.contains(&detail.song_id.to_string()) {
                continue;
            }
            let (affinity_artist, affinity_count) = affinity(&detail.artist, &artist_counts);
            let score = i64::try_from(entry.rank).unwrap_or(i64::MAX)
                - i64::try_from((affinity_count * 2).min(12)).unwrap_or_default();
            let recommendation_reason = if affinity_count > 0 {
                format!(
                    "Your playlist contains {affinity_count} track(s) by {affinity_artist}; this current Cantonese release stays close to that preference."
                )
            } else {
                "A current Cantonese chart entry that broadens the artist range in your private playlist."
                    .to_owned()
            };
            let facts = song_facts(&detail);
            let updated = chart
                .updated_on
                .as_ref()
                .map(|value| format!(" updated {value}"))
                .unwrap_or_default();
            let popularity_reason = format!(
                "QQ Music currently lists it at #{} on {}{}; this is platform chart evidence, not a universal popularity claim.",
                entry.rank, chart.name, updated
            );
            candidates.push((
                score,
                entry.rank,
                MusicDiscovery {
                    item_id: format!("qqmusic:{}", detail.song_mid),
                    title: detail.title.clone(),
                    artist: detail.artist.clone(),
                    album: detail.album.clone(),
                    language: detail.language.clone(),
                    genre: detail.genre.clone(),
                    label: detail.label.clone(),
                    published_on: detail.published_on.clone(),
                    chart_name: chart.name.clone(),
                    chart_rank: entry.rank,
                    chart_updated_on: chart.updated_on.clone(),
                    affinity_artist,
                    affinity_count,
                    recommendation_reason,
                    song_analysis: facts,
                    popularity_reason,
                    source_url: format!("{PUBLIC_SONG_PREFIX}{}", detail.song_mid),
                },
            ));
        }
        candidates.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then_with(|| left.1.cmp(&right.1))
                .then_with(|| left.2.item_id.cmp(&right.2.item_id))
        });
        candidates
            .into_iter()
            .take(DISCOVERY_LIMIT)
            .map(|(_, _, discovery)| discovery)
            .collect()
    }
}

fn enrich_selected(
    item: &PlaylistItem,
    detail: &SongDetail,
    chart_rank: Option<(&Chart, usize)>,
) -> PlaylistItem {
    let mut tags = item.tags.clone();
    for tag in [&detail.language, &detail.genre] {
        if !tag.is_empty() && !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    let popularity_reason = chart_rank.map_or_else(String::new, |(chart, rank)| {
        let updated = chart
            .updated_on
            .as_ref()
            .map(|value| format!(" updated {value}"))
            .unwrap_or_default();
        format!(
            "QQ Music currently lists it at #{rank} on {}{}; this is platform chart evidence, not a universal popularity claim.",
            chart.name, updated
        )
    });
    PlaylistItem {
        item_id: item.item_id.clone(),
        title: detail.title.clone(),
        artist: detail.artist.clone(),
        album: detail.album.clone(),
        tags,
        analysis: song_facts(detail),
        cover_url: if detail.album_mid.is_empty() {
            item.cover_url.clone()
        } else {
            cover_url(&detail.album_mid)
        },
        source_provider: "qqmusic".to_owned(),
        source_item_id: detail.song_id.to_string(),
        source_url: format!("{PUBLIC_SONG_PREFIX}{}", detail.song_mid),
        language: detail.language.clone(),
        genre: detail.genre.clone(),
        published_on: detail.published_on.clone(),
        popularity_reason,
    }
}

fn song_facts(detail: &SongDetail) -> String {
    let facts = [
        (!detail.language.is_empty()).then(|| format!("language: {}", detail.language)),
        (!detail.genre.is_empty()).then(|| format!("genre: {}", detail.genre)),
        detail
            .published_on
            .as_ref()
            .map(|value| format!("released {value}")),
        (!detail.label.is_empty()).then(|| format!("label: {}", detail.label)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    if facts.is_empty() {
        "No reviewed structured song metadata is available.".to_owned()
    } else {
        format!("QQ Music structured metadata records {}.", facts.join("; "))
    }
}

fn artist_counts(items: &[PlaylistItem]) -> BTreeMap<String, (String, usize)> {
    let mut counts = BTreeMap::<String, (String, usize)>::new();
    for item in items {
        for artist in split_artists(&item.artist) {
            let normalized = normalized_artist(artist);
            let value = counts
                .entry(normalized)
                .or_insert_with(|| (artist.to_owned(), 0));
            value.1 += 1;
        }
    }
    counts
}

fn affinity(artists: &str, counts: &BTreeMap<String, (String, usize)>) -> (String, usize) {
    split_artists(artists)
        .into_iter()
        .filter_map(|artist| counts.get(&normalized_artist(artist)))
        .max_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)))
        .cloned()
        .unwrap_or_default()
}

fn split_artists(value: &str) -> Vec<&str> {
    value
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect()
}

fn normalized_artist(value: &str) -> String {
    value.trim().to_lowercase()
}

fn valid_numeric_id(value: &str) -> bool {
    (1..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn remote_mid(value: &str) -> Result<String, DailyError> {
    if (5..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        Ok(value.to_owned())
    } else {
        Err(DailyError::InvalidResponse)
    }
}

fn optional_mid(value: &str) -> Result<String, DailyError> {
    if value.is_empty() {
        Ok(String::new())
    } else {
        remote_mid(value)
    }
}

fn remote_text(value: &str, maximum: usize) -> Result<String, DailyError> {
    let selected = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if selected.is_empty()
        || selected.chars().count() > maximum
        || selected.chars().any(char::is_control)
    {
        Err(DailyError::InvalidResponse)
    } else {
        Ok(selected)
    }
}

fn optional_text(value: &str, maximum: usize) -> Result<String, DailyError> {
    if value.trim().is_empty() {
        Ok(String::new())
    } else {
        remote_text(value, maximum)
    }
}

fn optional_date(value: &str) -> Result<Option<String>, DailyError> {
    if value.is_empty() || value == "0000-00-00" {
        return Ok(None);
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map(|date| Some(date.to_string()))
        .map_err(|_| DailyError::InvalidResponse)
}

fn singers(values: &[RemoteSinger]) -> Result<String, DailyError> {
    if values.is_empty() || values.len() > 10 {
        return Err(DailyError::InvalidResponse);
    }
    values
        .iter()
        .map(|singer| remote_text(&singer.name, 100))
        .collect::<Result<Vec<_>, _>>()
        .map(|artists| artists.join(" / "))
}

fn information_value(
    section: Option<&RemoteInfoSection>,
    maximum: usize,
) -> Result<String, DailyError> {
    let Some(value) = section
        .and_then(|section| section.content.first())
        .map(|value| value.value.as_str())
    else {
        return Ok(String::new());
    };
    optional_text(value, maximum)
}

fn cover_url(album_mid: &str) -> String {
    if album_mid.is_empty() {
        String::new()
    } else {
        format!("{COVER_PREFIX}{album_mid}.jpg")
    }
}

fn validate_cover_url(value: &str) -> Result<(), DailyError> {
    let parsed = Url::parse(value).map_err(|_| DailyError::InvalidInput)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("y.gtimg.cn")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed
            .path()
            .starts_with("/music/photo_new/T002R300x300M000")
        || !parsed.path().ends_with(".jpg")
    {
        return Err(DailyError::InvalidInput);
    }
    Ok(())
}

pub(crate) async fn bounded_image(response: Response) -> Result<(Vec<u8>, String), DailyError> {
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|length| length > COVER_LIMIT as u64)
    {
        return Err(DailyError::Unavailable);
    }
    let media_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        media_type.as_str(),
        "image/jpeg" | "image/png" | "image/webp"
    ) {
        return Err(DailyError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    let mut body = response.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|_| DailyError::Unavailable)?;
        if bytes.len().saturating_add(chunk.len()) > COVER_LIMIT {
            return Err(DailyError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    let valid = match media_type.as_str() {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid {
        return Err(DailyError::InvalidResponse);
    }
    Ok((bytes, media_type))
}

#[derive(Deserialize)]
struct PlaylistResponse {
    code: i64,
    cdlist: Vec<RemotePlaylist>,
}

#[derive(Deserialize)]
struct RemotePlaylist {
    disstid: String,
    dissname: String,
    songlist: Vec<RemoteTrack>,
}

#[derive(Deserialize)]
struct RemoteTrack {
    songid: u64,
    songmid: String,
    songname: String,
    #[serde(default)]
    albumname: String,
    #[serde(default)]
    albummid: String,
    singer: Vec<RemoteSinger>,
}

#[derive(Clone, Deserialize)]
struct RemoteSinger {
    name: String,
}

#[derive(Deserialize)]
struct ChartResponse {
    toplist: ChartEnvelope,
}

#[derive(Deserialize)]
struct ChartEnvelope {
    code: i64,
    data: ChartOuter,
}

#[derive(Deserialize)]
struct ChartOuter {
    data: RemoteChart,
}

#[derive(Deserialize)]
struct RemoteChart {
    title: String,
    #[serde(rename = "updateTime", default)]
    update_time: String,
    song: Vec<RemoteChartEntry>,
}

#[derive(Deserialize)]
struct RemoteChartEntry {
    rank: usize,
    #[serde(rename = "songId")]
    song_id: u64,
}

#[derive(Deserialize)]
struct SongResponse {
    song: SongEnvelope,
}

#[derive(Deserialize)]
struct SongEnvelope {
    code: i64,
    data: SongData,
}

#[derive(Deserialize)]
struct SongData {
    #[serde(default)]
    info: RemoteInfo,
    track_info: RemoteTrackInfo,
}

#[derive(Default, Deserialize)]
struct RemoteInfo {
    lan: Option<RemoteInfoSection>,
    genre: Option<RemoteInfoSection>,
    company: Option<RemoteInfoSection>,
}

#[derive(Deserialize)]
struct RemoteInfoSection {
    #[serde(default)]
    content: Vec<RemoteInfoValue>,
}

#[derive(Deserialize)]
struct RemoteInfoValue {
    value: String,
}

#[derive(Deserialize)]
struct RemoteTrackInfo {
    id: u64,
    mid: String,
    name: String,
    #[serde(default)]
    time_public: String,
    singer: Vec<RemoteSinger>,
    album: RemoteAlbum,
}

#[derive(Deserialize)]
struct RemoteAlbum {
    #[serde(default)]
    name: String,
    #[serde(default)]
    mid: String,
}

#[cfg(test)]
mod tests {
    use super::{affinity, artist_counts, parse_qqmusic_playlist_id};
    use crate::PlaylistItem;

    fn item(artist: &str) -> PlaylistItem {
        PlaylistItem {
            item_id: format!("track-{artist}"),
            title: "Synthetic".to_owned(),
            artist: artist.to_owned(),
            album: String::new(),
            tags: Vec::new(),
            analysis: String::new(),
            cover_url: String::new(),
            source_provider: String::new(),
            source_item_id: String::new(),
            source_url: String::new(),
            language: String::new(),
            genre: String::new(),
            published_on: None,
            popularity_reason: String::new(),
        }
    }

    #[test]
    fn share_link_discards_owner_and_tracking_fields() {
        let playlist = parse_qqmusic_playlist_id(
            "https://i2.y.qq.com/n3/other/pages/details/playlist.html?hosteuin=synthetic&id=1234567890&ADTAG=share",
        )
        .expect("valid share link");
        assert_eq!(playlist, "1234567890");
        assert!(parse_qqmusic_playlist_id("https://example.com/playlist/1234567890").is_err());
        assert!(
            parse_qqmusic_playlist_id("https://user:secret@y.qq.com/n/ryqq_v2/playlist/1234567890")
                .is_err()
        );
    }

    #[test]
    fn artist_affinity_is_counted_only_from_local_items() {
        let items = vec![
            item("Affinity Artist"),
            item("Affinity Artist"),
            item("Other"),
        ];
        let counts = artist_counts(&items);
        assert_eq!(
            affinity("Guest / Affinity Artist", &counts),
            ("Affinity Artist".to_owned(), 2)
        );
    }
}
