//! Optional, consent-driven daily context for the Rust Core.
//!
//! Network destinations are fixed Open-Meteo and explicitly enabled music
//! catalog origins. Calendar and playlist imports are bounded private snapshots;
//! no location or source is inferred at startup.

use std::{collections::BTreeMap, time::Duration};

use chrono::{DateTime, Duration as ChronoDuration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use futures_util::StreamExt;
use reqwest::{Client, Response, redirect::Policy};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

const GEOCODING_ORIGIN: &str = "https://geocoding-api.open-meteo.com/v1/search";
const WEATHER_ORIGIN: &str = "https://api.open-meteo.com/v1/forecast";
const MAX_RESPONSE_BYTES: usize = 1_000_000;
const MAX_ICS_BYTES: usize = 2_000_000;
const MAX_PLAYLIST_BYTES: usize = 2_000_000;

mod apple_music;
mod music_source;
mod netease;
mod qqmusic;

pub use apple_music::{AppleMusicDocument, AppleMusicPlaylistIdentity, parse_apple_music_playlist};
pub use music_source::{
    MusicSourceCapabilities, MusicSourceDefinition, MusicSourceDocument,
    apple_developer_token_reference, apple_music_user_token_reference, music_source_registry,
};
pub use netease::{NeteaseMusicDocument, parse_netease_playlist_id};
pub use qqmusic::{QqMusicDocument, parse_qqmusic_playlist_id};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DailyError {
    InvalidInput,
    Unavailable,
    InvalidResponse,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WeatherLocation {
    pub label: String,
    pub latitude: f64,
    pub longitude: f64,
    pub language: String,
}

impl WeatherLocation {
    pub fn from_coordinates(
        label: &str,
        latitude: f64,
        longitude: f64,
        language: &str,
    ) -> Result<Self, DailyError> {
        let label = normalized_text(label, 120)?;
        validate_coordinates(latitude, longitude)?;
        let language = validate_language(language)?;
        Ok(Self {
            label,
            latitude,
            longitude,
            language,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct WeatherSnapshot {
    pub configured: bool,
    pub status: String,
    pub provider: String,
    pub location_label: String,
    pub condition: String,
    pub temperature_c: Option<f64>,
    pub apparent_temperature_c: Option<f64>,
    pub relative_humidity_percent: Option<f64>,
    pub is_day: Option<bool>,
    pub observed_at: Option<String>,
    pub expires_at: Option<String>,
    pub attribution: String,
    pub message: String,
}

impl WeatherSnapshot {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            configured: false,
            status: "not_configured".to_owned(),
            provider: String::new(),
            location_label: String::new(),
            condition: String::new(),
            temperature_c: None,
            apparent_temperature_c: None,
            relative_humidity_percent: None,
            is_day: None,
            observed_at: None,
            expires_at: None,
            attribution: String::new(),
            message: "Weather is off. Enter a place or explicitly approve one-shot location."
                .to_owned(),
        }
    }

    #[must_use]
    pub fn stale(mut self, message: &str) -> Self {
        self.status = "stale".to_owned();
        self.message = message.to_owned();
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CalendarEvent {
    pub event_id: String,
    pub title: String,
    pub starts_at: String,
    pub ends_at: String,
    pub all_day: bool,
    pub redacted: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CalendarSnapshot {
    pub configured: bool,
    pub status: String,
    pub events: Vec<CalendarEvent>,
    pub message: String,
}

impl CalendarSnapshot {
    #[must_use]
    pub fn system_only() -> Self {
        Self {
            configured: false,
            status: "not_configured".to_owned(),
            events: Vec::new(),
            message: "Date and time follow this device; event import is optional.".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct NativeCalendarCapability {
    pub platform: String,
    pub adapter: String,
    pub available: bool,
    pub status: String,
    pub detail_scopes: Vec<String>,
    pub message: String,
}

/// Inspect native calendar capability without triggering an operating-system prompt.
#[must_use]
pub fn native_calendar_capability() -> NativeCalendarCapability {
    #[cfg(target_os = "macos")]
    {
        use eventkit::{EKAuthorizationStatus, event_store::EKEntityType};

        let authorization =
            eventkit::event_store::EKEventStore::authorization_status(EKEntityType::Event);
        let (status, message) = match authorization {
            EKAuthorizationStatus::NotDetermined => (
                "not_determined",
                "Press Connect to let macOS ask for Calendar access.",
            ),
            EKAuthorizationStatus::FullAccess => (
                "authorized",
                "macOS Calendar access is available; Restork still defaults to busy-only fields.",
            ),
            EKAuthorizationStatus::Denied => (
                "denied",
                "Calendar access was denied. You can change it in System Settings.",
            ),
            EKAuthorizationStatus::Restricted | EKAuthorizationStatus::WriteOnly => (
                "restricted",
                "The current Calendar permission cannot read events.",
            ),
            EKAuthorizationStatus::Unknown(_) => (
                "unavailable",
                "The current Calendar authorization state is unavailable.",
            ),
            _ => (
                "unavailable",
                "The current Calendar authorization state is unavailable.",
            ),
        };
        return NativeCalendarCapability {
            platform: "macos".to_owned(),
            adapter: "eventkit".to_owned(),
            available: true,
            status: status.to_owned(),
            detail_scopes: vec!["busy_only".to_owned(), "titles".to_owned()],
            message: message.to_owned(),
        };
    }

    #[cfg(target_os = "windows")]
    {
        return NativeCalendarCapability {
            platform: "windows".to_owned(),
            adapter: "windows_appointments".to_owned(),
            available: false,
            status: "adapter_unavailable".to_owned(),
            detail_scopes: vec!["busy_only".to_owned(), "titles".to_owned()],
            message: "The Windows appointment capability is not available in this build; ICS remains optional fallback.".to_owned(),
        };
    }

    #[cfg(target_os = "linux")]
    {
        return NativeCalendarCapability {
            platform: "linux".to_owned(),
            adapter: "desktop_calendar".to_owned(),
            available: false,
            status: "unsupported".to_owned(),
            detail_scopes: vec!["busy_only".to_owned(), "titles".to_owned()],
            message: "Linux has no standard XDG Calendar portal; use the optional read-only ICS fallback.".to_owned(),
        };
    }

    #[allow(unreachable_code)]
    NativeCalendarCapability {
        platform: std::env::consts::OS.to_owned(),
        adapter: "none".to_owned(),
        available: false,
        status: "unsupported".to_owned(),
        detail_scopes: Vec::new(),
        message: "Native Calendar access is unsupported on this platform.".to_owned(),
    }
}

/// Request native Calendar permission and return a bounded read-only snapshot.
/// This must only be called after an explicit user action because it may show an
/// operating-system permission dialog.
pub fn connect_native_calendar(include_titles: bool) -> Result<CalendarSnapshot, DailyError> {
    #[cfg(not(target_os = "macos"))]
    let _ = include_titles;

    #[cfg(target_os = "macos")]
    {
        use eventkit::{
            EKAuthorizationStatus,
            event_store::{EKEntityType, EKEventStore},
        };

        let store = EKEventStore::new().map_err(|_| DailyError::Unavailable)?;
        let mut authorization = EKEventStore::authorization_status(EKEntityType::Event);
        if authorization == EKAuthorizationStatus::NotDetermined {
            let granted = store
                .request_full_access_to_events()
                .map_err(|_| DailyError::Unavailable)?;
            if !granted {
                return Ok(native_calendar_denied("Calendar access was not granted."));
            }
            authorization = EKEventStore::authorization_status(EKEntityType::Event);
        }
        if authorization != EKAuthorizationStatus::FullAccess {
            return Ok(native_calendar_denied(match authorization {
                EKAuthorizationStatus::Denied => "Calendar access is denied in System Settings.",
                EKAuthorizationStatus::Restricted | EKAuthorizationStatus::WriteOnly => {
                    "The current Calendar permission cannot read events."
                }
                _ => "Calendar access is unavailable.",
            }));
        }
        let start = Utc::now();
        let end = start + ChronoDuration::days(30);
        let predicate = store.predicate_for_events(start.to_rfc3339(), end.to_rfc3339(), None);
        let mut native_events = store
            .events_matching(&predicate)
            .map_err(|_| DailyError::Unavailable)?;
        native_events.sort_by(|left, right| left.start_date.cmp(&right.start_date));
        let events = native_events
            .into_iter()
            .take(100)
            .map(|event| {
                let fallback_id = digest_parts(&[
                    event.start_date.as_str(),
                    event.end_date.as_str(),
                    event.title.as_str(),
                ]);
                CalendarEvent {
                    event_id: event.identifier.unwrap_or(fallback_id),
                    title: if include_titles {
                        event.title
                    } else {
                        "Busy".to_owned()
                    },
                    starts_at: event.start_date,
                    ends_at: event.end_date,
                    all_day: event.all_day,
                    redacted: !include_titles,
                }
            })
            .collect();
        return Ok(CalendarSnapshot {
            configured: true,
            status: "ready".to_owned(),
            events,
            message: if include_titles {
                "Showing a bounded read-only EventKit snapshot with explicitly approved titles."
                    .to_owned()
            } else {
                "Showing a bounded read-only EventKit snapshot with titles redacted.".to_owned()
            },
        });
    }

    #[allow(unreachable_code)]
    Ok(CalendarSnapshot {
        configured: false,
        status: "unsupported".to_owned(),
        events: Vec::new(),
        message: native_calendar_capability().message,
    })
}

#[cfg(target_os = "macos")]
fn native_calendar_denied(message: &str) -> CalendarSnapshot {
    CalendarSnapshot {
        configured: false,
        status: "denied".to_owned(),
        events: Vec::new(),
        message: message.to_owned(),
    }
}

#[cfg(target_os = "macos")]
fn digest_parts(parts: &[&str]) -> String {
    let mut digest = Sha256::new();
    for part in parts {
        digest.update(part.as_bytes());
        digest.update([0]);
    }
    let encoded = digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("native-{encoded}")
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PlaylistItem {
    #[serde(alias = "id")]
    pub item_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default, alias = "note")]
    pub analysis: String,
    #[serde(default)]
    pub cover_url: String,
    #[serde(default)]
    pub source_provider: String,
    #[serde(default)]
    pub source_item_id: String,
    #[serde(default)]
    pub source_url: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub genre: String,
    #[serde(default)]
    pub published_on: Option<String>,
    #[serde(default)]
    pub popularity_reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicEvidenceSource {
    pub title: String,
    pub url: String,
    pub publisher: String,
    pub published_on: Option<String>,
    pub supports: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicResearchSummary {
    pub status: String,
    pub model: String,
    pub researched_at: String,
    pub song_analysis_en: String,
    pub song_analysis_zh_cn: String,
    pub popularity_reason_en: String,
    pub popularity_reason_zh_cn: String,
    pub popularity_supported: bool,
    pub sources: Vec<MusicEvidenceSource>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicRecommendation {
    pub item_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub tags: Vec<String>,
    pub analysis: String,
    pub recommendation_reason: String,
    pub song_analysis: String,
    pub popularity_reason: String,
    pub language: String,
    pub genre: String,
    pub published_on: Option<String>,
    pub source_url: String,
    pub cover_available: bool,
    #[serde(default)]
    pub research: Option<MusicResearchSummary>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicDiscovery {
    pub item_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub language: String,
    pub genre: String,
    pub label: String,
    pub published_on: Option<String>,
    pub chart_name: String,
    pub chart_rank: usize,
    pub chart_updated_on: Option<String>,
    pub affinity_artist: String,
    pub affinity_count: usize,
    pub recommendation_reason: String,
    pub song_analysis: String,
    pub popularity_reason: String,
    pub source_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicSourceSummary {
    pub provider: String,
    pub label: String,
    pub item_count: usize,
    pub synced_at: Option<String>,
    pub public_url: String,
    pub refresh_supported: bool,
    pub experimental: bool,
    #[serde(default)]
    pub official_api: bool,
    #[serde(default = "default_true")]
    pub read_only: bool,
    #[serde(default)]
    pub requires_user_consent: bool,
    #[serde(default)]
    pub supports_charts: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicSnapshot {
    pub configured: bool,
    pub status: String,
    pub recommendation: Option<MusicRecommendation>,
    pub source: Option<MusicSourceSummary>,
    pub discoveries: Vec<MusicDiscovery>,
    pub message: String,
}

impl MusicSnapshot {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            configured: false,
            status: "not_configured".to_owned(),
            recommendation: None,
            source: None,
            discoveries: Vec::new(),
            message: "Connect a supported music source or import a private JSON/CSV playlist."
                .to_owned(),
        }
    }
}

const fn default_true() -> bool {
    true
}

pub struct DailyClient {
    client: Client,
}

impl DailyClient {
    pub fn new() -> Result<Self, DailyError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(12))
            .redirect(Policy::none())
            .user_agent("Restork/0.1 daily-context")
            .build()
            .map_err(|_| DailyError::Unavailable)?;
        Ok(Self { client })
    }

    /// Fetch album art only through a provider-owned, adapter-validated origin.
    pub async fn music_cover(
        &self,
        provider: &str,
        cover_url: &str,
    ) -> Result<(Vec<u8>, String), DailyError> {
        match provider {
            "qqmusic" => self.qq_music_cover(cover_url).await,
            "netease" => self.netease_music_cover(cover_url).await,
            "apple-music" => self.apple_music_cover(cover_url).await,
            _ => Err(DailyError::InvalidInput),
        }
    }

    pub async fn resolve_location(
        &self,
        query: &str,
        language: &str,
    ) -> Result<WeatherLocation, DailyError> {
        let query = normalized_text(query, 120)?;
        if query.chars().count() < 2 {
            return Err(DailyError::InvalidInput);
        }
        let language = validate_language(language)?;
        let response = self
            .client
            .get(GEOCODING_ORIGIN)
            .query(&[
                ("name", query.as_str()),
                ("count", "1"),
                ("language", language.as_str()),
                ("format", "json"),
            ])
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let payload: GeocodingResponse = bounded_json(response).await?;
        let place = payload
            .results
            .and_then(|mut results| (!results.is_empty()).then(|| results.remove(0)))
            .ok_or(DailyError::InvalidResponse)?;
        validate_coordinates(place.latitude, place.longitude)?;
        let label = [Some(place.name), place.admin1, place.country]
            .into_iter()
            .flatten()
            .filter(|part| !part.trim().is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        WeatherLocation::from_coordinates(&label, place.latitude, place.longitude, &language)
    }

    pub async fn weather(&self, location: &WeatherLocation) -> Result<WeatherSnapshot, DailyError> {
        validate_coordinates(location.latitude, location.longitude)?;
        let response = self
            .client
            .get(WEATHER_ORIGIN)
            .query(&[
                ("latitude", location.latitude.to_string()),
                ("longitude", location.longitude.to_string()),
                (
                    "current",
                    "temperature_2m,apparent_temperature,relative_humidity_2m,is_day,weather_code"
                        .to_owned(),
                ),
                ("timezone", "UTC".to_owned()),
            ])
            .send()
            .await
            .map_err(|_| DailyError::Unavailable)?;
        let payload: WeatherResponse = bounded_json(response).await?;
        let current = payload.current.ok_or(DailyError::InvalidResponse)?;
        let observed_at = normalize_open_meteo_time(&current.time)?;
        let expires_at = (Utc::now() + ChronoDuration::minutes(15)).to_rfc3339();
        Ok(WeatherSnapshot {
            configured: true,
            status: "fresh".to_owned(),
            provider: "open-meteo".to_owned(),
            location_label: location.label.clone(),
            condition: condition_name(current.weather_code, &location.language).to_owned(),
            temperature_c: finite(current.temperature_2m),
            apparent_temperature_c: finite(current.apparent_temperature),
            relative_humidity_percent: finite(current.relative_humidity_2m),
            is_day: current.is_day.map(|value| value != 0),
            observed_at: Some(observed_at),
            expires_at: Some(expires_at),
            attribution: "Weather data by Open-Meteo".to_owned(),
            message: "Weather fetched after explicit location setup.".to_owned(),
        })
    }
}

#[derive(Deserialize)]
struct GeocodingResponse {
    results: Option<Vec<GeocodingPlace>>,
}

#[derive(Deserialize)]
struct GeocodingPlace {
    name: String,
    admin1: Option<String>,
    country: Option<String>,
    latitude: f64,
    longitude: f64,
}

#[derive(Deserialize)]
struct WeatherResponse {
    current: Option<CurrentWeather>,
}

#[derive(Deserialize)]
struct CurrentWeather {
    time: String,
    temperature_2m: Option<f64>,
    apparent_temperature: Option<f64>,
    relative_humidity_2m: Option<f64>,
    is_day: Option<i64>,
    weather_code: Option<i64>,
}

async fn bounded_json<T: DeserializeOwned>(response: Response) -> Result<T, DailyError> {
    bounded_json_with_limit(response, MAX_RESPONSE_BYTES).await
}

async fn bounded_json_with_limit<T: DeserializeOwned>(
    response: Response,
    maximum: usize,
) -> Result<T, DailyError> {
    if !response.status().is_success() {
        return Err(DailyError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > maximum as u64)
    {
        return Err(DailyError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| DailyError::Unavailable)?;
        if bytes.len().saturating_add(chunk.len()) > maximum {
            return Err(DailyError::InvalidResponse);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| DailyError::InvalidResponse)
}

pub fn parse_ics(
    filename: &str,
    content: &str,
    timezone: &str,
) -> Result<Vec<CalendarEvent>, DailyError> {
    if !filename.to_ascii_lowercase().ends_with(".ics")
        || content.is_empty()
        || content.len() > MAX_ICS_BYTES
        || content.contains('\0')
    {
        return Err(DailyError::InvalidInput);
    }
    let timezone = timezone
        .parse::<Tz>()
        .map_err(|_| DailyError::InvalidInput)?;
    let lines = unfold_ics(content)?;
    let mut in_event = false;
    let mut fields = BTreeMap::<String, (String, String)>::new();
    let mut events = Vec::new();
    for line in lines {
        if line.eq_ignore_ascii_case("BEGIN:VEVENT") {
            if in_event {
                return Err(DailyError::InvalidInput);
            }
            in_event = true;
            fields.clear();
            continue;
        }
        if line.eq_ignore_ascii_case("END:VEVENT") {
            if !in_event {
                return Err(DailyError::InvalidInput);
            }
            if events.len() >= 500 {
                return Err(DailyError::InvalidInput);
            }
            events.push(calendar_event(&fields, timezone, events.len())?);
            in_event = false;
            fields.clear();
            continue;
        }
        if !in_event {
            continue;
        }
        let (property, value) = line.split_once(':').ok_or(DailyError::InvalidInput)?;
        let name = property
            .split(';')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if matches!(name.as_str(), "DTSTART" | "DTEND") {
            fields.insert(name, (property.to_owned(), value.to_owned()));
        }
    }
    if in_event {
        return Err(DailyError::InvalidInput);
    }
    events.sort_by(|left, right| {
        left.starts_at
            .cmp(&right.starts_at)
            .then_with(|| left.event_id.cmp(&right.event_id))
    });
    Ok(events)
}

fn unfold_ics(content: &str) -> Result<Vec<String>, DailyError> {
    let mut output = Vec::<String>::new();
    for line in content.replace("\r\n", "\n").replace('\r', "\n").lines() {
        if line.len() > 16_384 {
            return Err(DailyError::InvalidInput);
        }
        if line.starts_with([' ', '\t']) {
            let previous = output.last_mut().ok_or(DailyError::InvalidInput)?;
            if previous.len().saturating_add(line.len()) > 16_384 {
                return Err(DailyError::InvalidInput);
            }
            previous.push_str(line.trim_start_matches([' ', '\t']));
        } else {
            output.push(line.to_owned());
        }
    }
    Ok(output)
}

fn calendar_event(
    fields: &BTreeMap<String, (String, String)>,
    timezone: Tz,
    sequence: usize,
) -> Result<CalendarEvent, DailyError> {
    let (start_property, start_value) = fields.get("DTSTART").ok_or(DailyError::InvalidInput)?;
    let all_day =
        start_property.to_ascii_uppercase().contains("VALUE=DATE") || start_value.len() == 8;
    let starts = parse_ics_datetime(start_value, timezone, all_day)?;
    let ends = match fields.get("DTEND") {
        Some((property, value)) => parse_ics_datetime(
            value,
            timezone,
            property.to_ascii_uppercase().contains("VALUE=DATE") || value.len() == 8,
        )?,
        None if all_day => starts + ChronoDuration::days(1),
        None => starts + ChronoDuration::hours(1),
    };
    if ends <= starts || ends - starts > ChronoDuration::days(370) {
        return Err(DailyError::InvalidInput);
    }
    let mut hasher = Sha256::new();
    hasher.update(starts.to_rfc3339());
    hasher.update([0]);
    hasher.update(ends.to_rfc3339());
    hasher.update([0]);
    hasher.update(sequence.to_le_bytes());
    let digest = hasher.finalize();
    let event_id = format!(
        "calendar-{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    Ok(CalendarEvent {
        event_id,
        title: "Busy".to_owned(),
        starts_at: starts.to_rfc3339(),
        ends_at: ends.to_rfc3339(),
        all_day,
        redacted: true,
    })
}

fn parse_ics_datetime(
    value: &str,
    timezone: Tz,
    all_day: bool,
) -> Result<DateTime<Utc>, DailyError> {
    if all_day {
        let date =
            NaiveDate::parse_from_str(value, "%Y%m%d").map_err(|_| DailyError::InvalidInput)?;
        return resolve_local(
            timezone,
            date.and_hms_opt(0, 0, 0).ok_or(DailyError::InvalidInput)?,
        );
    }
    if let Some(utc_value) = value.strip_suffix('Z')
        && let Ok(value) = NaiveDateTime::parse_from_str(utc_value, "%Y%m%dT%H%M%S")
    {
        return Ok(Utc.from_utc_datetime(&value));
    }
    let local = NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .map_err(|_| DailyError::InvalidInput)?;
    resolve_local(timezone, local)
}

fn resolve_local(timezone: Tz, local: NaiveDateTime) -> Result<DateTime<Utc>, DailyError> {
    timezone
        .from_local_datetime(&local)
        .earliest()
        .map(|value| value.with_timezone(&Utc))
        .ok_or(DailyError::InvalidInput)
}

pub fn parse_playlist(filename: &str, content: &str) -> Result<Vec<PlaylistItem>, DailyError> {
    if content.is_empty() || content.len() > MAX_PLAYLIST_BYTES || content.contains('\0') {
        return Err(DailyError::InvalidInput);
    }
    let lower = filename.to_ascii_lowercase();
    let items = if lower.ends_with(".json") {
        serde_json::from_str::<Vec<PlaylistItem>>(content).map_err(|_| DailyError::InvalidInput)?
    } else if lower.ends_with(".csv") {
        parse_playlist_csv(content)?
    } else {
        return Err(DailyError::InvalidInput);
    };
    if items.is_empty() || items.len() > 10_000 {
        return Err(DailyError::InvalidInput);
    }
    for item in &items {
        validate_playlist_item(item)?;
    }
    Ok(items)
}

fn parse_playlist_csv(content: &str) -> Result<Vec<PlaylistItem>, DailyError> {
    let mut lines = content.lines();
    let headers = csv_row(lines.next().ok_or(DailyError::InvalidInput)?)?;
    let index = headers
        .iter()
        .enumerate()
        .map(|(index, value)| (value.trim().to_ascii_lowercase(), index))
        .collect::<BTreeMap<_, _>>();
    let title_index = *index.get("title").ok_or(DailyError::InvalidInput)?;
    let mut items = Vec::new();
    for (sequence, line) in lines.enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let row = csv_row(line)?;
        let field = |name: &str| {
            index
                .get(name)
                .and_then(|position| row.get(*position))
                .cloned()
                .unwrap_or_default()
        };
        let title = row.get(title_index).cloned().unwrap_or_default();
        let item_id = {
            let value = field("item_id");
            if value.trim().is_empty() {
                format!("track-{}", sequence + 1)
            } else {
                value
            }
        };
        items.push(PlaylistItem {
            item_id,
            title,
            artist: field("artist"),
            album: field("album"),
            tags: field("tags")
                .split('|')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect(),
            analysis: field("analysis"),
            cover_url: String::new(),
            source_provider: String::new(),
            source_item_id: String::new(),
            source_url: String::new(),
            language: String::new(),
            genre: String::new(),
            published_on: None,
            popularity_reason: String::new(),
        });
    }
    Ok(items)
}

fn csv_row(line: &str) -> Result<Vec<String>, DailyError> {
    if line.len() > 64_000 {
        return Err(DailyError::InvalidInput);
    }
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = line.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '"' if quoted && characters.peek() == Some(&'"') => {
                field.push('"');
                characters.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => {
                fields.push(field);
                field = String::new();
            }
            value => field.push(value),
        }
    }
    if quoted {
        return Err(DailyError::InvalidInput);
    }
    fields.push(field);
    Ok(fields)
}

fn validate_playlist_item(item: &PlaylistItem) -> Result<(), DailyError> {
    normalized_identifier(&item.item_id, 128)?;
    normalized_text(&item.title, 240)?;
    for value in [
        &item.artist,
        &item.album,
        &item.analysis,
        &item.source_provider,
        &item.source_item_id,
        &item.language,
        &item.genre,
        &item.popularity_reason,
    ] {
        if !value.is_empty() {
            normalized_text(value, 2_000)?;
        }
    }
    for value in [&item.cover_url, &item.source_url] {
        if !value.is_empty() {
            validate_https_url(value)?;
        }
    }
    if let Some(value) = &item.published_on {
        NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| DailyError::InvalidInput)?;
    }
    if item.tags.len() > 32 {
        return Err(DailyError::InvalidInput);
    }
    for tag in &item.tags {
        normalized_text(tag, 80)?;
    }
    Ok(())
}

pub fn music_snapshot(items: &[PlaylistItem], local_date: &str) -> MusicSnapshot {
    music_snapshot_with_context(items, None, &[], local_date)
}

#[must_use]
pub fn music_snapshot_with_context(
    items: &[PlaylistItem],
    source: Option<MusicSourceSummary>,
    discoveries: &[MusicDiscovery],
    local_date: &str,
) -> MusicSnapshot {
    if items.is_empty() {
        return MusicSnapshot::disabled();
    }
    let mut hasher = Sha256::new();
    hasher.update(local_date.as_bytes());
    let digest = hasher.finalize();
    let seed = u64::from_le_bytes(digest[..8].try_into().expect("digest prefix"));
    let index = usize::try_from(seed % items.len() as u64).unwrap_or_default();
    let item = &items[index];
    let recommendation_reason =
        "Selected by a deterministic daily rotation from your private playlist.".to_owned();
    let song_analysis = if item.analysis.is_empty() {
        let facts = [
            item.published_on
                .as_ref()
                .map(|value| format!("released {value}")),
            (!item.language.is_empty()).then(|| format!("language: {}", item.language)),
            (!item.genre.is_empty()).then(|| format!("genre: {}", item.genre)),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        if facts.is_empty() {
            "No reviewed song-detail evidence is cached yet. Refresh the connected source."
                .to_owned()
        } else {
            format!("QQ Music structured metadata records {}.", facts.join("; "))
        }
    } else {
        item.analysis.clone()
    };
    MusicSnapshot {
        configured: true,
        status: "ready".to_owned(),
        recommendation: Some(MusicRecommendation {
            item_id: item.item_id.clone(),
            title: item.title.clone(),
            artist: item.artist.clone(),
            album: item.album.clone(),
            tags: item.tags.clone(),
            analysis: recommendation_reason.clone(),
            recommendation_reason,
            song_analysis,
            popularity_reason: item.popularity_reason.clone(),
            language: item.language.clone(),
            genre: item.genre.clone(),
            published_on: item.published_on.clone(),
            source_url: item.source_url.clone(),
            cover_available: !item.cover_url.is_empty(),
            research: None,
        }),
        source,
        discoveries: discoveries.iter().take(5).cloned().collect(),
        message: "Selected deterministically from the private playlist snapshot.".to_owned(),
    }
}

#[must_use]
pub fn selected_music_cover_url(items: &[PlaylistItem], local_date: &str) -> Option<String> {
    let snapshot = music_snapshot(items, local_date);
    let selected = snapshot.recommendation?;
    items
        .iter()
        .find(|item| item.item_id == selected.item_id)
        .map(|item| item.cover_url.clone())
        .filter(|value| !value.is_empty())
}

fn validate_https_url(value: &str) -> Result<(), DailyError> {
    let parsed = url::Url::parse(value).map_err(|_| DailyError::InvalidInput)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err(DailyError::InvalidInput);
    }
    Ok(())
}

fn normalized_text(value: &str, maximum: usize) -> Result<String, DailyError> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty()
        || normalized.chars().count() > maximum
        || normalized.chars().any(char::is_control)
    {
        return Err(DailyError::InvalidInput);
    }
    Ok(normalized)
}

fn normalized_identifier(value: &str, maximum: usize) -> Result<String, DailyError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(DailyError::InvalidInput);
    }
    Ok(value.to_owned())
}

fn validate_coordinates(latitude: f64, longitude: f64) -> Result<(), DailyError> {
    if latitude.is_finite()
        && longitude.is_finite()
        && (-90.0..=90.0).contains(&latitude)
        && (-180.0..=180.0).contains(&longitude)
    {
        Ok(())
    } else {
        Err(DailyError::InvalidInput)
    }
}

fn validate_language(language: &str) -> Result<String, DailyError> {
    match language {
        "en" | "zh" => Ok(language.to_owned()),
        _ => Err(DailyError::InvalidInput),
    }
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

fn normalize_open_meteo_time(value: &str) -> Result<String, DailyError> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc).to_rfc3339());
    }
    let parsed = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M")
        .map_err(|_| DailyError::InvalidResponse)?;
    Ok(Utc.from_utc_datetime(&parsed).to_rfc3339())
}

fn condition_name(code: Option<i64>, language: &str) -> &'static str {
    let group = match code.unwrap_or(-1) {
        0 => 0,
        1..=3 => 1,
        45 | 48 => 2,
        51..=57 => 3,
        61..=67 | 80..=82 => 4,
        71..=77 | 85 | 86 => 5,
        95..=99 => 6,
        _ => 7,
    };
    match (language, group) {
        ("zh", 0) => "晴",
        ("zh", 1) => "多云",
        ("zh", 2) => "雾",
        ("zh", 3) => "毛毛雨",
        ("zh", 4) => "雨",
        ("zh", 5) => "雪",
        ("zh", 6) => "雷暴",
        ("zh", _) => "天气未知",
        (_, 0) => "Clear",
        (_, 1) => "Cloudy",
        (_, 2) => "Fog",
        (_, 3) => "Drizzle",
        (_, 4) => "Rain",
        (_, 5) => "Snow",
        (_, 6) => "Thunderstorm",
        _ => "Unknown weather",
    }
}

#[cfg(test)]
mod tests {
    use super::{music_snapshot, parse_ics, parse_playlist};

    #[test]
    fn local_ics_is_bounded_and_redacts_event_details() {
        let events = parse_ics(
            "calendar.ics",
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20260802T090000Z\r\nDTEND:20260802T100000Z\r\nSUMMARY:Private roadmap\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "Asia/Shanghai",
        )
        .expect("valid ICS");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Busy");
        assert!(events[0].redacted);
    }

    #[test]
    fn json_and_csv_playlists_select_a_stable_daily_track() {
        let json = parse_playlist(
            "tracks.json",
            r#"[{"item_id":"track-1","title":"Synthetic Song","artist":"Fixture"}]"#,
        )
        .expect("JSON playlist");
        let csv = parse_playlist(
            "tracks.csv",
            "title,artist,album,tags\nSynthetic Song,Fixture,Test,study|calm\n",
        )
        .expect("CSV playlist");
        assert_eq!(
            music_snapshot(&json, "2026-08-02")
                .recommendation
                .unwrap()
                .title,
            "Synthetic Song"
        );
        assert_eq!(csv[0].tags, ["study", "calm"]);
    }
}
