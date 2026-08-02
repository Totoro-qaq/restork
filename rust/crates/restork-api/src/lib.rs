//! Loopback API compatibility layer for the Rust-first Restork runtime.

use std::collections::BTreeSet;

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use restork_core::auth::{
    AccessToken, Audience, AuthError, PairingAuthority, RUNS_READ, TOKENS_MANAGE,
};
use serde::Deserialize;
use serde::Serialize;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::{Host, Url};

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const FORBIDDEN_QUERY_KEYS: [&str; 3] = ["access_token", "authorization", "token"];

#[derive(Serialize)]
struct Readiness<'a> {
    status: &'a str,
    schema: &'a str,
}

#[derive(Serialize)]
struct ErrorBody<'a> {
    detail: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PairPayload {
    code: String,
}

#[derive(Serialize)]
struct TokenPayload<'a> {
    access_token: &'a str,
    token_type: &'static str,
    audience: &'static str,
    scope: String,
    expires_at: String,
}

/// Build the versioned local API surface currently implemented by Rust.
///
/// Compatibility routes migrate here one vertical slice at a time. Routes that
/// have not migrated continue to be owned by the Python Core.
pub fn router(authority: PairingAuthority) -> Router {
    Router::new()
        .route("/v1/readiness", get(readiness))
        .route("/v1/health", get(health))
        .route("/v1/pair", axum::routing::post(pair_web))
        .route("/v1/cli/pair", axum::routing::post(pair_cli))
        .route("/v1/token/rotate", axum::routing::post(rotate_token))
        .route("/v1/token/revoke", axum::routing::post(revoke_token))
        .route("/v1/runs/{run_id}/events", get(run_events))
        .layer(middleware::from_fn(local_browser_boundary))
        .with_state(authority)
}

async fn readiness() -> Json<Readiness<'static>> {
    Json(Readiness {
        status: "ready",
        schema: "v1",
    })
}

async fn health(State(authority): State<PairingAuthority>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&authority, &headers, RUNS_READ) {
        return *response;
    }
    Json(Readiness {
        status: "ready",
        schema: "v1",
    })
    .into_response()
}

async fn pair_web(State(authority): State<PairingAuthority>, request: Request) -> Response {
    pair_for_audience(authority, request, Audience::Web).await
}

async fn pair_cli(State(authority): State<PairingAuthority>, request: Request) -> Response {
    pair_for_audience(authority, request, Audience::Cli).await
}

async fn pair_for_audience(
    authority: PairingAuthority,
    request: Request,
    audience: Audience,
) -> Response {
    let payload = match parse_pair_payload(request).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    match authority.pair(&payload.code, audience) {
        Ok(token) => token_response(&token),
        Err(AuthError::AuthorityUnavailable | AuthError::EntropyUnavailable) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "pairing authority is unavailable",
        ),
        Err(error) => error_response_owned(StatusCode::UNAUTHORIZED, error.to_string()),
    }
}

async fn parse_pair_payload(request: Request) -> Result<PairPayload, Box<Response>> {
    let content_type = request
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .eq_ignore_ascii_case("application/json")
    {
        return Err(Box::new(error_response(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Content-Type must be application/json",
        )));
    }
    let bytes = to_bytes(request.into_body(), 2048).await.map_err(|_| {
        Box::new(error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "request body is too large",
        ))
    })?;
    let payload: PairPayload = serde_json::from_slice(&bytes).map_err(|_| {
        Box::new(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid request body",
        ))
    })?;
    if payload.code.is_empty() || payload.code.len() > 256 {
        return Err(Box::new(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid request body",
        )));
    }
    Ok(payload)
}

async fn rotate_token(State(authority): State<PairingAuthority>, headers: HeaderMap) -> Response {
    let current = match authorize(&authority, &headers, TOKENS_MANAGE) {
        Ok(token) => token,
        Err(response) => return *response,
    };
    match authority.rotate(current.value(), &[Audience::Web, Audience::Cli]) {
        Ok(token) => token_response(&token),
        Err(error) => auth_error_response(error),
    }
}

async fn revoke_token(State(authority): State<PairingAuthority>, headers: HeaderMap) -> Response {
    let current = match authorize(&authority, &headers, TOKENS_MANAGE) {
        Ok(token) => token,
        Err(response) => return *response,
    };
    match authority.revoke(current.value()) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => auth_error_response(error),
    }
}

async fn run_events(
    State(authority): State<PairingAuthority>,
    Path(_run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&authority, request.headers(), RUNS_READ) {
        return *response;
    }
    let after_sequence = match request.headers().get("last-event-id") {
        Some(value) => {
            let Ok(value) = value.to_str() else {
                return error_response(StatusCode::BAD_REQUEST, "Last-Event-ID must be an integer");
            };
            let Ok(value) = value.trim().parse::<i64>() else {
                return error_response(StatusCode::BAD_REQUEST, "Last-Event-ID must be an integer");
            };
            value
        }
        None => 0,
    };
    if after_sequence < 0 {
        return error_response(
            StatusCode::BAD_REQUEST,
            "Last-Event-ID must not be negative",
        );
    }
    let follow = match follow_requested(request.uri().query()) {
        Ok(follow) => follow,
        Err(()) => {
            return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid follow value");
        }
    };
    if follow {
        return error_response(StatusCode::NOT_FOUND, "run not found");
    }

    let mut response = Response::new(Body::empty());
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store"),
    );
    headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
    response
}

fn follow_requested(query: Option<&str>) -> Result<bool, ()> {
    let Some(value) = query.and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .filter(|(key, _)| key == "follow")
            .map(|(_, value)| value.into_owned())
            .last()
    }) else {
        return Ok(false);
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Ok(true),
        "false" | "0" | "off" | "no" => Ok(false),
        _ => Err(()),
    }
}

fn authorize(
    authority: &PairingAuthority,
    headers: &HeaderMap,
    required_scope: &str,
) -> Result<AccessToken, Box<Response>> {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let Some(value) = authorization.strip_prefix("Bearer ") else {
        return Err(Box::new(error_response(
            StatusCode::UNAUTHORIZED,
            "Bearer authorization is required",
        )));
    };
    if value.is_empty() {
        return Err(Box::new(error_response(
            StatusCode::UNAUTHORIZED,
            "Bearer authorization is required",
        )));
    }
    let token = authority
        .verify(value, &[Audience::Web, Audience::Cli], &[required_scope])
        .map_err(|error| Box::new(auth_error_response(error)))?;
    if headers.contains_key(header::ORIGIN) && token.audience() != Audience::Web {
        return Err(Box::new(error_response(
            StatusCode::FORBIDDEN,
            "browser requests require a Web audience token",
        )));
    }
    Ok(token)
}

fn auth_error_response(error: AuthError) -> Response {
    match error {
        AuthError::InvalidOrExpiredToken => {
            error_response_owned(StatusCode::UNAUTHORIZED, error.to_string())
        }
        AuthError::WrongAudience | AuthError::MissingScope | AuthError::ScopeEscalation => {
            error_response_owned(StatusCode::FORBIDDEN, error.to_string())
        }
        _ => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "pairing authority is unavailable",
        ),
    }
}

fn token_response(token: &AccessToken) -> Response {
    let expires_at = OffsetDateTime::from(token.expires_at());
    let Ok(expires_at) = expires_at.format(&Rfc3339) else {
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "token expiry could not be formatted",
        );
    };
    Json(TokenPayload {
        access_token: token.value(),
        token_type: "bearer",
        audience: token.audience().as_str(),
        scope: token
            .scopes()
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" "),
        expires_at,
    })
    .into_response()
}

async fn local_browser_boundary(request: Request, next: Next) -> Response {
    if query_contains_credentials(request.uri().query()) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "credentials are forbidden in query parameters",
        );
    }

    let origin = request.headers().get(header::ORIGIN).cloned();
    if let Some(value) = origin.as_ref() {
        let Ok(origin_text) = value.to_str() else {
            return error_response(StatusCode::FORBIDDEN, "cross-origin request denied");
        };
        if !is_loopback_browser_origin(origin_text) {
            return error_response(StatusCode::FORBIDDEN, "cross-origin request denied");
        }
        if request.uri().path().starts_with("/v1/cli/") {
            return error_response(StatusCode::FORBIDDEN, "CLI pairing rejects browser origins");
        }
    }

    if request.method() == Method::OPTIONS
        && let Some(origin) = origin.as_ref()
    {
        return preflight_response(request.uri().path(), request.headers(), origin);
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CONTENT_SECURITY_POLICY),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

fn query_contains_credentials(query: Option<&str>) -> bool {
    query.is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, _)| FORBIDDEN_QUERY_KEYS.contains(&key.as_ref()))
    })
}

fn is_loopback_browser_origin(origin: &str) -> bool {
    let Ok(parsed) = Url::parse(origin) else {
        return false;
    };
    let host_is_loopback = match parsed.host() {
        Some(Host::Domain(host)) => host == "localhost",
        Some(Host::Ipv4(host)) => host.is_loopback() && host.octets() == [127, 0, 0, 1],
        Some(Host::Ipv6(host)) => host.is_loopback(),
        None => false,
    };
    let authority = origin
        .as_bytes()
        .get(..7)
        .filter(|prefix| prefix.eq_ignore_ascii_case(b"http://"))
        .and_then(|_| origin.get(7..));
    let authority_only = authority.is_some_and(|value| !value.contains(['/', '?', '#']));
    let explicit_port = authority.is_some_and(|value| {
        value
            .rsplit_once(':')
            .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
    });
    parsed.scheme() == "http"
        && host_is_loopback
        && explicit_port
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && authority_only
}

fn preflight_response(path: &str, headers: &HeaderMap, origin: &HeaderValue) -> Response {
    let mut allowed_methods = BTreeSet::from(["GET", "POST"]);
    if path.starts_with("/v1/memory/") {
        allowed_methods.extend(["PATCH", "DELETE"]);
    }

    let requested_method = headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !allowed_methods.contains(requested_method) {
        return error_response(StatusCode::METHOD_NOT_ALLOWED, "CORS method is not allowed");
    }

    let allowed_headers = BTreeSet::from([
        "authorization",
        "content-type",
        "idempotency-key",
        "last-event-id",
    ]);
    let requested_headers = match headers.get(header::ACCESS_CONTROL_REQUEST_HEADERS) {
        Some(value) => match value.to_str() {
            Ok(value) => value,
            Err(_) => {
                return error_response(StatusCode::BAD_REQUEST, "CORS header is not allowed");
            }
        },
        None => "",
    }
    .split(',')
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_ascii_lowercase)
    .collect::<BTreeSet<_>>();
    if !requested_headers
        .iter()
        .all(|requested| allowed_headers.contains(requested.as_str()))
    {
        return error_response(StatusCode::BAD_REQUEST, "CORS header is not allowed");
    }

    let allow_methods = allowed_methods
        .into_iter()
        .chain(["OPTIONS"])
        .collect::<Vec<_>>()
        .join(", ");
    let mut response = StatusCode::NO_CONTENT.into_response();
    let response_headers = response.headers_mut();
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone());
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Idempotency-Key, Last-Event-ID"),
    );
    response_headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_str(&allow_methods).expect("static methods are a valid header"),
    );
    response_headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

fn error_response(status: StatusCode, detail: &'static str) -> Response {
    (status, Json(ErrorBody { detail })).into_response()
}

fn error_response_owned(status: StatusCode, detail: String) -> Response {
    #[derive(Serialize)]
    struct OwnedErrorBody {
        detail: String,
    }

    (status, Json(OwnedErrorBody { detail })).into_response()
}
