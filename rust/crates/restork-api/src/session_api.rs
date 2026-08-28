//! Conversation sessions, their bounded operations, and workspace search.
//!
//! Split out of `lib.rs` per the consolidation spec. Shared state, guards, and
//! response helpers stay in the crate root.

use super::*;

pub(crate) async fn create_session(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<SessionCreate>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let session_id = match random_id("session") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = OffsetDateTime::now_utc();
    if ConversationSession::try_new(&session_id, &payload.title, &payload.profile_id, now).is_err()
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid session");
    }
    let occurred_at = match now.format(&Rfc3339) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "system time is unavailable",
            );
        }
    };
    match storage.create_session(NewSession {
        session_id: &session_id,
        title: &payload.title,
        profile_id: &payload.profile_id,
        locale: payload.locale.as_deref(),
        occurred_at: &occurred_at,
    }) {
        Ok(session) => (StatusCode::CREATED, Json(session)).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn fork_session(
    State(state): State<ApiState>,
    Path(source_session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage.as_ref().cloned() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<SessionForkCreate>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if !(1..=24).contains(&payload.copy_limit) {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "session fork copy limit must be between 1 and 24",
        );
    }
    let source = match storage.session(&source_session_id) {
        Ok(Some(session)) if session.status == "active" => session,
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "session is archived"),
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    };
    if source.updated_at != payload.expected_updated_at {
        return error_response(
            StatusCode::CONFLICT,
            "source conversation changed; review it before switching models",
        );
    }
    if source.profile_id == payload.profile_id {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "select a different profile for the conversation branch",
        );
    }
    if let Err(response) = provider_for_session(&state, &payload.profile_id, DataClass::Public) {
        return response;
    }

    let recent = match storage.recent_session_messages(&source_session_id, payload.copy_limit) {
        Ok(messages) => messages,
        Err(error) => return storage_error_response(error),
    };
    let source_last_sequence = recent.last().map_or(0, |message| message.sequence);
    let mut copied_bytes = 0_usize;
    let mut selected = Vec::new();
    for message in recent.into_iter().rev() {
        if copied_bytes.saturating_add(message.content.len()) > 120_000 {
            break;
        }
        copied_bytes += message.content.len();
        selected.push(message);
    }
    selected.reverse();
    for message in &selected {
        let data_class = match serde_json::from_value::<DataClass>(serde_json::Value::String(
            message.data_class.clone(),
        )) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "source conversation contains an invalid data class",
                );
            }
        };
        if let Err(response) = provider_for_session(&state, &payload.profile_id, data_class) {
            return response;
        }
    }

    let session_id = match random_id("session") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = OffsetDateTime::now_utc();
    if ConversationSession::try_new(&session_id, &payload.title, &payload.profile_id, now).is_err()
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid session fork");
    }
    let occurred_at = match now.format(&Rfc3339) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "system time is unavailable",
            );
        }
    };
    let mut seeds = Vec::with_capacity(selected.len());
    for message in &selected {
        let message_id = match random_id("message") {
            Ok(value) => value,
            Err(response) => return response,
        };
        seeds.push(SessionForkMessage {
            message_id,
            source_message_id: message.message_id.clone(),
        });
    }
    let fork = match storage.fork_session(NewSessionFork {
        source_session_id: &source_session_id,
        expected_source_updated_at: &payload.expected_updated_at,
        expected_source_last_sequence: source_last_sequence,
        session: NewSession {
            session_id: &session_id,
            title: &payload.title,
            profile_id: &payload.profile_id,
            locale: source.locale.as_deref(),
            occurred_at: &occurred_at,
        },
        messages: &seeds,
    }) {
        Ok(fork) => fork,
        Err(error) => return storage_error_response(error),
    };
    let copied_messages = fork.messages.len();
    let omitted_messages = usize::try_from(source_last_sequence)
        .unwrap_or_default()
        .saturating_sub(copied_messages);
    (
        StatusCode::CREATED,
        Json(SessionForkResult {
            session: fork.session,
            source_session_id,
            copied_messages,
            omitted_messages,
            copied_bytes,
            profile_id: payload.profile_id,
        }),
    )
        .into_response()
}
pub(crate) async fn list_sessions(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let query = request.uri().query();
    let limit = match bounded_usize_query(query, "limit", 20, 100) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let after_time = match single_query_value(query, "after_time") {
        Ok(value) => value,
        Err(()) => return invalid_query(),
    };
    let after_id = match single_query_value(query, "after_id") {
        Ok(value) => value,
        Err(()) => return invalid_query(),
    };
    let cursor = match (after_time, after_id) {
        (None, None) => None,
        (Some(updated_at), Some(session_id)) => Some(SessionCursor {
            updated_at,
            session_id,
        }),
        _ => return invalid_query(),
    };
    let include_archived = match boolean_query(query, "include_archived", false) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.sessions_page(cursor.as_ref(), limit, include_archived) {
        Ok(page) => Json(page).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn get_session(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, SESSIONS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.session(&session_id) {
        Ok(Some(session)) => Json(session).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn archive_session(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ArchiveSession>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.action != "archive" {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid session action");
    }
    let updated_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.archive_session(&session_id, payload.expected_version, &updated_at) {
        Ok(session) => Json(session).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn delete_session(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_DELETE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let expected = match required_i64_query(request.uri().query(), "expected_version", 1) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.delete_session(&session_id, expected) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn create_session_message(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage.as_ref().cloned() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<SessionMessageCreate>(request, 1_100_000).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let data_class = match serde_json::from_value::<DataClass>(serde_json::Value::String(
        payload.data_class.clone(),
    )) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid message data class",
            );
        }
    };
    let session = match storage.session(&session_id) {
        Ok(Some(session)) if session.status == "active" => session,
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "session is archived"),
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    };
    let provider_profile = match provider_for_session(&state, &session.profile_id, data_class) {
        Ok(value) => value,
        Err(response) => return response,
    };
    if provider_profile.is_some() && payload.content.len() > 64_000 {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "model-backed messages are limited to 64000 bytes",
        );
    }
    let message_id = match random_id("message") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let occurred_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let user_message = match storage.append_session_message(NewSessionMessage {
        message_id: &message_id,
        session_id: &session_id,
        role: "user",
        content: &payload.content,
        context: &payload.context,
        data_class: data_class_name(data_class),
        occurred_at: &occurred_at,
    }) {
        Ok(message) => message,
        Err(error) => return storage_error_response(error),
    };
    let Some(provider_profile) = provider_profile else {
        return (StatusCode::CREATED, Json(user_message)).into_response();
    };
    let Some(provider) = state.provider.as_ref().cloned() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable; the local message was saved",
        );
    };
    let messages =
        match conversation_chat_messages(&storage, &session_id, &session.profile_id, None) {
            Ok(messages) => messages,
            Err(error) => return storage_error_response(error),
        };
    let completion = match provider.chat(&provider_profile, &messages, 1_024).await {
        Ok(completion) => completion,
        Err(_) => {
            return error_response(
                StatusCode::BAD_GATEWAY,
                "provider response failed safely; the local message was saved",
            );
        }
    };
    let assistant_id = match random_id("message") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let completed_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let context = serde_json::json!({
        "provider_profile_id": provider_profile.profile_id(),
        "provider_version": provider_profile.version(),
        "latency_ms": completion.latency_ms,
        "request_id": completion.request_id,
        "prompt_tokens": completion.prompt_tokens,
        "completion_tokens": completion.completion_tokens,
        "total_tokens": completion.total_tokens,
        "cost_usd_micros": completion.cost_usd_micros,
        "tool_access": false,
    });
    match storage.append_session_message(NewSessionMessage {
        message_id: &assistant_id,
        session_id: &session_id,
        role: "assistant",
        content: &completion.content,
        context: &context,
        data_class: data_class_name(data_class),
        occurred_at: &completed_at,
    }) {
        Ok(message) => (StatusCode::CREATED, Json(message)).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn create_context_preview(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ContextPreviewCreate>(request, 600_000).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let data_class =
        match serde_json::from_value::<DataClass>(serde_json::Value::String(payload.data_class)) {
            Ok(value) => value,
            Err(_) => {
                return error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "invalid context data class",
                );
            }
        };
    match storage.session(&session_id) {
        Ok(Some(session)) if session.status == "active" => {}
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "session is archived"),
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    }
    if payload.items.is_empty() || payload.items.len() > 16 {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "context preview requires between 1 and 16 files",
        );
    }
    let mut total_bytes = 0_usize;
    let mut entries = Vec::with_capacity(payload.items.len());
    for item in payload.items {
        let name = item.name.trim();
        if name.is_empty()
            || name.len() > 240
            || name
                .chars()
                .any(|character| matches!(character, '/' | '\\' | '\0') || character.is_control())
        {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "context file name is invalid",
            );
        }
        if item.content.is_empty() || item.content.len() > 128_000 || item.content.contains('\0') {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "context files must be bounded UTF-8 text",
            );
        }
        total_bytes = match total_bytes.checked_add(item.content.len()) {
            Some(value) if value <= 256_000 => value,
            _ => {
                return error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "context preview exceeds 256000 bytes",
                );
            }
        };
        entries.push(serde_json::json!({
            "name": name,
            "content_hash": bytes_digest(item.content.as_bytes()),
            "byte_count": item.content.len(),
            "content": item.content,
        }));
    }
    let manifest = serde_json::json!({
        "schema_version": 1,
        "boundary": "explicit_browser_file_selection",
        "untrusted": true,
        "entries": entries,
    });
    let manifest_bytes = match serde_json::to_vec(&manifest) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    let content_hash = bytes_digest(&manifest_bytes);
    let preview_id = match random_id("context") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let created = Utc::now();
    let created_at = created.to_rfc3339();
    let expires_at = (created + ChronoDuration::minutes(15)).to_rfc3339();
    let byte_count = total_bytes as i64;
    let estimated_tokens = total_bytes.div_ceil(4) as i64;
    match storage.save_context_preview(NewContextPreview {
        preview_id: &preview_id,
        session_id: &session_id,
        content_hash: &content_hash,
        manifest: &manifest,
        data_class: data_class_name(data_class),
        byte_count,
        estimated_tokens,
        created_at: &created_at,
        expires_at: &expires_at,
    }) {
        Ok(preview) => (StatusCode::CREATED, Json(preview)).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn create_conversation_turn(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let idempotency_key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let Some(storage) = state.storage.as_ref().cloned() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ConversationTurnCreate>(request, 1_100_000).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let data_class = match serde_json::from_value::<DataClass>(serde_json::Value::String(
        payload.data_class.clone(),
    )) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid message data class",
            );
        }
    };
    let session = match storage.session(&session_id) {
        Ok(Some(session)) if session.status == "active" => session,
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "session is archived"),
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    };
    if let Some(preview_hash) = payload.context_preview_hash.as_deref() {
        let preview = match storage.context_preview_by_hash(preview_hash) {
            Ok(Some(preview)) => preview,
            Ok(None) => {
                return error_response(StatusCode::CONFLICT, "context preview is unavailable");
            }
            Err(error) => return storage_error_response(error),
        };
        if preview.session_id != session_id
            || preview.data_class != data_class_name(data_class)
            || preview.used_operation_id.is_some()
        {
            return error_response(
                StatusCode::CONFLICT,
                "context preview does not match this turn",
            );
        }
    }
    let provider_profile = match provider_for_session(&state, &session.profile_id, data_class) {
        Ok(Some(profile)) => profile,
        Ok(None) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "local-only sessions save messages without starting a model operation",
            );
        }
        Err(response) => return response,
    };
    let Some(provider) = state.provider.as_ref().cloned() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable",
        );
    };
    if payload.content.len() > 64_000 {
        return error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "model-backed messages are limited to 64000 bytes",
        );
    }
    let operation_id = match random_id("operation") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let user_message_id = match random_id("message") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let occurred_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let provider_binding = serde_json::json!({
        "registry_version": PROVIDER_REGISTRY_VERSION,
        "profile_id": provider_profile.profile_id(),
        "profile_version": provider_profile.version(),
        "profile_hash": provider_profile.content_hash(),
        "kind": provider_profile.kind(),
        "model": provider_profile.model(),
        "endpoint_hash": bytes_digest(provider_profile.base_url().as_bytes()),
        "request_adapter": provider_profile.kind().definition().request_adapter,
        "reasoning": provider_profile.reasoning(),
        "fallback": provider_profile.fallback(),
    });
    let created = match storage.create_conversation_operation(NewConversationOperation {
        operation_id: &operation_id,
        session_id: &session_id,
        idempotency_key: &idempotency_key,
        user_message_id: &user_message_id,
        content: &payload.content,
        context: &payload.context,
        data_class: data_class_name(data_class),
        context_preview_hash: payload.context_preview_hash.as_deref(),
        provider_binding: &provider_binding,
        occurred_at: &occurred_at,
    }) {
        Ok(created) => created,
        Err(error) => return storage_error_response(error),
    };
    if created.replayed {
        return Json(created).into_response();
    }

    let (cancel_sender, cancel_receiver) = tokio::sync::watch::channel(false);
    let registered = state
        .operation_cancellations
        .lock()
        .map(|mut operations| {
            operations.insert(operation_id.clone(), cancel_sender);
        })
        .is_ok();
    if !registered {
        let _ = storage.fail_conversation_operation(
            &operation_id,
            "runtime_registry_unavailable",
            &occurred_at,
        );
        return error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "operation runtime is unavailable",
        );
    }
    let cancellations = Arc::clone(&state.operation_cancellations);
    let profile_id = session.profile_id;
    let context_preview_hash = created.operation.context_preview_hash.clone();
    let session_id_for_task = session_id.clone();
    let operation_id_for_task = operation_id.clone();
    tokio::spawn(async move {
        run_conversation_operation(
            storage,
            provider,
            provider_profile,
            session_id_for_task,
            profile_id,
            context_preview_hash,
            operation_id_for_task,
            data_class_name(data_class).to_owned(),
            cancel_receiver,
            cancellations,
        )
        .await;
    });
    (StatusCode::ACCEPTED, Json(created)).into_response()
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_conversation_operation(
    storage: Arc<Database>,
    provider: Arc<ProviderClient>,
    provider_profile: ProviderProfile,
    session_id: String,
    profile_id: String,
    context_preview_hash: Option<String>,
    operation_id: String,
    data_class: String,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    cancellations: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
) {
    if *cancel.borrow() {
        finish_cancelled(&storage, &operation_id);
        remove_operation_runtime(&cancellations, &operation_id);
        return;
    }
    let started_at = now_rfc3339().ok();
    if started_at.as_deref().is_none_or(|at| {
        storage
            .start_conversation_operation(&operation_id, at)
            .is_err()
    }) {
        let operation = storage.conversation_operation(&operation_id).ok().flatten();
        if operation.is_some_and(|operation| operation.cancel_requested) {
            finish_cancelled(&storage, &operation_id);
        } else {
            fail_operation(&storage, &operation_id, "operation_start_failed");
        }
        remove_operation_runtime(&cancellations, &operation_id);
        return;
    }
    let messages = match conversation_chat_messages(
        &storage,
        &session_id,
        &profile_id,
        context_preview_hash.as_deref(),
    ) {
        Ok(messages) => messages,
        Err(_) => {
            fail_operation(&storage, &operation_id, "context_build_failed");
            remove_operation_runtime(&cancellations, &operation_id);
            return;
        }
    };
    let completion = tokio::select! {
        biased;
        _ = cancel.changed() => {
            finish_cancelled(&storage, &operation_id);
            remove_operation_runtime(&cancellations, &operation_id);
            return;
        }
        completion = provider.chat(&provider_profile, &messages, 1_024) => completion,
    };
    let completion = match completion {
        Ok(completion) => completion,
        Err(_) => {
            if *cancel.borrow() {
                finish_cancelled(&storage, &operation_id);
            } else {
                fail_operation(&storage, &operation_id, "provider_failed");
            }
            remove_operation_runtime(&cancellations, &operation_id);
            return;
        }
    };
    if *cancel.borrow() {
        finish_cancelled(&storage, &operation_id);
        remove_operation_runtime(&cancellations, &operation_id);
        return;
    }
    let Some(completed_at) = now_rfc3339().ok() else {
        fail_operation(&storage, &operation_id, "system_time_unavailable");
        remove_operation_runtime(&cancellations, &operation_id);
        return;
    };
    let Some(assistant_id) = random_id("message").ok() else {
        fail_operation(&storage, &operation_id, "entropy_unavailable");
        remove_operation_runtime(&cancellations, &operation_id);
        return;
    };
    let context = serde_json::json!({
        "provider_profile_id": provider_profile.profile_id(),
        "provider_version": provider_profile.version(),
        "provider_profile_hash": provider_profile.content_hash(),
        "reasoning": provider_profile.reasoning(),
        "latency_ms": completion.latency_ms,
        "request_id": completion.request_id,
        "prompt_tokens": completion.prompt_tokens,
        "completion_tokens": completion.completion_tokens,
        "total_tokens": completion.total_tokens,
        "cost_usd_micros": completion.cost_usd_micros,
        "tool_access": false,
    });
    if storage
        .complete_conversation_operation(
            &operation_id,
            &assistant_id,
            &completion.content,
            &context,
            &data_class,
            &completed_at,
        )
        .is_err()
    {
        let cancelled = storage
            .conversation_operation(&operation_id)
            .ok()
            .flatten()
            .is_some_and(|operation| operation.cancel_requested);
        if cancelled {
            finish_cancelled(&storage, &operation_id);
        } else {
            fail_operation(&storage, &operation_id, "completion_persist_failed");
        }
    }
    remove_operation_runtime(&cancellations, &operation_id);
}
pub(crate) async fn get_conversation_operation(
    State(state): State<ApiState>,
    Path(operation_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, SESSIONS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.conversation_operation(&operation_id) {
        Ok(Some(operation)) => Json(operation).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "operation not found"),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn cancel_conversation_operation(
    State(state): State<ApiState>,
    Path(operation_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let occurred_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let operation = match storage.request_operation_cancel(&operation_id, &occurred_at) {
        Ok(operation) => operation,
        Err(StorageError::Invalid(_)) => {
            return error_response(StatusCode::NOT_FOUND, "operation not found");
        }
        Err(error) => return storage_error_response(error),
    };
    if matches!(
        operation.state.as_str(),
        "completed" | "cancelled" | "failed"
    ) {
        return Json(operation).into_response();
    }
    let signalled = state
        .operation_cancellations
        .lock()
        .ok()
        .and_then(|operations| operations.get(&operation_id).cloned())
        .is_some_and(|sender| sender.send(true).is_ok());
    if signalled {
        (StatusCode::ACCEPTED, Json(operation)).into_response()
    } else {
        match storage.finish_operation_cancelled(&operation_id, &occurred_at) {
            Ok(operation) => Json(operation).into_response(),
            Err(error) => storage_error_response(error),
        }
    }
}
pub(crate) async fn conversation_operation_events(
    State(state): State<ApiState>,
    Path(operation_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_READ) {
        return *response;
    }
    let after_sequence = match last_event_sequence(request.headers()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let follow = match follow_requested(request.uri().query()) {
        Ok(value) => value,
        Err(()) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid follow value"),
    };
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let operation = match storage.conversation_operation(&operation_id) {
        Ok(Some(operation)) => operation,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "operation not found"),
        Err(error) => return storage_error_response(error),
    };
    let events = match storage.operation_events_after(&operation_id, after_sequence, 1_000) {
        Ok(events) => events,
        Err(error) => return storage_error_response(error),
    };
    let mut initial = String::new();
    let mut cursor = after_sequence;
    for event in events {
        cursor = event.sequence;
        initial.push_str(&operation_event_frame(&event));
    }
    if !follow
        || matches!(
            operation.state.as_str(),
            "completed" | "cancelled" | "failed"
        )
    {
        return sse_response(Body::from(initial));
    }

    struct OperationFollowState {
        storage: Arc<Database>,
        operation_id: String,
        cursor: i64,
        initial: Option<Bytes>,
        last_output: Instant,
        done: bool,
    }
    let updates = stream::unfold(
        OperationFollowState {
            storage,
            operation_id,
            cursor,
            initial: (!initial.is_empty()).then(|| Bytes::from(initial)),
            last_output: Instant::now(),
            done: false,
        },
        |mut state| async move {
            if state.done {
                return None;
            }
            if let Some(initial) = state.initial.take() {
                state.last_output = Instant::now();
                return Some((Ok::<Bytes, Infallible>(initial), state));
            }
            loop {
                match state
                    .storage
                    .operation_events_after(&state.operation_id, state.cursor, 100)
                {
                    Ok(events) if !events.is_empty() => {
                        let mut frames = String::new();
                        for event in events {
                            state.cursor = event.sequence;
                            frames.push_str(&operation_event_frame(&event));
                        }
                        state.last_output = Instant::now();
                        return Some((Ok(Bytes::from(frames)), state));
                    }
                    Ok(_) => {}
                    Err(_) => {
                        state.done = true;
                        return Some((
                            Ok(Bytes::from_static(
                                b"event: runtime.error\ndata: {\"detail\":\"operation replay unavailable\"}\n\n",
                            )),
                            state,
                        ));
                    }
                }
                match state.storage.conversation_operation(&state.operation_id) {
                    Ok(Some(operation))
                        if matches!(
                            operation.state.as_str(),
                            "completed" | "cancelled" | "failed"
                        ) =>
                    {
                        return None;
                    }
                    Ok(Some(_)) => {}
                    Ok(None) => return None,
                    Err(_) => {
                        state.done = true;
                        return Some((
                            Ok(Bytes::from_static(
                                b"event: runtime.error\ndata: {\"detail\":\"operation state unavailable\"}\n\n",
                            )),
                            state,
                        ));
                    }
                }
                if state.last_output.elapsed() >= std::time::Duration::from_secs(15) {
                    state.last_output = Instant::now();
                    return Some((
                        Ok(Bytes::from_static(b": restork-heartbeat\n\n")),
                        state,
                    ));
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        },
    )
    .boxed();
    sse_response(Body::from_stream(updates))
}
pub(crate) fn operation_event_frame(event: &OperationEventRecord) -> String {
    sse_frame(event.sequence, &event.kind, &event.data)
}
pub(crate) fn last_event_sequence(headers: &HeaderMap) -> Result<i64, Response> {
    let value = match headers.get("last-event-id") {
        Some(value) => value
            .to_str()
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .ok_or_else(|| {
                error_response(StatusCode::BAD_REQUEST, "Last-Event-ID must be an integer")
            })?,
        None => 0,
    };
    if value < 0 {
        return Err(error_response(
            StatusCode::BAD_REQUEST,
            "Last-Event-ID must not be negative",
        ));
    }
    Ok(value)
}
pub(crate) fn provider_for_session(
    state: &ApiState,
    profile_id: &str,
    data_class: DataClass,
) -> Result<Option<ProviderProfile>, Response> {
    if profile_id == "safe-mode" {
        return Ok(None);
    }
    if matches!(profile_id, "deepseek" | "deepseek-flash") {
        if data_class != DataClass::Public {
            return Err(error_response(
                StatusCode::FORBIDDEN,
                "the direct DeepSeek profile is public-only; create a profile that explicitly allows private data",
            ));
        }
        return configured_provider(state, profile_id);
    }
    let Some(storage) = state.storage.as_ref() else {
        return Err(storage_unavailable());
    };
    let record = storage
        .configuration_profile(profile_id)
        .map_err(storage_error_response)?
        .ok_or_else(|| {
            error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "profile is not configured",
            )
        })?;
    let profile: ConfigurationProfile =
        serde_json::from_value(record.profile).map_err(|_| storage_unavailable())?;
    profile.permits_data_class(data_class).map_err(|_| {
        error_response(
            StatusCode::FORBIDDEN,
            "message exceeds the profile data boundary",
        )
    })?;
    configured_provider(state, profile.provider_profile_id())?
        .ok_or_else(|| {
            error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "profile provider is not configured",
            )
        })
        .map(Some)
}
pub(crate) async fn list_session_messages(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let query = request.uri().query();
    let after = match optional_i64_query(query, "after", 0, 0) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let limit = match bounded_usize_query(query, "limit", 50, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.session_messages_page(&session_id, after, limit) {
        Ok(page) => Json(page).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn export_session(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, SESSIONS_EXPORT) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let session = match storage.session(&session_id) {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    };
    let mut messages = Vec::new();
    let mut after = 0;
    loop {
        let page = match storage.session_messages_page(&session_id, after, 100) {
            Ok(page) => page,
            Err(error) => return storage_error_response(error),
        };
        messages.extend(page.items);
        if messages.len() > 10_000 {
            return error_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "session export exceeds the 10000 message limit",
            );
        }
        let Some(next) = page.next_after else {
            break;
        };
        after = next;
    }
    let exported_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    Json(serde_json::json!({
        "schema_version": 1,
        "session": session,
        "messages": messages,
        "exported_at": exported_at,
        "secret_values_included": false,
        "note": "Conversation content may still be private; review before sharing.",
    }))
    .into_response()
}
pub(crate) async fn search_sessions(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let query = request.uri().query();
    let search = match single_query_value(query, "q") {
        Ok(Some(value)) if !value.trim().is_empty() => value,
        _ => return invalid_query(),
    };
    let limit = match bounded_usize_query(query, "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.search_session_messages(&search, limit) {
        Ok(items) => Json(SearchResults { items }).into_response(),
        Err(error) => storage_error_response(error),
    }
}
pub(crate) async fn create_run_proposal(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), SESSIONS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ProposalCreate>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let stored = match storage.session(&session_id) {
        Ok(Some(session)) if session.status == "active" => session,
        Ok(Some(_)) => return error_response(StatusCode::CONFLICT, "session is archived"),
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "session not found"),
        Err(error) => return storage_error_response(error),
    };
    let created_at = match OffsetDateTime::parse(&stored.created_at, &Rfc3339) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    let session = match ConversationSession::try_new(
        &stored.session_id,
        &stored.title,
        &stored.profile_id,
        created_at,
    ) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    let proposal = match RunProposal::from_local_intake(
        &session,
        payload.mode,
        &payload.goal,
        payload.data_class,
        OffsetDateTime::now_utc(),
    ) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid proposal"),
    };
    (StatusCode::CREATED, Json(proposal)).into_response()
}
pub(crate) async fn search_session_tools(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TOOLS_DISCOVER) {
        return *response;
    }
    let query = request.uri().query();
    let search = match single_query_value(query, "q") {
        Ok(Some(value)) if !value.trim().is_empty() => value,
        _ => return invalid_query(),
    };
    let limit = match bounded_usize_query(query, "limit", 12, 50) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let catalog = match frozen_session_catalog(&state, &session_id) {
        Ok(catalog) => catalog,
        Err(response) => return response,
    };
    match catalog.search(&search, limit) {
        Ok(items) => Json(serde_json::json!({
            "session_id": session_id,
            "catalog_fingerprint": catalog.fingerprint().as_str(),
            "items": items,
        }))
        .into_response(),
        Err(_) => invalid_query(),
    }
}
pub(crate) async fn describe_session_tool(
    State(state): State<ApiState>,
    Path((session_id, tool_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = authorize(&state.authority, &headers, TOOLS_DISCOVER) {
        return *response;
    }
    let catalog = match frozen_session_catalog(&state, &session_id) {
        Ok(catalog) => catalog,
        Err(response) => return response,
    };
    match catalog.describe(&tool_id) {
        Ok(descriptor) => Json(serde_json::json!({
            "session_id": session_id,
            "catalog_fingerprint": catalog.fingerprint().as_str(),
            "tool": descriptor,
            "output_is_untrusted": true,
        }))
        .into_response(),
        Err(_) => error_response(StatusCode::NOT_FOUND, "tool is not granted to this session"),
    }
}
pub(crate) async fn preview_session_tool_call(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TOOLS_INVOKE) {
        return *response;
    }
    let payload = match parse_json::<ToolCallPreviewCreate>(request, 1024 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let catalog = match frozen_session_catalog(&state, &session_id) {
        Ok(catalog) => catalog,
        Err(response) => return response,
    };
    match catalog.resolve_call(&payload.tool_id, payload.input) {
        Ok(resolved) => {
            let Ok(resolved_value) = serde_json::to_value(&resolved) else {
                return storage_unavailable();
            };
            let call_digest = json_digest(&resolved_value);
            Json(serde_json::json!({
                "state": "review_required",
                "execution_started": false,
                "output_is_untrusted": resolved.output_is_untrusted(),
                "call_digest": call_digest,
                "resolved_call": resolved,
            }))
            .into_response()
        }
        Err(_) => error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "tool call is invalid or outside the frozen session grant",
        ),
    }
}
pub(crate) async fn execute_session_tool_call(
    State(state): State<ApiState>,
    Path(session_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TOOLS_INVOKE) {
        return *response;
    }
    let idempotency_key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ToolCallExecute>(request, 1024 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let catalog = match frozen_session_catalog(&state, &session_id) {
        Ok(catalog) => catalog,
        Err(response) => return response,
    };
    let resolved = match catalog.resolve_call(&payload.tool_id, payload.input) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "tool call is invalid or outside the frozen session grant",
            );
        }
    };
    let resolved_value = match serde_json::to_value(&resolved) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    let computed_digest = json_digest(&resolved_value);
    if payload.call_digest != computed_digest {
        return error_response(
            StatusCode::CONFLICT,
            "tool call changed after review; preview it again",
        );
    }
    let execution_id = match random_id("mcp") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let started_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let created = match storage.create_mcp_execution(&NewMcpExecution {
        execution_id: &execution_id,
        session_id: &session_id,
        idempotency_key: &idempotency_key,
        tool_id: &resolved.real_tool_id,
        package_id: &resolved.package_id,
        package_hash: resolved.package_hash.as_str(),
        catalog_fingerprint: resolved.catalog_fingerprint.as_str(),
        call_digest: &computed_digest,
        resolved_call: &resolved_value,
        started_at: &started_at,
    }) {
        Ok(value) => value,
        Err(error) => return storage_error_response(error),
    };
    if created.replayed {
        let status = if created.execution.state == "running" {
            StatusCode::ACCEPTED
        } else {
            StatusCode::OK
        };
        return (status, Json(created)).into_response();
    }

    let secret_values = match agent_tools::resolve_mcp_secrets(&resolved).await {
        Ok(values) => values,
        Err(_) => {
            let completed_at = match now_rfc3339() {
                Ok(value) => value,
                Err(response) => return response,
            };
            let _ = storage.complete_mcp_execution(
                &execution_id,
                "failed",
                None,
                Some("missing_secret"),
                &completed_at,
            );
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "one or more MCP native secret references are not configured",
            );
        }
    };
    let outcome = execute_stdio_mcp(&resolved, &secret_values).await;
    let completed_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match outcome {
        Ok(output) => {
            let result = serde_json::json!({
                "output": output,
                "output_is_untrusted": true,
                "reviewed_call_digest": computed_digest,
            });
            match storage.complete_mcp_execution(
                &execution_id,
                "succeeded",
                Some(&result),
                None,
                &completed_at,
            ) {
                Ok(execution) => (StatusCode::OK, Json(execution)).into_response(),
                Err(error) => storage_error_response(error),
            }
        }
        Err(error) => match storage.complete_mcp_execution(
            &execution_id,
            "failed",
            None,
            Some(error.code()),
            &completed_at,
        ) {
            Ok(execution) => (StatusCode::BAD_GATEWAY, Json(execution)).into_response(),
            Err(storage_error) => storage_error_response(storage_error),
        },
    }
}
pub(crate) fn frozen_session_catalog(
    state: &ApiState,
    session_id: &str,
) -> Result<restork_extension::FrozenToolCatalog, Response> {
    let Some(storage) = state.storage.as_ref() else {
        return Err(storage_unavailable());
    };
    let session = storage
        .session(session_id)
        .map_err(storage_error_response)?
        .ok_or_else(|| error_response(StatusCode::NOT_FOUND, "session not found"))?;
    if session.status != "active" {
        return Err(error_response(StatusCode::CONFLICT, "session is archived"));
    }

    let (allowed_tools, profile_id) = if matches!(
        session.profile_id.as_str(),
        "safe-mode" | "deepseek" | "deepseek-flash"
    ) {
        (BTreeSet::new(), session.profile_id)
    } else {
        let record = storage
            .configuration_profile(&session.profile_id)
            .map_err(storage_error_response)?
            .ok_or_else(|| {
                error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "profile is not configured",
                )
            })?;
        let profile: ConfigurationProfile =
            serde_json::from_value(record.profile).map_err(|_| storage_unavailable())?;
        (profile.allowed_tools().clone(), session.profile_id)
    };

    let extensions = storage
        .extensions_page(None, 100)
        .map_err(storage_error_response)?;
    let mut registry = ToolRegistry::new();
    let mut permissions = BTreeSet::new();
    for extension in extensions
        .items
        .into_iter()
        .filter(|item| item.state == "enabled")
    {
        match extension.package_kind.as_str() {
            "mcp" => {
                let Ok(manifest) = serde_json::from_value::<McpServerManifest>(extension.manifest)
                else {
                    continue;
                };
                if !manifest.enabled_profiles.contains(&profile_id) {
                    continue;
                }
                permissions.extend(
                    manifest
                        .requested_permissions
                        .iter()
                        .map(|permission| permission.as_str().to_owned()),
                );
                for tool in manifest.tools.iter().cloned() {
                    if !allowed_tools.contains(&tool.id) {
                        continue;
                    }
                    let _ = registry.register(ToolDescriptor {
                        package_id: manifest.id.clone(),
                        package_version: manifest.version.clone(),
                        package_hash: manifest.provenance.content_hash.clone(),
                        server_id: manifest.id.clone(),
                        server_permissions: manifest.requested_permissions.clone(),
                        secret_references: manifest.secret_references.clone(),
                        sandbox: manifest.sandbox.clone(),
                        manifest: tool,
                        transport: manifest.transport.clone(),
                    });
                }
            }
            "plugin" => {
                let Ok(mut manifest) = serde_json::from_value::<PluginManifest>(extension.manifest)
                else {
                    continue;
                };
                if !manifest.enabled_profiles.contains(&profile_id) {
                    continue;
                }
                permissions.extend(
                    manifest
                        .requested_permissions
                        .iter()
                        .map(|permission| permission.as_str().to_owned()),
                );
                for server in &mut manifest.mcp_servers {
                    server.tools.retain(|tool| allowed_tools.contains(&tool.id));
                }
                let _ = registry.register_plugin(&manifest);
            }
            "skill" => {}
            _ => {}
        }
    }
    let effective_grant = PermissionSet::from_ids(permissions)
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "tool grant is invalid"))?;
    registry
        .freeze_session(session_id, &allowed_tools, &effective_grant)
        .map_err(|_| error_response(StatusCode::UNPROCESSABLE_ENTITY, "tool catalog is invalid"))
}
pub(crate) fn optional_i64_query(
    query: Option<&str>,
    key: &str,
    default: i64,
    minimum: i64,
) -> Result<i64, Response> {
    let value = match single_query_value(query, key) {
        Ok(Some(value)) => value,
        Ok(None) => return Ok(default),
        Err(()) => return Err(invalid_query()),
    };
    value
        .parse::<i64>()
        .ok()
        .filter(|value| *value >= minimum)
        .ok_or_else(invalid_query)
}
pub(crate) fn boolean_query(
    query: Option<&str>,
    key: &str,
    default: bool,
) -> Result<bool, Response> {
    let value = match single_query_value(query, key) {
        Ok(Some(value)) => value,
        Ok(None) => return Ok(default),
        Err(()) => return Err(invalid_query()),
    };
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Ok(true),
        "false" | "0" | "off" | "no" => Ok(false),
        _ => Err(invalid_query()),
    }
}
