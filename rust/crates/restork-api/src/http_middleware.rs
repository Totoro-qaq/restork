//! Browser-origin, CORS, and response-hardening middleware.

use std::collections::BTreeSet;

use axum::{
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use url::{Host, Url};

use super::error_response;

const CONTENT_SECURITY_POLICY: &str = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const FORBIDDEN_QUERY_KEYS: [&str; 3] = ["access_token", "authorization", "token"];

pub(super) async fn local_browser_boundary(request: Request, next: Next) -> Response {
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
    if path.starts_with("/v1/memory/")
        || path.starts_with("/v1/sessions/")
        || path.starts_with("/v1/extensions/")
        || path.starts_with("/v1/schedules/")
        || path.starts_with("/v1/prompts/")
    {
        allowed_methods.extend(["PATCH", "DELETE"]);
    }
    if path == "/v1/settings/personal"
        || path.starts_with("/v1/provider-profiles/")
        || path.starts_with("/v1/configuration-profiles/")
    {
        allowed_methods.extend(["PUT", "DELETE"]);
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
    let allow_methods = match HeaderValue::from_str(&allow_methods) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "CORS method policy is unavailable",
            );
        }
    };
    response_headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, allow_methods);
    response_headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    response
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_browser_origin, query_contains_credentials};

    #[test]
    fn only_explicit_loopback_http_origins_are_accepted() {
        assert!(is_loopback_browser_origin("http://127.0.0.1:7337"));
        assert!(is_loopback_browser_origin("http://localhost:7337"));
        assert!(!is_loopback_browser_origin("https://127.0.0.1:7337"));
        assert!(!is_loopback_browser_origin("http://127.0.0.1"));
        assert!(!is_loopback_browser_origin("http://127.0.0.2:7337"));
        assert!(!is_loopback_browser_origin("http://localhost:7337/path"));
    }

    #[test]
    fn credential_query_keys_are_rejected_case_sensitively() {
        assert!(query_contains_credentials(Some("access_token=secret")));
        assert!(query_contains_credentials(Some("authorization=secret")));
        assert!(query_contains_credentials(Some("token=secret")));
        assert!(!query_contains_credentials(Some("cursor=opaque")));
        assert!(!query_contains_credentials(None));
    }
}
