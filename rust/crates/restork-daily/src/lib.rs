//! Optional, consent-driven daily context for the Rust Core.
//!
//! Network destinations are fixed Open-Meteo origins. Calendar and playlist
//! imports are bounded local snapshots; no location or source is inferred at
//! startup.

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
#[serde(deny_unknown_fields)]
pub struct PlaylistItem {
    pub item_id: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub analysis: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicRecommendation {
    pub item_id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub tags: Vec<String>,
    pub analysis: String,
    pub cover_available: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MusicSnapshot {
    pub configured: bool,
    pub status: String,
    pub recommendation: Option<MusicRecommendation>,
    pub message: String,
}

impl MusicSnapshot {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            configured: false,
            status: "not_configured".to_owned(),
            recommendation: None,
            message: "Import a private JSON or CSV playlist to enable daily tracks.".to_owned(),
        }
    }
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
            .no_proxy()
            .user_agent("Restork/0.1 daily-context")
            .build()
            .map_err(|_| DailyError::Unavailable)?;
        Ok(Self { client })
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
    if !response.status().is_success() {
        return Err(DailyError::Unavailable);
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(DailyError::InvalidResponse);
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| DailyError::Unavailable)?;
        if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
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
    for value in [&item.artist, &item.album, &item.analysis] {
        if !value.is_empty() {
            normalized_text(value, 2_000)?;
        }
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
    if items.is_empty() {
        return MusicSnapshot::disabled();
    }
    let mut hasher = Sha256::new();
    hasher.update(local_date.as_bytes());
    let digest = hasher.finalize();
    let seed = u64::from_le_bytes(digest[..8].try_into().expect("digest prefix"));
    let index = usize::try_from(seed % items.len() as u64).unwrap_or_default();
    let item = &items[index];
    MusicSnapshot {
        configured: true,
        status: "ready".to_owned(),
        recommendation: Some(MusicRecommendation {
            item_id: item.item_id.clone(),
            title: item.title.clone(),
            artist: item.artist.clone(),
            album: item.album.clone(),
            tags: item.tags.clone(),
            analysis: item.analysis.clone(),
            cover_available: false,
        }),
        message: "Selected deterministically from the private imported playlist.".to_owned(),
    }
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
