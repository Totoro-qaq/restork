//! Provider registry and profiles, prompt revisions, configuration profiles,
//! and personal settings.
//!
//! Split out of `lib.rs` per the consolidation spec.

use super::*;

pub(crate) async fn get_personal_settings(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, SETTINGS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.personal_settings() {
        Ok(Some(settings)) => Json(settings).into_response(),
        Ok(None) => Json(serde_json::json!({
            "settings": {},
            "version": 0,
            "updated_at": null
        }))
        .into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn put_personal_settings(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SETTINGS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<PersonalSettingsUpdate>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let document = match serde_json::to_value(payload.settings) {
        Ok(document) => document,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid settings"),
    };
    let updated_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.put_personal_settings(&document, payload.expected_version, &updated_at) {
        Ok(settings) => Json(settings).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn delete_personal_settings(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SETTINGS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let expected = match required_i64_query(request.uri().query(), "expected_version", 0) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.clear_personal_settings(Some(expected)) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_provider_profiles(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROVIDERS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match provider_profile_records(&storage) {
        Ok(items) => Json(SearchResults { items }).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_provider_registry(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROVIDERS_READ) {
        return *response;
    }
    Json(ProviderRegistryResponse {
        registry_version: PROVIDER_REGISTRY_VERSION,
        items: provider_definitions(),
    })
    .into_response()
}
pub(crate) async fn list_provider_models(
    State(state): State<ApiState>,
    Path(provider_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROVIDERS_READ) {
        return *response;
    }
    let profile = match configured_provider(&state, &provider_id) {
        Ok(Some(value)) => value,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "provider is not configured"),
        Err(response) => return response,
    };
    let Some(provider) = state.provider else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable",
        );
    };
    match provider.models(&profile).await {
        Ok(catalog) => Json(catalog).into_response(),
        Err(error) => error_response_owned(
            StatusCode::BAD_GATEWAY,
            format!("provider model discovery failed: {}", error.status()),
        ),
    }
}
pub(crate) async fn get_provider_status(
    State(state): State<ApiState>,
    Path(provider_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROVIDERS_READ) {
        return *response;
    }
    match provider_status_document(&state, &provider_id).await {
        Ok(diagnostic) => Json(diagnostic).into_response(),
        Err(response) => response,
    }
}
pub(crate) async fn run_provider_diagnostic(
    State(state): State<ApiState>,
    Path(provider_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), PROVIDERS_READ) {
        return *response;
    }
    let payload = match parse_json::<ProviderDiagnosticRequest>(request, 4 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let profile = match configured_provider(&state, &provider_id) {
        Ok(Some(value)) => value,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "provider is not configured"),
        Err(response) => return response,
    };
    let Some(provider) = state.provider else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable",
        );
    };
    match payload.target.as_str() {
        "primary" => Json(provider.diagnose(&profile, payload.smoke).await).into_response(),
        "web_search" if payload.smoke => {
            Json(provider.diagnose_web_search(&profile).await).into_response()
        }
        "web_search" => error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "the V4 Flash capability check must be an explicit smoke test",
        ),
        _ => error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "provider diagnostic target is invalid",
        ),
    }
}
pub(crate) async fn put_provider_profile(
    State(state): State<ApiState>,
    Path(provider_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), PROVIDERS_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ProviderProfileUpdate>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.provider.profile_id() != provider_id
        || i64::try_from(payload.provider.version()).ok()
            != Some(payload.expected_revision.unwrap_or_default() + 1)
    {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "provider identity or version is invalid",
        );
    }
    let document = match serde_json::to_value(&payload.provider) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid provider"),
    };
    let updated_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.put_provider_profile(
        &provider_id,
        &document,
        payload.expected_revision,
        &updated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_configuration_profiles(
    State(state): State<ApiState>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROFILES_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.configuration_profiles() {
        Ok(items) => Json(SearchResults { items }).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn put_configuration_profile(
    State(state): State<ApiState>,
    Path(profile_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), PROFILES_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ConfigurationProfileUpdate>(request, 128 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.profile.profile_id() != profile_id
        || i64::try_from(payload.profile.version()).ok()
            != Some(payload.expected_revision.unwrap_or_default() + 1)
    {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "configuration profile identity or version is invalid",
        );
    }
    let document = match serde_json::to_value(&payload.profile) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid configuration profile",
            );
        }
    };
    let updated_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.put_configuration_profile(
        &profile_id,
        &document,
        payload.expected_revision,
        false,
        &updated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn list_prompt_revisions(
    State(state): State<ApiState>,
    Path(prompt_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, PROMPTS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.prompt_revisions(&prompt_id) {
        Ok(items) => Json(SearchResults { items }).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn create_prompt_revision(
    State(state): State<ApiState>,
    Path(prompt_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), PROMPTS_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<PromptRevisionCreate>(request, 96 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if matches!(payload.layer, PromptLayer::Policy | PromptLayer::RunContext) {
        return error_response(
            StatusCode::FORBIDDEN,
            "this prompt layer is managed by the Core",
        );
    }
    let history = match storage.prompt_revisions(&prompt_id) {
        Ok(history) => history,
        Err(error) => return storage_error_response(error),
    };
    let current_revision = history
        .first()
        .and_then(|record| record.prompt.get("revision"))
        .and_then(serde_json::Value::as_i64);
    let parent_hash = history.first().map(|record| record.content_hash.as_str());
    let next_revision = current_revision.unwrap_or_default() + 1;
    let Ok(next_revision_u64) = u64::try_from(next_revision) else {
        return error_response(StatusCode::CONFLICT, "prompt revision is exhausted");
    };
    let created_at = OffsetDateTime::now_utc();
    let revision = match PromptRevision::try_new(
        &prompt_id,
        next_revision_u64,
        payload.layer,
        &payload.content,
        parent_hash,
        created_at,
    ) {
        Ok(revision) => revision,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid prompt"),
    };
    let document = match serde_json::to_value(&revision) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid prompt"),
    };
    let created_at = match created_at.format(&Rfc3339) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "system time is unavailable",
            );
        }
    };
    match storage.append_prompt_revision(
        &prompt_id,
        next_revision,
        &document,
        revision.content_hash(),
        payload.expected_revision,
        &created_at,
    ) {
        Ok(record) => (StatusCode::CREATED, Json(record)).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn activate_prompt_revision(
    State(state): State<ApiState>,
    Path(prompt_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), PROMPTS_MANAGE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<PromptActivation>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let activated_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.activate_prompt(
        &prompt_id,
        payload.revision,
        payload.expected_active_revision,
        &activated_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}
