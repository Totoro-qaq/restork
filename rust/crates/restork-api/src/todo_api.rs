//! Durable local Todo APIs and the combined local/Vault task board.

use axum::{
    Json,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use restork_core::{
    auth::{TASKS_READ, TASKS_WRITE},
    workspace::SafeWorkspace,
};
use serde::Deserialize;
use serde_json::{Value, json};

use super::feature_api::scan_tasks;
use super::{
    ApiState, authorize, bounded_usize_query, error_response, idempotency_key, invalid_query,
    parse_json, sha256_hex, single_query_value, storage_error_response, storage_unavailable,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalTodoInput {
    title: String,
    #[serde(default)]
    details: String,
    priority: Option<String>,
    due_at: Option<String>,
    #[serde(default)]
    completed: bool,
    #[serde(default = "user_todo_origin")]
    origin: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalTodoUpdate {
    title: String,
    #[serde(default)]
    details: String,
    priority: Option<String>,
    due_at: Option<String>,
    completed: bool,
    #[serde(default)]
    origin: Option<String>,
    expected_updated_at: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalTodoDelete {
    expected_updated_at: String,
}

fn user_todo_origin() -> String {
    "user".to_owned()
}

pub(super) async fn list_tasks(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_READ) {
        return *response;
    }
    let limit = match bounded_usize_query(request.uri().query(), "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let mut tasks = Vec::<Value>::new();
    let mut deleted_tasks = Vec::<Value>::new();
    let mut local_count = 0;
    if let Some(storage) = state.storage.as_deref() {
        local_count = match storage.local_todo_count() {
            Ok(count) => count,
            Err(error) => return storage_error_response(error),
        };
        if offset < local_count {
            let local = match storage.local_todos(limit, offset) {
                Ok(items) => items,
                Err(error) => return storage_error_response(error),
            };
            tasks.extend(local.into_iter().map(local_todo_json));
        }
        deleted_tasks = match storage.deleted_local_todos(13, 0) {
            Ok(items) => items.into_iter().map(deleted_local_todo_json).collect(),
            Err(error) => return storage_error_response(error),
        };
    }
    let vault_configured = state.vault_dir.is_some();
    let mut vault_count = 0;
    if let Some(root) = state.vault_dir.as_deref() {
        let root = root.clone();
        let vault_tasks = match tokio::task::spawn_blocking(move || {
            let workspace = SafeWorkspace::open(root.as_path()).map_err(|_| ())?;
            let mut tasks = scan_tasks(&workspace).map_err(|_| ())?;
            tasks.sort_by(|left, right| {
                left.completed
                    .cmp(&right.completed)
                    .then_with(|| left.relative_path.cmp(&right.relative_path))
                    .then_with(|| left.line_number.cmp(&right.line_number))
            });
            Ok::<_, ()>(tasks)
        })
        .await
        {
            Ok(Ok(tasks)) => tasks,
            Ok(Err(())) | Err(_) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault scan failed");
            }
        };
        vault_count = vault_tasks.len();
        let vault_offset = offset.saturating_sub(local_count);
        let remaining = limit.saturating_sub(tasks.len());
        tasks.extend(
            vault_tasks
                .into_iter()
                .skip(vault_offset)
                .take(remaining)
                .map(|task| {
                    json!({
                        "task_id": task.task_id,
                        "text": task.text,
                        "details": "",
                        "completed": task.completed,
                        "fields": task.fields,
                        "origin": "vault",
                        "editable": false,
                        "updated_at": null,
                        "relative_path": task.relative_path,
                        "line_number": task.line_number,
                        "block_id": task.block_id,
                        "locator_hash": task.locator_hash,
                    })
                }),
        );
    }
    let has_more = local_count.saturating_add(vault_count) > offset.saturating_add(tasks.len());
    Json(json!({
        "configured": true,
        "vault_configured": vault_configured,
        "tasks": tasks,
        "page": page(limit, offset, has_more),
        "deleted_tasks": deleted_tasks.iter().take(12).cloned().collect::<Vec<_>>(),
        "deleted_page": page(12, 0, deleted_tasks.len() > 12),
    }))
    .into_response()
}

fn local_todo_json(todo: restork_storage::LocalTodoRecord) -> Value {
    json!({
        "task_id": todo.task_id,
        "text": todo.title,
        "details": todo.details,
        "completed": todo.status == "completed",
        "fields": {"priority": todo.priority, "due": todo.due_at},
        "origin": todo.origin,
        "editable": true,
        "updated_at": todo.updated_at,
        "relative_path": null,
        "line_number": null,
        "block_id": null,
        "locator_hash": null,
    })
}

fn deleted_local_todo_json(todo: restork_storage::LocalTodoRecord) -> Value {
    let mut value = local_todo_json(todo.clone());
    value["deleted_at"] = json!(todo.deleted_at);
    value
}

pub(super) async fn list_deleted_local_todos(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_READ) {
        return *response;
    }
    let limit = match bounded_usize_query(request.uri().query(), "limit", 12, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let Some(storage) = state.storage.as_deref() else {
        return storage_unavailable();
    };
    let items = match storage.deleted_local_todos(limit.saturating_add(1), offset) {
        Ok(items) => items,
        Err(error) => return storage_error_response(error),
    };
    let has_more = items.len() > limit;
    Json(json!({
        "tasks": items.into_iter().take(limit).map(deleted_local_todo_json).collect::<Vec<_>>(),
        "page": page(limit, offset, has_more),
    }))
    .into_response()
}

pub(super) async fn create_local_todo(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let Some(storage) = state.storage.as_deref() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<LocalTodoInput>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if !matches!(payload.origin.as_str(), "user" | "model") {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid local Todo origin",
        );
    }
    let task_id = format!("todo-{}", &sha256_hex(key.as_bytes())[..24]);
    if let Ok(Some(existing)) = storage.local_todo(&task_id) {
        return Json(existing).into_response();
    }
    let occurred_at = Utc::now().to_rfc3339();
    match storage.put_local_todo(
        restork_storage::NewLocalTodo {
            task_id: &task_id,
            title: payload.title.trim(),
            details: payload.details.trim(),
            priority: payload.priority.as_deref(),
            due_at: payload.due_at.as_deref(),
            status: if payload.completed {
                "completed"
            } else {
                "open"
            },
            origin: &payload.origin,
            occurred_at: &occurred_at,
        },
        None,
    ) {
        Ok(record) => (StatusCode::CREATED, Json(record)).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn update_local_todo(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage.as_deref() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<LocalTodoUpdate>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let existing = match storage.local_todo(&task_id) {
        Ok(Some(record)) => record,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "local Todo not found"),
        Err(error) => return storage_error_response(error),
    };
    if payload
        .origin
        .as_deref()
        .is_some_and(|origin| origin != existing.origin)
    {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "local Todo origin cannot change",
        );
    }
    let occurred_at = Utc::now().to_rfc3339();
    match storage.put_local_todo(
        restork_storage::NewLocalTodo {
            task_id: &task_id,
            title: payload.title.trim(),
            details: payload.details.trim(),
            priority: payload.priority.as_deref(),
            due_at: payload.due_at.as_deref(),
            status: if payload.completed {
                "completed"
            } else {
                "open"
            },
            origin: &existing.origin,
            occurred_at: &occurred_at,
        },
        Some(&payload.expected_updated_at),
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn delete_local_todo(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage.as_deref() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<LocalTodoDelete>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    match storage.delete_local_todo(&task_id, &payload.expected_updated_at) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn restore_local_todo(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let Some(storage) = state.storage.as_deref() else {
        return storage_unavailable();
    };
    let payload = match parse_json::<LocalTodoDelete>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    match storage.restore_local_todo(&task_id, &payload.expected_updated_at) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) fn bootstrap_task_board(state: &ApiState) -> Result<Option<Value>, ()> {
    if state.storage.is_none() && state.vault_dir.is_none() {
        return Ok(None);
    }
    let mut tasks = Vec::<Value>::new();
    let mut deleted_tasks = Vec::<Value>::new();
    let mut deleted_has_more = false;
    if let Some(storage) = state.storage.as_deref() {
        tasks.extend(
            storage
                .local_todos(12, 0)
                .map_err(|_| ())?
                .into_iter()
                .map(local_todo_json),
        );
        let deleted = storage.deleted_local_todos(13, 0).map_err(|_| ())?;
        deleted_has_more = deleted.len() > 12;
        deleted_tasks = deleted
            .into_iter()
            .take(12)
            .map(deleted_local_todo_json)
            .collect();
    }
    if tasks.len() < 12
        && let Some(root) = state.vault_dir.as_deref()
    {
        let workspace = SafeWorkspace::open(root.as_path()).map_err(|_| ())?;
        tasks.extend(
            scan_tasks(&workspace)
                .map_err(|_| ())?
                .into_iter()
                .take(12 - tasks.len())
                .map(|task| {
                    json!({
                        "task_id": task.task_id,
                        "text": task.text,
                        "details": "",
                        "completed": task.completed,
                        "fields": task.fields,
                        "origin": "vault",
                        "editable": false,
                        "updated_at": null,
                        "relative_path": task.relative_path,
                        "line_number": task.line_number,
                        "block_id": task.block_id,
                        "locator_hash": task.locator_hash,
                    })
                }),
        );
    }
    Ok(Some(json!({
        "configured": true,
        "vault_configured": state.vault_dir.is_some(),
        "tasks": tasks,
        "deleted_tasks": deleted_tasks,
        "deleted_page": page(12, 0, deleted_has_more),
    })))
}

fn offset_query(query: Option<&str>) -> Result<usize, Response> {
    match single_query_value(query, "cursor") {
        Ok(None) => Ok(0),
        Ok(Some(value)) if value.is_empty() => Ok(0),
        Ok(Some(value)) => value.parse::<usize>().map_err(|_| invalid_query()),
        Err(()) => Err(invalid_query()),
    }
}

fn page(limit: usize, offset: usize, has_more: bool) -> Value {
    json!({
        "limit": limit,
        "has_more": has_more,
        "next_cursor": has_more.then(|| (offset + limit).to_string()),
    })
}
