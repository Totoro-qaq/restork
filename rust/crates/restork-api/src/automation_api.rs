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
    let cursor = match opaque_cursor::<CatalogCursor>(query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.schedules_page(cursor.as_ref(), limit) {
        Ok(page) => schedule_page_response(page, limit),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_deleted_schedules(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
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
    let cursor = match opaque_cursor::<CatalogCursor>(query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.deleted_schedules_page(cursor.as_ref(), limit) {
        Ok(page) => schedule_page_response(page, limit),
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
        Ok(Some(record)) if record.deleted_at.is_none() => Json(record).into_response(),
        Ok(Some(_)) => error_response(StatusCode::NOT_FOUND, "schedule not found"),
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
    let stored = match storage.schedule(&schedule_id) {
        Ok(Some(record)) if record.deleted_at.is_none() => record,
        Ok(Some(_)) | Ok(None) => {
            return error_response(StatusCode::NOT_FOUND, "schedule not found");
        }
        Err(error) => return storage_error_response(error),
    };
    let schedule = match validated_schedule(payload.schedule) {
        Ok(schedule) => schedule,
        Err(response) => return response,
    };
    let document = match serde_json::to_value(&schedule) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule"),
    };
    let next_run_at = (stored.state == "active")
        .then(|| schedule_next_run(&schedule))
        .flatten();
    let updated_at = Utc::now().to_rfc3339();
    match storage.put_schedule(
        &schedule_id,
        &document,
        Some(payload.expected_revision),
        &stored.state,
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
        Ok(Some(record)) if record.deleted_at.is_none() => record,
        Ok(Some(_)) => return error_response(StatusCode::NOT_FOUND, "schedule not found"),
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
        Ok(Some(record)) if record.deleted_at.is_none() => record,
        Ok(Some(_)) => return error_response(StatusCode::NOT_FOUND, "schedule not found"),
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
    let period_key = format!("manual:{idempotency_key}");
    let now = Utc::now();
    if schedule.job.uses_model() {
        let claim = serde_json::json!({
            "state": "running",
            "claim_token": format!(
                "claim:{}",
                sha256_hex(format!("{schedule_id}\0{period_key}\0{}", now.timestamp_nanos_opt().unwrap_or_default()).as_bytes())
            ),
            "provider_call": false,
            "network_effect": false,
            "manual": true,
        });
        let claimed = match storage.claim_schedule_run(
            &schedule_id,
            &period_key,
            &claim,
            &now.to_rfc3339(),
        ) {
            Ok(record) => record,
            Err(error) => return storage_error_response(error),
        };
        if claimed.replayed {
            return Json(claimed).into_response();
        }
        let result = match &schedule.job {
            ScheduleJob::ModelDraft { .. } => {
                execute_scheduled_model_draft(&storage, &schedule, &period_key, true).await
            }
            ScheduleJob::XCocreationDraft {
                provider_profile_id,
                language,
                ..
            } => {
                execute_scheduled_x_cocreation_draft(&storage, provider_profile_id, language).await
            }
            _ => unreachable!("model jobs are claimed above"),
        };
        return match storage.complete_schedule_run(&schedule_id, &period_key, &claim, &result) {
            Ok(record) => Json(record).into_response(),
            Err(error) => storage_error_response(error),
        };
    }
    match storage.schedule_run(&schedule_id, &period_key) {
        Ok(Some(record)) => return Json(record).into_response(),
        Ok(None) => {}
        Err(error) => return storage_error_response(error),
    }
    let result = match &schedule.job {
        ScheduleJob::Deterministic { job } => {
            if job == "daily.refresh"
                && let Err(error) = storage.clear_daily_cache("weather-current")
            {
                return storage_error_response(error);
            }
            schedule_result(&schedule, true)
        }
        ScheduleJob::XRadarRefresh { topics, .. } => {
            execute_scheduled_x_radar(&storage, topics).await
        }
        ScheduleJob::ModelDraft { .. } | ScheduleJob::XCocreationDraft { .. } => {
            unreachable!("model jobs are claimed above")
        }
    };
    let created_at = now.to_rfc3339();
    match storage.record_schedule_run(&schedule_id, &period_key, None, &result, &created_at) {
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
    let deleted_at = Utc::now().to_rfc3339();
    match storage.soft_delete_schedule(&schedule_id, expected, &deleted_at) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(crate) async fn restore_schedule(
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
    let payload = match parse_json::<ScheduleRestore>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.expected_revision < 1 {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule restore");
    }
    let stored = match storage.schedule(&schedule_id) {
        Ok(Some(record)) if record.deleted_at.is_some() => record,
        Ok(Some(_)) | Ok(None) => {
            return error_response(StatusCode::NOT_FOUND, "deleted schedule not found");
        }
        Err(error) => return storage_error_response(error),
    };
    let schedule = match serde_json::from_value::<ScheduleSpec>(stored.schedule.clone())
        .ok()
        .and_then(|schedule| validated_schedule(schedule).ok())
    {
        Some(schedule) => schedule,
        None => return storage_unavailable(),
    };
    // Restoring never catches up missed periods. Active schedules receive the
    // first occurrence strictly after the restore instant; paused ones stay paused.
    let next_run_at = (stored.state == "active")
        .then(|| schedule_next_run(&schedule))
        .flatten();
    let updated_at = Utc::now().to_rfc3339();
    match storage.restore_schedule(
        &schedule_id,
        payload.expected_revision,
        next_run_at.as_deref(),
        &updated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(crate) async fn list_schedule_runs(
    State(state): State<ApiState>,
    Path(schedule_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SCHEDULES_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.schedule(&schedule_id) {
        Ok(Some(_)) => {}
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "schedule not found"),
        Err(error) => return storage_error_response(error),
    }
    let query = request.uri().query();
    let limit = match bounded_usize_query(query, "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let cursor = match opaque_cursor::<ScheduleRunCursor>(query) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.schedule_runs_page(&schedule_id, cursor.as_ref(), limit) {
        Ok(page) => {
            let next_cursor = match encoded_cursor(page.next.as_ref()) {
                Ok(value) => value,
                Err(response) => return response,
            };
            Json(serde_json::json!({
                "items": page.items,
                "page": {
                    "limit": limit,
                    "has_more": next_cursor.is_some(),
                    "next_cursor": next_cursor,
                }
            }))
            .into_response()
        }
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
    let schedule_id = if schedule.schedule_id.trim().is_empty() {
        random_id("schedule")?
    } else {
        schedule.schedule_id.trim().to_owned()
    };
    let name = schedule
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| match &schedule.job {
            ScheduleJob::Deterministic { job } if job == "daily.refresh" => {
                "Daily context refresh".to_owned()
            }
            ScheduleJob::Deterministic { .. } => "Local health check".to_owned(),
            ScheduleJob::ModelDraft { report_kind, .. } => match report_kind {
                ScheduledReportKind::DailyReport => "Daily report draft".to_owned(),
                ScheduledReportKind::WeeklyReport => "Weekly report draft".to_owned(),
            },
            ScheduleJob::XRadarRefresh { .. } => "X Radar refresh".to_owned(),
            ScheduleJob::XCocreationDraft { .. } => "X weekly drafts".to_owned(),
        });
    if name.len() > 300 {
        return Err(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid schedule name",
        ));
    }
    let mut schedule = ScheduleSpec::new(
        schedule_id,
        schedule.timezone,
        schedule.recurrence,
        schedule.missed_run_policy,
        schedule.job,
    )
    .map_err(|_| error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid schedule"))?;
    schedule.name = Some(name);
    match &schedule.job {
        ScheduleJob::Deterministic { job }
            if !matches!(job.as_str(), "health.check" | "daily.refresh") =>
        {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "deterministic schedule job is not supported",
            ));
        }
        ScheduleJob::ModelDraft { .. } | ScheduleJob::XCocreationDraft { .. }
            if schedule.missed_run_policy != MissedRunPolicy::CreateDraft =>
        {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "model schedules must create reviewable drafts",
            ));
        }
        ScheduleJob::XRadarRefresh { .. }
            if schedule.missed_run_policy != MissedRunPolicy::Skip =>
        {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "X Radar schedules skip missed runs",
            ));
        }
        _ => {}
    }
    Ok(schedule)
}

fn opaque_cursor<T>(query: Option<&str>) -> Result<Option<T>, Response>
where
    T: DeserializeOwned,
{
    match single_query_value(query, "cursor") {
        Ok(None) => Ok(None),
        Ok(Some(value)) if value.is_empty() => Ok(None),
        Ok(Some(value)) if value.len() <= 2_048 => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| invalid_query()),
        Ok(Some(_)) => Err(invalid_query()),
        Err(()) => Err(invalid_query()),
    }
}

fn encoded_cursor<T>(cursor: Option<&T>) -> Result<Option<String>, Response>
where
    T: Serialize,
{
    cursor
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| storage_unavailable())
}

fn schedule_page_response(page: restork_storage::SchedulePage, limit: usize) -> Response {
    let next_cursor = match encoded_cursor(page.next.as_ref()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "items": page.items,
        "page": {
            "limit": limit,
            "has_more": next_cursor.is_some(),
            "next_cursor": next_cursor,
        }
    }))
    .into_response()
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
        ScheduleJob::ModelDraft { .. } => serde_json::json!({
            "state": "rejected",
            "reason": "model draft execution was not initialized",
            "manual": manual,
            "external_effect": false,
        }),
        ScheduleJob::XRadarRefresh { .. } => serde_json::json!({
            "state": "rejected",
            "reason": "X Radar execution was not initialized",
            "manual": manual,
            "x_write": false,
        }),
        ScheduleJob::XCocreationDraft { .. } => serde_json::json!({
            "state": "rejected",
            "reason": "X draft execution was not initialized",
            "manual": manual,
            "x_write": false,
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
