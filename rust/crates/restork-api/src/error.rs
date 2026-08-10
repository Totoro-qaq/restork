//! Stable JSON errors for the loopback HTTP boundary.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Serialize)]
struct ErrorBody<'a> {
    detail: &'a str,
}

pub(super) fn error_response(status: StatusCode, detail: &'static str) -> Response {
    (status, Json(ErrorBody { detail })).into_response()
}

pub(super) fn error_response_owned(status: StatusCode, detail: String) -> Response {
    #[derive(Serialize)]
    struct OwnedErrorBody {
        detail: String,
    }

    (status, Json(OwnedErrorBody { detail })).into_response()
}
