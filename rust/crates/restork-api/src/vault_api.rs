//! Read-only Obsidian Vault browsing and metadata-only live updates.

use std::{
    collections::BTreeSet,
    convert::Infallible,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{StreamExt, stream};
use notify::{
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
    event::{ModifyKind, RenameMode},
};
use restork_core::{auth::VAULT_READ, workspace::SafeWorkspace};
use serde_json::{Value, json};

use super::{
    ApiState, authorize, bounded_usize_query, error_response, invalid_query, single_query_value,
    sse_response,
};

/// List Markdown notes in the explicitly granted Vault. This is deliberately
/// separate from `/v1/search`: a file browser should not need session, memory,
/// task, Radar, or run scopes just to enumerate local note names.
pub(super) async fn list_vault_notes(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), VAULT_READ) {
        return *response;
    }
    let Some(root) = state.vault_dir.as_deref() else {
        return Json(json!({
            "configured": false,
            "items": [],
            "total": 0,
            "page": page(100, 0, false),
        }))
        .into_response();
    };
    let limit = match bounded_usize_query(request.uri().query(), "limit", 100, 200) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let workspace = match SafeWorkspace::open(root.as_path()) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"),
    };
    let notes = match workspace.markdown_index(4_000) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault scan failed"),
    };
    let total = notes.len();
    let has_more = total > offset.saturating_add(limit);
    Json(json!({
        "configured": true,
        "items": notes.into_iter().skip(offset).take(limit).collect::<Vec<_>>(),
        "total": total,
        "page": page(limit, offset, has_more),
    }))
    .into_response()
}

pub(super) async fn search_vault_notes(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), VAULT_READ) {
        return *response;
    }
    let query = match single_query_value(request.uri().query(), "q") {
        Ok(Some(value)) if !value.trim().is_empty() && value.len() <= 512 => value,
        _ => return invalid_query(),
    };
    let limit = match bounded_usize_query(request.uri().query(), "limit", 40, 50) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let workspace = match configured_workspace(&state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match workspace.search_notes(&query, limit) {
        Ok(items) => Json(json!({"query": query, "items": items})).into_response(),
        Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault search failed"),
    }
}

pub(super) async fn read_vault_note(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), VAULT_READ) {
        return *response;
    }
    let relative_path = match single_query_value(request.uri().query(), "path") {
        Ok(Some(value)) if !value.is_empty() && value.len() <= 4_096 => value,
        _ => return invalid_query(),
    };
    let workspace = match configured_workspace(&state) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match workspace.read_note(&relative_path) {
        Ok((content, sha256)) => {
            let byte_count = content.len();
            Json(json!({
                "relative_path": relative_path,
                "content": content,
                "sha256": sha256,
                "byte_count": byte_count,
                "output_is_untrusted": true,
            }))
            .into_response()
        }
        Err(_) => error_response(
            StatusCode::NOT_FOUND,
            "Vault note is unavailable, unsafe, or too large",
        ),
    }
}

struct VaultStreamState {
    root: Arc<PathBuf>,
    _watcher: RecommendedWatcher,
    receiver: tokio::sync::mpsc::UnboundedReceiver<notify::Result<Event>>,
    sequence: u64,
    ready: bool,
    file_count: usize,
}

pub(super) async fn vault_events(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), VAULT_READ) {
        return *response;
    }
    let Some(configured_root) = state.vault_dir.as_deref() else {
        return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is not configured");
    };
    let root = match configured_root.canonicalize() {
        Ok(value) => Arc::new(value),
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"),
    };
    let file_count = match SafeWorkspace::open(root.as_path())
        .and_then(|workspace| workspace.markdown_index(4_000))
    {
        Ok(value) => value.len(),
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"),
    };
    let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
    let mut watcher = match notify::recommended_watcher(move |event: notify::Result<Event>| {
        let _ = sender.send(event);
    }) {
        Ok(value) => value,
        Err(_) => {
            return error_response(
                StatusCode::SERVICE_UNAVAILABLE,
                "Vault file watcher is unavailable",
            );
        }
    };
    if watcher
        .watch(root.as_path(), RecursiveMode::Recursive)
        .is_err()
    {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Vault file watcher could not start",
        );
    }
    let sequence = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
    )
    .unwrap_or(u64::MAX);
    let updates =
        stream::unfold(
            VaultStreamState {
                root,
                _watcher: watcher,
                receiver,
                sequence,
                ready: false,
                file_count,
            },
            |mut state| async move {
                if !state.ready {
                    state.ready = true;
                    state.sequence = state.sequence.saturating_add(1);
                    let data = json!({"file_count": state.file_count});
                    return Some((
                        Ok::<Bytes, Infallible>(Bytes::from(vault_sse_frame(
                            state.sequence,
                            "vault.ready",
                            &data,
                        ))),
                        state,
                    ));
                }
                loop {
                    let first =
                        match tokio::time::timeout(Duration::from_secs(15), state.receiver.recv())
                            .await
                        {
                            Err(_) => {
                                return Some((
                                    Ok(Bytes::from_static(b": restork-vault-heartbeat\n\n")),
                                    state,
                                ));
                            }
                            Ok(None) => return None,
                            Ok(Some(Err(_))) => {
                                state.sequence = state.sequence.saturating_add(1);
                                let data = json!({"detail": "Vault is temporarily unavailable"});
                                return Some((
                                    Ok(Bytes::from(vault_sse_frame(
                                        state.sequence,
                                        "vault.unavailable",
                                        &data,
                                    ))),
                                    state,
                                ));
                            }
                            Ok(Some(Ok(event))) => event,
                        };
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    let mut events = vec![first];
                    while let Ok(event) = state.receiver.try_recv() {
                        match event {
                            Ok(event) => events.push(event),
                            Err(_) => {
                                state.sequence = state.sequence.saturating_add(1);
                                let data = json!({"detail": "Vault is temporarily unavailable"});
                                return Some((
                                    Ok(Bytes::from(vault_sse_frame(
                                        state.sequence,
                                        "vault.unavailable",
                                        &data,
                                    ))),
                                    state,
                                ));
                            }
                        }
                    }
                    if let Some(data) = vault_event_payload(state.root.as_path(), &events) {
                        state.sequence = state.sequence.saturating_add(1);
                        return Some((
                            Ok(Bytes::from(vault_sse_frame(
                                state.sequence,
                                "vault.changed",
                                &data,
                            ))),
                            state,
                        ));
                    }
                }
            },
        )
        .boxed();
    sse_response(Body::from_stream(updates))
}

fn configured_workspace(state: &ApiState) -> Result<SafeWorkspace, Response> {
    let root = state.vault_dir.as_deref().ok_or_else(|| {
        error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is not configured")
    })?;
    SafeWorkspace::open(root.as_path())
        .map_err(|_| error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"))
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

#[derive(Clone)]
enum VaultEventPath {
    Markdown(String),
    Directory,
}

fn vault_event_payload(root: &Path, events: &[Event]) -> Option<Value> {
    let mut added = BTreeSet::new();
    let mut modified = BTreeSet::new();
    let mut removed = BTreeSet::new();
    let mut directory_changed = false;
    for event in events {
        if matches!(event.kind, EventKind::Access(_)) {
            continue;
        }
        let paths = event
            .paths
            .iter()
            .filter_map(|path| vault_event_path(root, path))
            .collect::<Vec<_>>();
        if paths.is_empty() {
            continue;
        }
        match event.kind {
            EventKind::Create(_) => {
                add_event_paths(&mut added, &paths, &mut directory_changed);
            }
            EventKind::Remove(_) => {
                add_event_paths(&mut removed, &paths, &mut directory_changed);
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if let Some(first) = paths.first() {
                    add_event_paths(
                        &mut removed,
                        std::slice::from_ref(first),
                        &mut directory_changed,
                    );
                }
                if paths.len() > 1 {
                    add_event_paths(&mut added, &paths[1..], &mut directory_changed);
                }
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
                add_event_paths(&mut removed, &paths, &mut directory_changed);
            }
            EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
                add_event_paths(&mut added, &paths, &mut directory_changed);
            }
            EventKind::Modify(_) | EventKind::Any | EventKind::Other => {
                add_event_paths(&mut modified, &paths, &mut directory_changed);
            }
            EventKind::Access(_) => {}
        }
    }
    let changed_count =
        added.len() + modified.len() + removed.len() + usize::from(directory_changed);
    if changed_count == 0 {
        return None;
    }
    let visible_added = added.iter().take(50).cloned().collect::<Vec<_>>();
    let visible_modified = modified.iter().take(50).cloned().collect::<Vec<_>>();
    let visible_removed = removed.iter().take(50).cloned().collect::<Vec<_>>();
    let visible_count = visible_added.len() + visible_modified.len() + visible_removed.len();
    Some(json!({
        "added": visible_added,
        "modified": visible_modified,
        "removed": visible_removed,
        "changed_count": changed_count,
        "paths_truncated": directory_changed || changed_count > visible_count,
    }))
}

fn add_event_paths(
    destination: &mut BTreeSet<String>,
    paths: &[VaultEventPath],
    directory_changed: &mut bool,
) {
    for path in paths {
        match path {
            VaultEventPath::Markdown(path) => {
                destination.insert(path.clone());
            }
            VaultEventPath::Directory => *directory_changed = true,
        }
    }
}

fn vault_event_path(root: &Path, path: &Path) -> Option<VaultEventPath> {
    let relative = path.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty()
        || relative.components().any(|component| {
            let Component::Normal(part) = component else {
                return true;
            };
            matches!(part.to_str(), Some(".git" | ".obsidian" | ".trash"))
        })
    {
        return None;
    }
    match relative.extension().and_then(|value| value.to_str()) {
        Some("md") => Some(VaultEventPath::Markdown(
            relative.to_string_lossy().replace('\\', "/"),
        )),
        None => Some(VaultEventPath::Directory),
        Some(_) => None,
    }
}

fn vault_sse_frame(sequence: u64, kind: &str, data: &Value) -> String {
    let data = serde_json::to_string(data).unwrap_or_else(|_| "{}".to_owned());
    format!("id: {sequence}\nevent: {kind}\ndata: {data}\n\n")
}
