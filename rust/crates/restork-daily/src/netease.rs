//! Experimental, credential-free NetEase Cloud Music public-playlist connector.
//!
//! This adapter intentionally does not implement login, cookies, QR codes, private playlists,
//! audio, or lyrics. Provider text is normalized as untrusted data before it reaches storage.

use std::collections::BTreeSet;

use chrono::{DateTime, NaiveDate, Utc};
use reqwest::header;
use serde::Deserialize;
use url::Url;

use super::{
    DailyClient, DailyError, MusicSourceDocument, MusicSourceSummary, PlaylistItem,
    bounded_json_with_limit, music_snapshot, validate_playlist_item,
};
use crate::qqmusic::bounded_image;

const PLAYLIST_ENDPOINT: &str = "https://music.163.com/api/v6/playlist/detail";
const PUBLIC_PLAYLIST_PREFIX: &str = "https://music.163.com/playlist?id=";
const PUBLIC_SONG_PREFIX: &str = "https://music.163.com/song?id=";
const MAX_TRACKS: usize = 2_000;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 4_000_000;

pub type NeteaseMusicDocument = MusicSourceDocument;

/// Extract only the numeric playlist identifier from a public NetEase share URL.
pub fn parse_netease_playlist_id(share_url: &str) -> Result<String, DailyError> {
    if share_url.is_empty() || share_url.len() > 2_048 {
        return Err(DailyError::InvalidInput);
    }
    let parsed = Url::parse(share_url).map_err(|_| DailyError::InvalidInput)?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some("music.163.com" | "www.music.163.com" | "y.music.163.com")
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
    {
        return Err(DailyError::InvalidInput);
    }
    let path_matches = matches!(parsed.path(), "/playlist" | "/m/playlist");
    let mut identifiers = if path_matches {
        query_ids(&parsed)
    } else {
        Vec::new()
    };
    if identifiers.is_empty()
        && let Some(fragment) = parsed.fragment()
    {
        let fragment_url = Url::parse(&format!(
            "https://music.163.com/{}",
            fragment.trim_start_matches('/')
        ))
        .map_err(|_| DailyError::InvalidInput)?;
        if fragment_url.path() == "/playlist" {
            identifiers = query_ids(&fragment_url);
        }
    }
    if identifiers.len() != 1 || !valid_numeric_id(&identifiers[0]) {
        return Err(DailyError::InvalidInput);
    }
    Ok(identifiers.remove(0))
}

fn query_ids(url: &Url) -> Vec<String> {
    url.query_pairs()
        .filter(|(key, _)| key == "id")
        .map(|(_, value)| value.into_owned())
        .collect()
}

impl DailyClient {
    pub async fn sync_netease_music(
        &self,
        share_url: &str,
        local_date: &str,
    ) -> Result<NeteaseMusicDocument, DailyError> {
        let playlist_id = parse_netease_playlist_id(share_url)?;
        self.sync_netease_music_id(&playlist_id, local_date).await
    }

    pub async fn sync_netease_music_id(
        &self,
        playlist_id: &str,
        local_date: &str,
    ) -> Result<NeteaseMusicDocument, DailyError> {
        if !valid_numeric_id(playlist_id)
            || NaiveDate::parse_from_str(local_date, "%Y-%m-%d").is_err()
        {
            return Err(DailyError::InvalidInput);
        }
        let response = self
            .client
            .get(PLAYLIST_ENDPOINT)
            .query(&[("id", playlist_id), ("n", "2000"), ("s", "0")])
            .header(header::ACCEPT, "application/json")
            .header(header::REFERER, "https://music.163.com/")
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let document: PlaylistResponse =
            bounded_json_with_limit(response, MAX_PROVIDER_RESPONSE_BYTES).await?;
        let (label, items) = normalize_playlist(document, playlist_id)?;
        if music_snapshot(&items, local_date).recommendation.is_none() {
            return Err(DailyError::InvalidResponse);
        }
        Ok(NeteaseMusicDocument {
            provider: "netease".to_owned(),
            source_identity: playlist_id.to_owned(),
            source: MusicSourceSummary {
                provider: "netease".to_owned(),
                label,
                item_count: items.len(),
                synced_at: Some(Utc::now().to_rfc3339()),
                public_url: format!("{PUBLIC_PLAYLIST_PREFIX}{playlist_id}"),
                refresh_supported: true,
                experimental: true,
                official_api: false,
                read_only: true,
                requires_user_consent: false,
                supports_charts: false,
            },
            items,
            discoveries: Vec::new(),
        })
    }

    pub async fn netease_music_cover(
        &self,
        cover_url: &str,
    ) -> Result<(Vec<u8>, String), DailyError> {
        let cover_url = normalize_cover_url(cover_url)?;
        let response = self
            .client
            .get(cover_url)
            .header(header::ACCEPT, "image/jpeg,image/png,image/webp")
            .header(header::REFERER, "https://music.163.com/")
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        bounded_image(response).await
    }
}

fn normalize_playlist(
    document: PlaylistResponse,
    playlist_id: &str,
) -> Result<(String, Vec<PlaylistItem>), DailyError> {
    if document.code != 200 || document.playlist.id.to_string() != playlist_id {
        return Err(DailyError::InvalidResponse);
    }
    let playlist = document.playlist;
    if playlist.tracks.is_empty() || playlist.tracks.len() > MAX_TRACKS {
        return Err(DailyError::InvalidResponse);
    }
    let label = remote_text(&playlist.name, 300)?;
    let mut identities = BTreeSet::new();
    let mut items = Vec::with_capacity(playlist.tracks.len());
    for track in playlist.tracks {
        if track.id == 0 || track.artists.is_empty() || track.artists.len() > 10 {
            return Err(DailyError::InvalidResponse);
        }
        let item_id = format!("netease-{}", track.id);
        if !identities.insert(item_id.clone()) {
            return Err(DailyError::InvalidResponse);
        }
        let artists = track
            .artists
            .iter()
            .map(|artist| remote_text(&artist.name, 100))
            .collect::<Result<Vec<_>, _>>()?
            .join(" / ");
        let published_on = track
            .publish_time
            .filter(|value| *value > 0)
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .map(|value| value.date_naive().to_string());
        let analysis = published_on.as_ref().map_or_else(
            || "No reviewed structured song metadata is available.".to_owned(),
            |date| format!("NetEase public metadata records release date {date}."),
        );
        let item = PlaylistItem {
            item_id,
            title: remote_text(&track.name, 300)?,
            artist: artists,
            album: optional_text(&track.album.name, 300)?,
            tags: vec!["netease".to_owned()],
            analysis,
            cover_url: optional_cover_url(track.album.picture_url.as_deref())?,
            source_provider: "netease".to_owned(),
            source_item_id: track.id.to_string(),
            source_url: format!("{PUBLIC_SONG_PREFIX}{}", track.id),
            language: String::new(),
            genre: String::new(),
            published_on,
            popularity_reason: String::new(),
        };
        validate_playlist_item(&item).map_err(|_| DailyError::InvalidResponse)?;
        items.push(item);
    }
    Ok((label, items))
}

fn optional_cover_url(value: Option<&str>) -> Result<String, DailyError> {
    value.map_or_else(|| Ok(String::new()), normalize_cover_url)
}

fn normalize_cover_url(value: &str) -> Result<String, DailyError> {
    if value.is_empty() || value.len() > 2_048 {
        return Err(DailyError::InvalidResponse);
    }
    let mut parsed = Url::parse(value).map_err(|_| DailyError::InvalidResponse)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || !matches!(
            parsed.host_str(),
            Some("p1.music.126.net" | "p2.music.126.net" | "p3.music.126.net" | "p4.music.126.net")
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed
            .port_or_known_default()
            .is_none_or(|port| !matches!(port, 80 | 443))
        || parsed.fragment().is_some()
        || parsed.query().is_some()
        || !matches!(
            parsed
                .path()
                .rsplit_once('.')
                .map(|(_, extension)| extension),
            Some("jpg" | "jpeg" | "png" | "webp")
        )
    {
        return Err(DailyError::InvalidResponse);
    }
    parsed
        .set_scheme("https")
        .map_err(|_| DailyError::InvalidResponse)?;
    parsed
        .set_port(None)
        .map_err(|_| DailyError::InvalidResponse)?;
    Ok(parsed.into())
}

fn valid_numeric_id(value: &str) -> bool {
    (1..=20).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
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

#[derive(Deserialize)]
struct PlaylistResponse {
    code: i64,
    playlist: RemotePlaylist,
}

#[derive(Deserialize)]
struct RemotePlaylist {
    id: u64,
    name: String,
    tracks: Vec<RemoteTrack>,
}

#[derive(Deserialize)]
struct RemoteTrack {
    id: u64,
    name: String,
    #[serde(rename = "ar")]
    artists: Vec<RemoteArtist>,
    #[serde(rename = "al")]
    album: RemoteAlbum,
    #[serde(rename = "publishTime")]
    publish_time: Option<i64>,
}

#[derive(Deserialize)]
struct RemoteArtist {
    name: String,
}

#[derive(Deserialize)]
struct RemoteAlbum {
    #[serde(default)]
    name: String,
    #[serde(rename = "picUrl")]
    picture_url: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{PlaylistResponse, normalize_playlist, parse_netease_playlist_id};

    #[test]
    fn share_link_discards_user_and_tracking_parameters() {
        let playlist = parse_netease_playlist_id(
            "https://y.music.163.com/m/playlist?id=123456789&userid=9988&uct2=tracking",
        )
        .expect("valid public link");
        assert_eq!(playlist, "123456789");
        assert_eq!(
            parse_netease_playlist_id("https://music.163.com/#/playlist?id=77")
                .expect("valid desktop link"),
            "77"
        );
        assert!(parse_netease_playlist_id("https://163cn.tv/short").is_err());
        assert!(
            parse_netease_playlist_id("https://user:secret@music.163.com/playlist?id=1").is_err()
        );
    }

    #[test]
    fn synthetic_playlist_is_normalized_without_account_fields() {
        let document = serde_json::from_value::<PlaylistResponse>(serde_json::json!({
            "code": 200,
            "playlist": {
                "id": 42,
                "name": "Synthetic favourites",
                "creator": {"nickname": "must not be parsed"},
                "tracks": [{
                    "id": 7,
                    "name": "A bounded song",
                    "ar": [{"name": "Synthetic Artist"}],
                    "al": {
                        "name": "Synthetic Album",
                        "picUrl": "http://p1.music.126.net/synthetic/7.jpg"
                    },
                    "publishTime": 1_704_067_200_000_i64
                }]
            }
        }))
        .expect("fixture shape");
        let (label, items) = normalize_playlist(document, "42").expect("normalized playlist");
        assert_eq!(label, "Synthetic favourites");
        assert_eq!(items[0].source_provider, "netease");
        assert_eq!(
            items[0].cover_url,
            "https://p1.music.126.net/synthetic/7.jpg"
        );
        assert_eq!(items[0].published_on.as_deref(), Some("2024-01-01"));
    }
}
