//! Official Apple Music API catalog-playlist connector.
//!
//! Credentials are supplied by Core after native-secret resolution and are never serialized.
//! The adapter does not scrape Apple Music pages or attempt private-library access.

use std::collections::BTreeSet;

use chrono::{NaiveDate, Utc};
use reqwest::header::{self, HeaderValue};
use serde::Deserialize;
use url::Url;

use super::{
    DailyClient, DailyError, MusicSourceDocument, MusicSourceSummary, PlaylistItem,
    bounded_json_with_limit, music_snapshot, validate_playlist_item,
};
use crate::qqmusic::bounded_image;

const API_ORIGIN: &str = "https://api.music.apple.com";
const MAX_TRACKS: usize = 2_000;
const MAX_PAGES: usize = 20;
const MAX_PROVIDER_RESPONSE_BYTES: usize = 4_000_000;

pub type AppleMusicDocument = MusicSourceDocument;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppleMusicPlaylistIdentity {
    pub storefront: String,
    pub playlist_id: String,
    pub public_url: String,
}

/// Normalize a public Apple Music catalog-playlist link without retaining tracking parameters.
pub fn parse_apple_music_playlist(
    share_url: &str,
) -> Result<AppleMusicPlaylistIdentity, DailyError> {
    if share_url.is_empty() || share_url.len() > 2_048 {
        return Err(DailyError::InvalidInput);
    }
    let parsed = Url::parse(share_url).map_err(|_| DailyError::InvalidInput)?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("music.apple.com")
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
    let [storefront, "playlist", slug, playlist_id] = segments.as_slice() else {
        return Err(DailyError::InvalidInput);
    };
    if storefront.len() != 2
        || !storefront.bytes().all(|byte| byte.is_ascii_alphabetic())
        || slug.is_empty()
        || slug.chars().count() > 200
        || !valid_apple_id(playlist_id)
    {
        return Err(DailyError::InvalidInput);
    }
    let storefront = storefront.to_ascii_lowercase();
    Ok(AppleMusicPlaylistIdentity {
        storefront: storefront.clone(),
        playlist_id: (*playlist_id).to_owned(),
        public_url: format!(
            "https://music.apple.com/{storefront}/playlist/{}/{}",
            encode_path_segment(slug),
            encode_path_segment(playlist_id)
        ),
    })
}

impl DailyClient {
    pub async fn sync_apple_music(
        &self,
        share_url: &str,
        local_date: &str,
        developer_token: &str,
        music_user_token: Option<&str>,
    ) -> Result<AppleMusicDocument, DailyError> {
        let identity = parse_apple_music_playlist(share_url)?;
        self.sync_apple_music_identity(
            &identity.storefront,
            &identity.playlist_id,
            &identity.public_url,
            local_date,
            developer_token,
            music_user_token,
        )
        .await
    }

    pub async fn sync_apple_music_id(
        &self,
        source_identity: &str,
        local_date: &str,
        developer_token: &str,
        music_user_token: Option<&str>,
    ) -> Result<AppleMusicDocument, DailyError> {
        let (storefront, playlist_id) = source_identity
            .split_once(':')
            .ok_or(DailyError::InvalidInput)?;
        if storefront.len() != 2
            || !storefront.bytes().all(|byte| byte.is_ascii_lowercase())
            || !valid_apple_id(playlist_id)
        {
            return Err(DailyError::InvalidInput);
        }
        self.sync_apple_music_identity(
            storefront,
            playlist_id,
            "",
            local_date,
            developer_token,
            music_user_token,
        )
        .await
    }

    async fn sync_apple_music_identity(
        &self,
        storefront: &str,
        playlist_id: &str,
        submitted_public_url: &str,
        local_date: &str,
        developer_token: &str,
        music_user_token: Option<&str>,
    ) -> Result<AppleMusicDocument, DailyError> {
        if NaiveDate::parse_from_str(local_date, "%Y-%m-%d").is_err() {
            return Err(DailyError::InvalidInput);
        }
        let authorization = bearer_header(developer_token)?;
        let user_token = music_user_token.map(secret_header).transpose()?;
        let endpoint = format!(
            "{API_ORIGIN}/v1/catalog/{storefront}/playlists/{}",
            encode_path_segment(playlist_id)
        );
        let mut request = self
            .client
            .get(endpoint)
            .query(&[("include", "tracks")])
            .header(header::ACCEPT, "application/json")
            .header(header::AUTHORIZATION, authorization.clone());
        if let Some(token) = user_token.as_ref() {
            request = request.header("Music-User-Token", token.clone());
        }
        let response = request.send().await.map_err(|_| DailyError::Unavailable)?;
        let root: CatalogResponse =
            bounded_json_with_limit(response, MAX_PROVIDER_RESPONSE_BYTES).await?;
        if root.data.len() != 1 {
            return Err(DailyError::InvalidResponse);
        }
        let playlist = root
            .data
            .into_iter()
            .next()
            .ok_or(DailyError::InvalidResponse)?;
        if playlist.id != playlist_id || playlist.resource_type != "playlists" {
            return Err(DailyError::InvalidResponse);
        }
        let label = remote_text(&playlist.attributes.name, 300)?;
        let public_url = normalize_public_url(&playlist.attributes.url)
            .or_else(|| (!submitted_public_url.is_empty()).then(|| submitted_public_url.to_owned()))
            .ok_or(DailyError::InvalidResponse)?;
        let tracks = playlist
            .relationships
            .and_then(|relationships| relationships.tracks)
            .ok_or(DailyError::InvalidResponse)?;
        let mut all_tracks = tracks.data;
        let mut next = tracks.next;
        let mut pages = 1;
        while let Some(next_path) = next {
            if pages >= MAX_PAGES || all_tracks.len() >= MAX_TRACKS {
                return Err(DailyError::InvalidResponse);
            }
            let next_url = validate_next_url(&next_path, storefront, playlist_id)?;
            let mut request = self
                .client
                .get(next_url)
                .header(header::ACCEPT, "application/json")
                .header(header::AUTHORIZATION, authorization.clone());
            if let Some(token) = user_token.as_ref() {
                request = request.header("Music-User-Token", token.clone());
            }
            let response = request.send().await.map_err(|_| DailyError::Unavailable)?;
            let page: TrackPage =
                bounded_json_with_limit(response, MAX_PROVIDER_RESPONSE_BYTES).await?;
            all_tracks.extend(page.data);
            next = page.next;
            pages += 1;
        }
        let items = normalize_tracks(all_tracks, storefront)?;
        if music_snapshot(&items, local_date).recommendation.is_none() {
            return Err(DailyError::InvalidResponse);
        }
        Ok(AppleMusicDocument {
            provider: "apple-music".to_owned(),
            source_identity: format!("{storefront}:{playlist_id}"),
            source: MusicSourceSummary {
                provider: "apple-music".to_owned(),
                label,
                item_count: items.len(),
                synced_at: Some(Utc::now().to_rfc3339()),
                public_url,
                refresh_supported: true,
                experimental: false,
                official_api: true,
                read_only: true,
                requires_user_consent: true,
                supports_charts: false,
            },
            items,
            discoveries: Vec::new(),
        })
    }

    pub async fn apple_music_cover(
        &self,
        cover_url: &str,
    ) -> Result<(Vec<u8>, String), DailyError> {
        let cover_url = normalize_artwork_url(cover_url)?;
        let response = self
            .client
            .get(cover_url)
            .header(header::ACCEPT, "image/jpeg,image/png,image/webp")
            .header(header::REFERER, "https://music.apple.com/")
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        bounded_image(response).await
    }
}

fn normalize_tracks(
    tracks: Vec<TrackResource>,
    storefront: &str,
) -> Result<Vec<PlaylistItem>, DailyError> {
    if tracks.is_empty() || tracks.len() > MAX_TRACKS {
        return Err(DailyError::InvalidResponse);
    }
    let mut identities = BTreeSet::new();
    let mut items = Vec::with_capacity(tracks.len());
    for track in tracks {
        if track.resource_type != "songs" || !valid_apple_id(&track.id) {
            return Err(DailyError::InvalidResponse);
        }
        let item_id = format!("apple-music-{}", track.id);
        if !identities.insert(item_id.clone()) {
            return Err(DailyError::InvalidResponse);
        }
        let attributes = track.attributes.ok_or(DailyError::InvalidResponse)?;
        let genres = attributes
            .genre_names
            .iter()
            .take(5)
            .map(|genre| remote_text(genre, 80))
            .collect::<Result<Vec<_>, _>>()?;
        let published_on = attributes
            .release_date
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok())
            .map(|date| date.to_string());
        let facts = [
            published_on.as_ref().map(|date| format!("released {date}")),
            (!genres.is_empty()).then(|| format!("genre: {}", genres.join(" / "))),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        let source_url = attributes
            .url
            .as_deref()
            .and_then(normalize_public_url)
            .unwrap_or_else(|| format!("https://music.apple.com/{storefront}/song/{}", track.id));
        let item = PlaylistItem {
            item_id,
            title: remote_text(&attributes.name, 300)?,
            artist: remote_text(&attributes.artist_name, 300)?,
            album: optional_text(&attributes.album_name, 300)?,
            tags: std::iter::once("apple-music".to_owned())
                .chain(genres.iter().cloned())
                .collect(),
            analysis: if facts.is_empty() {
                "No reviewed structured song metadata is available.".to_owned()
            } else {
                format!("Apple Music catalog metadata records {}.", facts.join("; "))
            },
            cover_url: attributes.artwork.as_ref().map_or_else(
                || Ok(String::new()),
                |artwork| normalize_artwork_url(&artwork.url),
            )?,
            source_provider: "apple-music".to_owned(),
            source_item_id: track.id,
            source_url,
            language: String::new(),
            genre: genres.join(" / "),
            published_on,
            popularity_reason: String::new(),
        };
        validate_playlist_item(&item).map_err(|_| DailyError::InvalidResponse)?;
        items.push(item);
    }
    Ok(items)
}

fn bearer_header(token: &str) -> Result<HeaderValue, DailyError> {
    let token = secret_header(token)?;
    HeaderValue::from_str(&format!(
        "Bearer {}",
        token.to_str().map_err(|_| DailyError::InvalidInput)?
    ))
    .map_err(|_| DailyError::InvalidInput)
}

fn secret_header(value: &str) -> Result<HeaderValue, DailyError> {
    if value.is_empty()
        || value.len() > 16_384
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(DailyError::InvalidInput);
    }
    HeaderValue::from_str(value).map_err(|_| DailyError::InvalidInput)
}

fn validate_next_url(value: &str, storefront: &str, playlist_id: &str) -> Result<Url, DailyError> {
    let parsed = if value.starts_with('/') {
        Url::parse(&format!("{API_ORIGIN}{value}"))
    } else {
        Url::parse(value)
    }
    .map_err(|_| DailyError::InvalidResponse)?;
    let expected_prefix = format!(
        "/v1/catalog/{storefront}/playlists/{}/tracks",
        encode_path_segment(playlist_id)
    );
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("api.music.apple.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.fragment().is_some()
        || parsed.path() != expected_prefix
        || parsed
            .query_pairs()
            .any(|(key, _)| key != "offset" && key != "limit")
    {
        return Err(DailyError::InvalidResponse);
    }
    Ok(parsed)
}

fn normalize_public_url(value: &str) -> Option<String> {
    let mut parsed = Url::parse(value).ok()?;
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("music.apple.com")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.fragment().is_some()
    {
        return None;
    }
    parsed.set_query(None);
    Some(parsed.into())
}

fn normalize_artwork_url(value: &str) -> Result<String, DailyError> {
    if value.is_empty() || value.len() > 4_096 {
        return Err(DailyError::InvalidResponse);
    }
    let rendered = value
        .replace("{w}", "300")
        .replace("{h}", "300")
        .replace("{f}", "jpg");
    let parsed = Url::parse(&rendered).map_err(|_| DailyError::InvalidResponse)?;
    if parsed.scheme() != "https"
        || !matches!(
            parsed.host_str(),
            Some(
                "is1-ssl.mzstatic.com"
                    | "is2-ssl.mzstatic.com"
                    | "is3-ssl.mzstatic.com"
                    | "is4-ssl.mzstatic.com"
                    | "is5-ssl.mzstatic.com"
            )
        )
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port_or_known_default() != Some(443)
        || parsed.fragment().is_some()
        || rendered.contains('{')
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
    Ok(parsed.into())
}

fn valid_apple_id(value: &str) -> bool {
    (3..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn encode_path_segment(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
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
struct CatalogResponse {
    data: Vec<PlaylistResource>,
}

#[derive(Deserialize)]
struct PlaylistResource {
    id: String,
    #[serde(rename = "type")]
    resource_type: String,
    attributes: PlaylistAttributes,
    relationships: Option<PlaylistRelationships>,
}

#[derive(Deserialize)]
struct PlaylistAttributes {
    name: String,
    url: String,
}

#[derive(Deserialize)]
struct PlaylistRelationships {
    tracks: Option<TrackPage>,
}

#[derive(Deserialize)]
struct TrackPage {
    #[serde(default)]
    next: Option<String>,
    data: Vec<TrackResource>,
}

#[derive(Deserialize)]
struct TrackResource {
    id: String,
    #[serde(rename = "type")]
    resource_type: String,
    attributes: Option<TrackAttributes>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackAttributes {
    name: String,
    artist_name: String,
    #[serde(default)]
    album_name: String,
    #[serde(default)]
    genre_names: Vec<String>,
    release_date: Option<String>,
    artwork: Option<Artwork>,
    url: Option<String>,
}

#[derive(Deserialize)]
struct Artwork {
    url: String,
}

#[cfg(test)]
mod tests {
    use super::{
        CatalogResponse, normalize_artwork_url, normalize_tracks, parse_apple_music_playlist,
        validate_next_url,
    };

    #[test]
    fn share_link_is_canonicalized_without_tracking() {
        let identity = parse_apple_music_playlist(
            "https://music.apple.com/hk/playlist/synthetic-list/pl.u-1234?l=en-GB&ls=1",
        )
        .expect("valid apple link");
        assert_eq!(identity.storefront, "hk");
        assert_eq!(identity.playlist_id, "pl.u-1234");
        assert!(!identity.public_url.contains('?'));
        assert!(parse_apple_music_playlist("https://example.com/hk/playlist/x/pl.u-1").is_err());
    }

    #[test]
    fn synthetic_catalog_tracks_are_provider_neutral() {
        let root = serde_json::from_value::<CatalogResponse>(serde_json::json!({
            "data": [{
                "id": "pl.u-1234",
                "type": "playlists",
                "attributes": {"name": "Synthetic", "url": "https://music.apple.com/hk/playlist/synthetic/pl.u-1234"},
                "relationships": {"tracks": {"data": [{
                    "id": "123456",
                    "type": "songs",
                    "attributes": {
                        "name": "Synthetic Song",
                        "artistName": "Synthetic Artist",
                        "albumName": "Synthetic Album",
                        "genreNames": ["Cantopop"],
                        "releaseDate": "2026-01-02",
                        "artwork": {"url": "https://is1-ssl.mzstatic.com/image/thumb/synthetic/{w}x{h}bb.{f}"},
                        "url": "https://music.apple.com/hk/song/synthetic/123456"
                    }
                }]}}
            }]
        }))
        .expect("fixture shape");
        let tracks = root
            .data
            .into_iter()
            .next()
            .and_then(|playlist| playlist.relationships)
            .and_then(|relationships| relationships.tracks)
            .expect("tracks")
            .data;
        let items = normalize_tracks(tracks, "hk").expect("normalize tracks");
        assert_eq!(items[0].source_provider, "apple-music");
        assert_eq!(items[0].genre, "Cantopop");
        assert!(items[0].cover_url.contains("300x300bb.jpg"));
    }

    #[test]
    fn next_page_cannot_escape_the_official_playlist_path() {
        assert!(
            validate_next_url(
                "/v1/catalog/hk/playlists/pl.u-1234/tracks?offset=100&limit=100",
                "hk",
                "pl.u-1234"
            )
            .is_ok()
        );
        assert!(validate_next_url("https://evil.example/tracks", "hk", "pl.u-1234").is_err());
        assert!(normalize_artwork_url("https://evil.example/{w}x{h}.{f}").is_err());
    }
}
