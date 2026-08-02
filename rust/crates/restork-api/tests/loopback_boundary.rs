use axum::{
    body::Body,
    http::{Method, Request, StatusCode, header},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use serde_json::{Value, json};
use std::time::Duration;
use tower::ServiceExt;

fn app() -> axum::Router {
    restork_api::router(PairingAuthority::new(Duration::from_secs(300)).expect("pairing authority"))
}

async fn request(path: &str, origin: Option<&str>) -> (StatusCode, header::HeaderMap, Value) {
    let mut builder = Request::builder().uri(path);
    if let Some(origin) = origin {
        builder = builder.header(header::ORIGIN, origin);
    }
    let response = app()
        .oneshot(builder.body(Body::empty()).expect("valid request"))
        .await
        .expect("router response");
    let status = response.status();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let json = serde_json::from_slice(&body).expect("JSON response");
    (status, headers, json)
}

#[tokio::test]
async fn public_readiness_matches_the_v1_compatibility_contract() {
    let (status, headers, body) = request("/v1/readiness", None).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"status": "ready", "schema": "v1"}));
    assert_eq!(
        headers.get(header::CONTENT_TYPE).expect("content type"),
        "application/json"
    );
    assert_eq!(
        headers
            .get("content-security-policy")
            .expect("content security policy"),
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    assert_eq!(
        headers
            .get("x-content-type-options")
            .expect("content type options"),
        "nosniff"
    );
    assert_eq!(
        headers.get("referrer-policy").expect("referrer policy"),
        "no-referrer"
    );
}

#[tokio::test]
async fn rust_core_serves_the_embedded_dashboard_without_a_python_runtime() {
    let response = app()
        .oneshot(
            Request::builder()
                .uri("/")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::CONTENT_TYPE)
            .expect("content type"),
        "text/html; charset=utf-8"
    );
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    assert!(
        String::from_utf8_lossy(&body).contains("<title>Restork · Local Agent Workspace</title>")
    );
}

#[tokio::test]
async fn credentials_are_rejected_in_query_parameters_even_when_encoded() {
    for path in [
        "/v1/readiness?token=secret",
        "/v1/readiness?authorization=secret",
        "/v1/readiness?access_token=secret",
        "/v1/readiness?%74oken=secret",
    ] {
        let (status, _, body) = request(path, None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
        assert_eq!(
            body,
            json!({"detail": "credentials are forbidden in query parameters"})
        );
    }
}

#[tokio::test]
async fn browser_origins_must_be_explicit_loopback_http_origins() {
    for origin in [
        "https://evil.test",
        "https://localhost:5173",
        "http://127.0.0.1",
        "http://user@localhost:5173",
        "http://localhost:5173/path",
    ] {
        let (status, _, body) = request("/v1/readiness", Some(origin)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin}");
        assert_eq!(body, json!({"detail": "cross-origin request denied"}));
    }

    for origin in [
        "http://127.0.0.1:5173",
        "http://localhost:7337",
        "http://localhost:80",
        "HTTP://LOCALHOST:5173",
        "http://[::1]:1420",
    ] {
        let (status, headers, _) = request("/v1/readiness", Some(origin)).await;
        assert_eq!(status, StatusCode::OK, "{origin}");
        assert_eq!(
            headers
                .get("access-control-allow-origin")
                .expect("allowed origin"),
            origin
        );
        assert_eq!(headers.get(header::VARY).expect("vary"), "Origin");
    }
}

#[tokio::test]
async fn cli_pairing_rejects_every_browser_origin_before_routing() {
    let (status, _, body) = request("/v1/cli/pair", Some("http://127.0.0.1:5173")).await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        body,
        json!({"detail": "CLI pairing rejects browser origins"})
    );
}

#[tokio::test]
async fn cors_preflight_allows_only_the_v1_method_and_header_contract() {
    let allowed = Request::builder()
        .method(Method::OPTIONS)
        .uri("/v1/readiness")
        .header(header::ORIGIN, "http://127.0.0.1:5173")
        .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
        .header(
            header::ACCESS_CONTROL_REQUEST_HEADERS,
            "authorization, last-event-id",
        )
        .body(Body::empty())
        .expect("valid preflight");
    let response = app().oneshot(allowed).await.expect("router response");

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .expect("allowed origin"),
        "http://127.0.0.1:5173"
    );
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_METHODS)
            .expect("allowed methods"),
        "GET, POST, OPTIONS"
    );

    for (requested_method, requested_headers, expected_status) in [
        ("DELETE", "content-type", StatusCode::METHOD_NOT_ALLOWED),
        ("POST", "x-unsafe", StatusCode::BAD_REQUEST),
    ] {
        let denied = Request::builder()
            .method(Method::OPTIONS)
            .uri("/v1/readiness")
            .header(header::ORIGIN, "http://localhost:7337")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, requested_method)
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, requested_headers)
            .body(Body::empty())
            .expect("valid preflight");
        let response = app().oneshot(denied).await.expect("router response");
        assert_eq!(response.status(), expected_status);
    }
}
