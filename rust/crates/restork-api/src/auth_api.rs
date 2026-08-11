//! Pairing, access-token rotation, and loopback browser-session recovery.
//!
//! The browser recovery credential is confined to the token endpoints. Normal
//! API routes continue to require an explicit bearer token.

use super::*;

// Access tokens remain five-minute capabilities. Only the rotation and browser
// recovery endpoints accept an otherwise-expired token inside this window.
const TOKEN_ROTATION_GRACE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const BROWSER_RESUME_COOKIE: &str = "restork_loopback_session";
const BROWSER_RESUME_MAX_AGE_SECONDS: u64 = TOKEN_ROTATION_GRACE.as_secs();

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

pub(super) async fn pair_web(State(state): State<ApiState>, request: Request) -> Response {
    pair_for_audience(state.authority, request, Audience::Web).await
}

pub(super) async fn pair_cli(State(state): State<ApiState>, request: Request) -> Response {
    pair_for_audience(state.authority, request, Audience::Cli).await
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
        Ok(token) if audience == Audience::Web => web_token_response(&token),
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

pub(super) async fn rotate_token(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let value = match bearer_value(&headers) {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let web_request = headers.contains_key(header::ORIGIN);
    let audiences = if web_request {
        &[Audience::Web][..]
    } else {
        &[Audience::Web, Audience::Cli][..]
    };
    match state
        .authority
        .rotate_with_grace(value, audiences, TOKEN_ROTATION_GRACE)
    {
        Ok(token) if web_request => web_token_response(&token),
        Ok(token) => token_response(&token),
        Err(error) => auth_error_response(error),
    }
}

pub(super) async fn resume_web_token(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    if !headers.contains_key(header::ORIGIN) {
        return error_response(
            StatusCode::FORBIDDEN,
            "browser session recovery requires an origin",
        );
    }
    let value = match browser_resume_cookie(&headers) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match state
        .authority
        .rotate_with_grace(value, &[Audience::Web], TOKEN_ROTATION_GRACE)
    {
        Ok(token) => web_token_response(&token),
        Err(error) => auth_error_response(error),
    }
}

pub(super) async fn revoke_token(State(state): State<ApiState>, headers: HeaderMap) -> Response {
    let current = match authorize(&state.authority, &headers, TOKENS_MANAGE) {
        Ok(token) => token,
        Err(response) => return *response,
    };
    match state.authority.revoke(current.value()) {
        Ok(()) => {
            let mut response = StatusCode::NO_CONTENT.into_response();
            if headers.contains_key(header::ORIGIN) {
                response
                    .headers_mut()
                    .insert(header::SET_COOKIE, clear_browser_resume_cookie());
            }
            response
        }
        Err(error) => auth_error_response(error),
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

fn web_token_response(token: &AccessToken) -> Response {
    let mut response = token_response(token);
    if response.status().is_success() {
        let cookie = format!(
            "{BROWSER_RESUME_COOKIE}={}; Path=/v1/token; HttpOnly; SameSite=Strict; Max-Age={BROWSER_RESUME_MAX_AGE_SECONDS}",
            token.value(),
        );
        let Ok(cookie) = HeaderValue::from_str(&cookie) else {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "browser session could not be protected",
            );
        };
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    response
}

fn clear_browser_resume_cookie() -> HeaderValue {
    HeaderValue::from_static(
        "restork_loopback_session=; Path=/v1/token; HttpOnly; SameSite=Strict; Max-Age=0",
    )
}

fn browser_resume_cookie(headers: &HeaderMap) -> Result<&str, Response> {
    let mut found = None;
    for header_value in headers.get_all(header::COOKIE) {
        let Ok(header_value) = header_value.to_str() else {
            return Err(error_response(
                StatusCode::UNAUTHORIZED,
                "local session is unavailable",
            ));
        };
        for pair in header_value.split(';').map(str::trim) {
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            if name != BROWSER_RESUME_COOKIE {
                continue;
            }
            if found.is_some()
                || !(32..=512).contains(&value.len())
                || value.chars().any(char::is_whitespace)
            {
                return Err(error_response(
                    StatusCode::UNAUTHORIZED,
                    "local session is unavailable",
                ));
            }
            found = Some(value);
        }
    }
    found.ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "local session is unavailable"))
}
