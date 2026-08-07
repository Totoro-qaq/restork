//! Recurring schedules and their bounded job execution.
//!
//! Split out of `lib.rs` per the consolidation spec.

use super::*;

pub(crate) async fn create_schedule(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ScheduleSpec>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let schedule = match validated_schedule(payload) {
        Ok(schedule) => schedule,
        Err(response) => return response,
    };
    let document = match serde_json::to_value(&schedule) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule"),
    };
    let next_run_at = schedule_next_run(&schedule);
    let updated_at = Utc::now().to_rfc3339();
    match storage.put_schedule(
        &schedule.schedule_id,
        &document,
        None,
        "active",
        next_run_at.as_deref(),
        &updated_at,
    ) {
        Ok(record) => (StatusCode::CREATED, Json(record)).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_schedules(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let query = request.uri().query();
    let limit = match bounded_usize_query(query, "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let cursor = match catalog_cursor(query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.schedules_page(cursor.as_ref(), limit) {
        Ok(page) => Json(page).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn get_schedule(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, SCHEDULES_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.schedule(&schedule_id) {
        Ok(Some(record)) => Json(record).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "schedule not found"),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn update_schedule(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ScheduleUpdate>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.schedule.schedule_id != schedule_id || payload.expected_revision < 1 {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule update");
    }
    let schedule = match validated_schedule(payload.schedule) {
        Ok(schedule) => schedule,
        Err(response) => return response,
    };
    let document = match serde_json::to_value(&schedule) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule"),
    };
    let next_run_at = schedule_next_run(&schedule);
    let updated_at = Utc::now().to_rfc3339();
    match storage.put_schedule(
        &schedule_id,
        &document,
        Some(payload.expected_revision),
        "active",
        next_run_at.as_deref(),
        &updated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn change_schedule_state(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ScheduleStateChange>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let stored = match storage.schedule(&schedule_id) {
        Ok(Some(record)) => record,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "schedule not found"),
        Err(error) => return storage_error_response(error),
    };
    let schedule = match serde_json::from_value::<ScheduleSpec>(stored.schedule.clone())
        .ok()
        .and_then(|schedule| validated_schedule(schedule).ok())
    {
        Some(schedule) => schedule,
        None => return storage_unavailable(),
    };
    let (next_state, next_run_at) = match payload.action.as_str() {
        "pause" => ("paused", None),
        "resume" => ("active", schedule_next_run(&schedule)),
        _ => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule action"),
    };
    let updated_at = Utc::now().to_rfc3339();
    match storage.put_schedule(
        &schedule_id,
        &stored.schedule,
        Some(payload.expected_revision),
        next_state,
        next_run_at.as_deref(),
        &updated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn run_schedule_now(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_MANAGE) {
        return *response;
    }
    let idempotency_key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let stored = match storage.schedule(&schedule_id) {
        Ok(Some(record)) => record,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "schedule not found"),
        Err(error) => return storage_error_response(error),
    };
    let schedule = match serde_json::from_value::<ScheduleSpec>(stored.schedule)
        .ok()
        .and_then(|schedule| validated_schedule(schedule).ok())
    {
        Some(schedule) => schedule,
        None => return storage_unavailable(),
    };
    if matches!(&schedule.job, ScheduleJob::Deterministic { job } if job == "daily.refresh")
        && let Err(error) = storage.clear_daily_cache("weather-current")
    {
        return storage_error_response(error);
    }
    let result = schedule_result(&schedule, true);
    let created_at = Utc::now().to_rfc3339();
    match storage.record_schedule_run(
        &schedule_id,
        &format!("manual:{idempotency_key}"),
        None,
        &result,
        &created_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn delete_schedule(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let expected = match required_i64_query(request.uri().query(), "expected_revision", 1) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.delete_schedule(&schedule_id, expected) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) fn required_i64_query(
    query: Option<&str>,
    key: &str,
    minimum: i64,
) -> Result<i64, Response> {
    let Some(value) = single_query_value(query, key).map_err(|()| invalid_query())? else {
        return Err(invalid_query());
    };
    value
        .parse::<i64>()
        .ok()
        .filter(|value| *value >= minimum)
        .ok_or_else(invalid_query)
}
pub(crate) fn catalog_cursor(query: Option<&str>) -> Result<Option<CatalogCursor>, Response> {
    let updated_at = single_query_value(query, "after_time").map_err(|()| invalid_query())?;
    let id = single_query_value(query, "after_id").map_err(|()| invalid_query())?;
    let version = single_query_value(query, "after_version").map_err(|()| invalid_query())?;
    match (updated_at, id, version) {
        (None, None, None) => Ok(None),
        (Some(updated_at), Some(id), Some(version)) => {
            let version = version
                .parse::<i64>()
                .ok()
                .filter(|value| *value >= 1)
                .ok_or_else(invalid_query)?;
            Ok(Some(CatalogCursor {
                updated_at,
                id,
                version,
            }))
        }
        _ => Err(invalid_query()),
    }
}
pub(crate) fn validated_schedule(schedule: ScheduleSpec) -> Result<ScheduleSpec, Response> {
    let schedule = ScheduleSpec::new(
        schedule.schedule_id,
        schedule.timezone,
        schedule.recurrence,
        schedule.missed_run_policy,
        schedule.job,
    )
    .map_err(|_| error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule"))?;
    if let ScheduleJob::Deterministic { job } = &schedule.job
        && !matches!(job.as_str(), "health.check" | "daily.refresh")
    {
        return Err(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "deterministic schedule job is not supported",
        ));
    }
    Ok(schedule)
}
pub(crate) fn schedule_result(schedule: &ScheduleSpec, manual: bool) -> serde_json::Value {
    match &schedule.job {
        ScheduleJob::Deterministic { job } => serde_json::json!({
            "state": "completed",
            "job": job,
            "mode": "no_model",
            "manual": manual,
            "cache_invalidated": job == "daily.refresh",
            "external_effect": false,
        }),
    }
}
pub(crate) fn schedule_next_run(schedule: &ScheduleSpec) -> Option<String> {
    let now = Utc::now();
    schedule
        .due_between(now, now + ChronoDuration::days(370))
        .ok()
        .and_then(|items| items.into_iter().next())
        .map(|occurrence| occurrence.scheduled_at.to_rfc3339())
}
