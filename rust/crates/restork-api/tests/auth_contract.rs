use std::{
    sync::{Arc, Mutex},
    time::{Duration, SystemTime},
};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use restork_core::auth::{Audience, CLI_SCOPES, Clock, PairingAuthority};
use serde_json::{Value, json};
use tower::ServiceExt;

async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    headers: &[(&str, &str)],
) -> (StatusCode, header::HeaderMap, Option<Value>) {
    let mut request = Request::builder().method(method).uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let body = match body {
        Some(body) => Body::from(serde_json::to_vec(&body).expect("serialize fixture")),
        None => Body::empty(),
    };
    let response = app
        .oneshot(request.body(body).expect("valid request"))
        .await
        .expect("router response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON body"));
    (status, headers, body)
}

fn authority() -> PairingAuthority {
    PairingAuthority::new(Duration::from_secs(300)).expect("authority")
}

#[derive(Debug)]
struct TestClock(Mutex<SystemTime>);

impl TestClock {
    fn new(now: SystemTime) -> Self {
        Self(Mutex::new(now))
    }

    fn advance(&self, duration: Duration) {
        let mut now = self.0.lock().expect("clock lock");
        *now = now.checked_add(duration).expect("fixture time");
    }
}

impl Clock for TestClock {
    fn now(&self) -> SystemTime {
        *self.0.lock().expect("clock lock")
    }
}

#[tokio::test]
async fn web_pairing_is_json_only_single_use_and_unlocks_health() {
    let authority = authority();
    let code = authority.initial_pairing_code();
    let app = restork_api::router(authority);

    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        body,
        Some(json!({"detail": "Content-Type must be application/json"}))
    );

    let (status, headers, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[
            ("content-type", "application/json; charset=utf-8"),
            ("origin", "http://127.0.0.1:5173"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .expect("allowed origin"),
        "http://127.0.0.1:5173"
    );
    let body = body.expect("token payload");
    let token = body["access_token"].as_str().expect("access token");
    assert_eq!(body["token_type"], "bearer");
    assert_eq!(body["audience"], "restork-web");
    assert!(body["scope"].as_str().expect("scope").contains("runs:read"));
    assert!(body["expires_at"].as_str().expect("expiry").contains('T'));

    let authorization = format!("Bearer {token}");
    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Some(json!({"status": "ready", "schema": "v1"})));

    let (status, headers, body) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/missing/events",
        None,
        &[("authorization", &authorization), ("last-event-id", "0")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, None);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).expect("SSE content type"),
        "text/event-stream; charset=utf-8"
    );
    assert_eq!(
        headers.get(header::CACHE_CONTROL).expect("cache control"),
        "no-cache, no-store"
    );
    assert_eq!(
        headers.get("x-accel-buffering").expect("proxy buffering"),
        "no"
    );

    for cursor in ["-1", "not-an-integer"] {
        let (status, _, _) = call(
            app.clone(),
            Method::GET,
            "/v1/runs/missing/events",
            None,
            &[("authorization", &authorization), ("last-event-id", cursor)],
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{cursor}");
    }
    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/runs/missing/events?follow=true",
        None,
        &[("authorization", &authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body, Some(json!({"detail": "run not found"})));

    let (status, _, _) = call(
        app,
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[("content-type", "application/json")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn browser_requests_reject_cli_tokens_and_rotation_is_single_session() {
    let authority = authority();
    let cli_code = authority
        .new_pairing_code(Audience::Cli, CLI_SCOPES)
        .expect("CLI challenge");
    let app = restork_api::router(authority);
    let (status, _, paired) = call(
        app.clone(),
        Method::POST,
        "/v1/cli/pair",
        Some(json!({"code": cli_code})),
        &[("content-type", "application/json")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let old_token = paired.expect("token")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    let old_authorization = format!("Bearer {old_token}");

    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[
            ("authorization", &old_authorization),
            ("origin", "http://localhost:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body,
        Some(json!({"detail": "browser requests require a Web audience token"}))
    );

    let (status, _, rotated) = call(
        app.clone(),
        Method::POST,
        "/v1/token/rotate",
        None,
        &[("authorization", &old_authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let new_token = rotated.expect("replacement")["access_token"]
        .as_str()
        .expect("token")
        .to_owned();
    assert_ne!(new_token, old_token);

    let (status, _, _) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", &old_authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let new_authorization = format!("Bearer {new_token}");
    let (status, _, body) = call(
        app.clone(),
        Method::POST,
        "/v1/token/revoke",
        None,
        &[("authorization", &new_authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(body, None);

    let (status, _, _) = call(
        app,
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", &new_authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn rotation_recovers_a_suspended_web_session_without_reopening_other_routes() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority =
        PairingAuthority::with_clock(Duration::from_secs(60), clock.clone()).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router(authority);
    let (status, _, paired) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[
            ("content-type", "application/json"),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let expired = paired.expect("paired token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    let expired_authorization = format!("Bearer {expired}");

    clock.advance(Duration::from_secs(61));
    let (status, _, rotated) = call(
        app.clone(),
        Method::POST,
        "/v1/token/rotate",
        None,
        &[
            ("authorization", &expired_authorization),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let recovered = rotated.expect("rotated token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    let recovered_authorization = format!("Bearer {recovered}");

    let (status, _, body) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[
            ("authorization", &recovered_authorization),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, Some(json!({"status": "ready", "schema": "v1"})));

    let (status, _, _) = call(
        app,
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", &expired_authorization)],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn browser_resume_cookie_survives_refresh_and_rotates_only_the_local_web_session() {
    let clock = Arc::new(TestClock::new(SystemTime::UNIX_EPOCH));
    let authority =
        PairingAuthority::with_clock(Duration::from_secs(60), clock.clone()).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router(authority);

    let (status, headers, paired) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        &[
            ("content-type", "application/json"),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let set_cookie = headers
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .expect("web pairing sets a protected resume cookie");
    assert!(set_cookie.starts_with("restork_loopback_session="));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));
    assert!(set_cookie.contains("Path=/v1/token"));
    assert!(set_cookie.contains("Max-Age=604800"));
    assert!(!set_cookie.contains("Domain="));
    let cookie = set_cookie
        .split(';')
        .next()
        .expect("cookie pair")
        .to_owned();
    let expired = paired.expect("paired token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();

    let (status, _, _) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[("cookie", &cookie), ("origin", "http://127.0.0.1:7337")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, _) = call(
        app.clone(),
        Method::POST,
        "/v1/token/resume",
        None,
        &[("cookie", &cookie)],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    clock.advance(Duration::from_secs(61));
    let (status, headers, resumed) = call(
        app.clone(),
        Method::POST,
        "/v1/token/resume",
        None,
        &[("cookie", &cookie), ("origin", "http://127.0.0.1:7337")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get(header::SET_COOKIE).is_some());
    let recovered = resumed.expect("resumed token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    assert_ne!(recovered, expired);

    let authorization = format!("Bearer {recovered}");
    let (status, _, _) = call(
        app.clone(),
        Method::GET,
        "/v1/health",
        None,
        &[
            ("authorization", &authorization),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, headers, _) = call(
        app.clone(),
        Method::POST,
        "/v1/token/revoke",
        None,
        &[
            ("authorization", &authorization),
            ("origin", "http://127.0.0.1:7337"),
        ],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(
        headers
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("Max-Age=0"))
    );

    let (status, _, _) = call(
        app,
        Method::POST,
        "/v1/token/resume",
        None,
        &[("origin", "http://127.0.0.1:7337")],
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
