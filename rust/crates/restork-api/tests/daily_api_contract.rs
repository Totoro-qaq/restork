use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::Database;
use serde_json::{Value, json};
use tower::ServiceExt;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("test entropy");
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path =
            PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("restork-api-daily-{suffix}"));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    authorization: Option<&str>,
    idempotency_key: Option<&str>,
) -> (StatusCode, Option<Value>) {
    let mut request = Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    if let Some(key) = idempotency_key {
        request = request.header("idempotency-key", key);
    }
    let response = app
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON response"));
    (status, body)
}

async fn paired_app() -> (Router, String, TestDirectory) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database);
    let (_, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        None,
        None,
    )
    .await;
    let token = body.expect("token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    (app, format!("Bearer {token}"), directory)
}

#[tokio::test]
async fn daily_context_is_zero_configuration_and_all_optional_sources_require_explicit_input() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, snapshot) = call(
        app.clone(),
        Method::GET,
        "/v1/daily?timezone=Asia%2FShanghai",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let snapshot = snapshot.expect("snapshot");
    assert_eq!(snapshot["weather"]["configured"], false);
    assert_eq!(snapshot["calendar"]["configured"], false);
    assert_eq!(snapshot["music"]["configured"], false);
    assert!(snapshot["native_calendar"]["adapter"].as_str().is_some());

    let (status, sources) = call(
        app.clone(),
        Method::GET,
        "/v1/daily/music/sources",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let sources = sources.expect("music source registry");
    assert_eq!(sources[0]["provider"], "local-file");
    assert_eq!(sources[1]["provider"], "qqmusic");
    assert_eq!(sources[1]["stability"], "experimental");
    assert_eq!(sources[2]["provider"], "netease");
    assert_eq!(sources[3]["provider"], "apple-music");
    assert_eq!(sources[3]["stability"], "official");
    assert_eq!(sources[3]["capabilities"]["supports_library"], false);

    let (status, capability) = call(
        app.clone(),
        Method::GET,
        "/v1/daily/calendar/native",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let capability = capability.expect("native calendar capability");
    assert!(capability["status"].as_str().is_some());
    assert_eq!(capability["detail_scopes"][0], "busy_only");

    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/daily/weather",
        Some(json!({
            "enabled": true,
            "mode": "coordinates",
            "label": "Approved location",
            "latitude": 31.2304,
            "longitude": 121.4737
        })),
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, location) = call(
        app.clone(),
        Method::POST,
        "/v1/daily/weather",
        Some(json!({
            "enabled": true,
            "mode": "coordinates",
            "label": "Approved location",
            "latitude": 31.2304,
            "longitude": 121.4737
        })),
        Some(&authorization),
        Some("daily-weather-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        location.expect("location")["location_label"],
        "Approved location"
    );

    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/daily/weather",
        Some(json!({"enabled": false})),
        Some(&authorization),
        Some("daily-weather-2"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, calendar) = call(
        app.clone(),
        Method::POST,
        "/v1/daily/calendar",
        Some(json!({
            "enabled": true,
            "filename": "private.ics",
            "content": "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20990802T090000Z\r\nDTEND:20990802T100000Z\r\nSUMMARY:Private title\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "timezone": "Asia/Shanghai"
        })),
        Some(&authorization),
        Some("daily-calendar-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let calendar = calendar.expect("calendar");
    assert_eq!(calendar["events"][0]["title"], "Busy");
    assert_eq!(calendar["events"][0]["redacted"], true);

    let (status, music) = call(
        app.clone(),
        Method::POST,
        "/v1/daily/music",
        Some(json!({
            "enabled": true,
            "filename": "playlist.csv",
            "content": "title,artist,album,tags,analysis\nSynthetic Song,Fixture,Test,study|calm,Private analysis\n",
            "local_date": "2026-08-02"
        })),
        Some(&authorization),
        Some("daily-music-1"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let music = music.expect("music");
    assert_eq!(music["recommendation"]["title"], "Synthetic Song");
    assert_eq!(music["source"]["provider"], "local-file");
    assert!(
        music["recommendation"]["recommendation_reason"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    );
    assert_eq!(music["discoveries"], json!([]));

    let (status, snapshot) = call(
        app,
        Method::GET,
        "/v1/daily?timezone=Asia%2FShanghai",
        None,
        Some(&authorization),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let snapshot = snapshot.expect("snapshot");
    assert_eq!(snapshot["calendar"]["events"][0]["title"], "Busy");
    assert_eq!(
        snapshot["music"]["recommendation"]["title"],
        "Synthetic Song"
    );
}
