//! Embedded Dashboard asset delivery.

use super::*;

#[derive(RustEmbed)]
#[folder = "web/"]
struct DashboardAssets;

pub(crate) async fn dashboard_index() -> Response {
    embedded_asset("index.html", false)
}

pub(crate) async fn dashboard_asset(Path(path): Path<String>) -> Response {
    if path.is_empty()
        || path.contains(['\\', '\0'])
        || path.split('/').any(|component| component == "..")
    {
        return error_response(StatusCode::NOT_FOUND, "asset not found");
    }
    embedded_asset(&path, path.starts_with("assets/"))
}

fn embedded_asset(path: &str, immutable: bool) -> Response {
    let Some(asset) = DashboardAssets::get(path) else {
        return error_response(StatusCode::NOT_FOUND, "asset not found");
    };
    let content_type = match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    };
    let mut response = Response::new(Body::from(asset.data));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache, no-store"
        }),
    );
    response
}
