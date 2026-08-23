//! Rust-owned APIs for memory, Markdown tasks, approvals, and Radar.

use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path as FsPath, PathBuf},
    time::{Duration, SystemTime},
};

use axum::{
    Json,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::future::join_all;
use restork_core::{
    auth::{
        APPROVALS_DECIDE, APPROVALS_READ, MEMORY_READ, MEMORY_WRITE, RADAR_READ, RADAR_WRITE,
        RUNS_READ, RUNS_WRITE, SESSIONS_READ, TASKS_READ, TASKS_WRITE, VAULT_READ,
    },
    workspace::SafeWorkspace,
};
use restork_core::{durable_loop::AgentOutcome, evidence::build_ledger};
use restork_provider::PublicWebGateway;
use restork_storage::{Database, RunRecord};
use restork_storage::{NewMemoryRecord, NewRadarRecord, NewTaskPreview, NewWorkVerification};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

use super::radar::{NewRadarOwned, RadarConfiguration, github_discovery_urls, github_radar_record};
use super::vault_api::study_note_slug;
use super::{
    ApiState, authorize, authorize_scopes, bounded_usize_query, error_response,
    error_response_owned, idempotency_key, invalid_query, json_digest, now_rfc3339, parse_json,
    random_id, require_idempotency_key, single_query_value, storage_error_response,
    storage_unavailable,
};

const MEMORY_ARCHITECTURE: [&str; 4] = ["working", "episodic", "semantic", "profile"];
const TASK_POLICY_VERSION: &str = "markdown-journal-v1";

#[derive(Serialize)]
struct UnifiedSearchHit {
    kind: &'static str,
    reference: String,
    title: String,
    excerpt: String,
    score: usize,
    session_id: Option<String>,
    sequence: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryCreate {
    memory_id: String,
    kind: String,
    summary: String,
    #[serde(default = "user_provenance")]
    provenance: String,
    #[serde(default = "personal_class")]
    data_class: String,
    #[serde(default = "session_retention")]
    retention_class: String,
    expires_at: Option<String>,
    run_id: Option<String>,
    source_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryCorrection {
    summary: String,
    expected_content_hash: String,
    #[serde(default = "personal_class")]
    data_class: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedHash {
    expected_content_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MemoryExport {
    #[serde(default = "default_memory_export_layers")]
    layers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourcePurge {
    source_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ApprovalDecision {
    decision: String,
    #[serde(default)]
    decided_by: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskToggle {
    completed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskCapture {
    text: String,
    priority: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(super) struct MarkdownTask {
    pub(super) task_id: String,
    pub(super) relative_path: String,
    pub(super) line_number: usize,
    pub(super) text: String,
    pub(super) completed: bool,
    pub(super) fields: BTreeMap<String, String>,
    pub(super) block_id: Option<String>,
    pub(super) locator_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RadarAction {
    action: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkStart {
    goal: String,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    workspace_grant_id: Option<String>,
    target_files: Vec<String>,
    #[serde(default)]
    context_files: Vec<String>,
    #[serde(default)]
    constraints: Vec<String>,
    #[serde(default)]
    non_goals: Vec<String>,
    #[serde(default)]
    completion_criteria: Vec<String>,
    #[serde(default)]
    verification_commands: Vec<String>,
    context_data_class: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkExport {
    approval_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkResultManifest {
    #[serde(default = "manifest_schema_version")]
    schema_version: u8,
    run_id: String,
    plan_artifact_id: String,
    base_snapshot_hash: String,
    #[serde(default)]
    changed_files: Vec<WorkChangedFile>,
    #[serde(default)]
    claimed_commands: Vec<WorkCommandClaim>,
    #[serde(default)]
    artifacts: Vec<WorkArtifactClaim>,
    summary: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkChangedFile {
    relative_path: String,
    before_hash: Option<String>,
    after_hash: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkCommandClaim {
    command: String,
    exit_code: i32,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct WorkArtifactClaim {
    relative_path: String,
    content_hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StudyDiagnosticRequest {
    objective: String,
    #[serde(default)]
    target_note: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StudyPathRequest {
    answers: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StudyAttemptRequest {
    answer: String,
    confidence: u8,
}

const fn manifest_schema_version() -> u8 {
    1
}

const fn user_provenance() -> String {
    String::new()
}

fn personal_class() -> String {
    "personal".to_owned()
}

fn session_retention() -> String {
    "session".to_owned()
}

fn default_memory_export_layers() -> Vec<String> {
    vec!["episodic".to_owned(), "profile".to_owned()]
}

pub(super) async fn search_workspace(State(state): State<ApiState>, request: Request) -> Response {
    const SEARCH_SCOPES: [&str; 6] = [
        SESSIONS_READ,
        MEMORY_READ,
        TASKS_READ,
        RADAR_READ,
        RUNS_READ,
        VAULT_READ,
    ];
    if let Err(response) = authorize_scopes(&state.authority, request.headers(), &SEARCH_SCOPES) {
        return *response;
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let query = match single_query_value(request.uri().query(), "q") {
        Ok(Some(value)) if !value.trim().is_empty() && value.len() <= 256 => value,
        _ => return invalid_query(),
    };
    let limit = match bounded_usize_query(request.uri().query(), "limit", 30, 100) {
        Ok(limit) => limit,
        Err(response) => return response,
    };
    let query_lower = query.trim().to_lowercase();
    let terms = query_lower.split_whitespace().collect::<Vec<_>>();
    let mut hits = Vec::new();

    match storage.search_session_messages(&query, limit) {
        Ok(records) => hits.extend(records.into_iter().map(|record| UnifiedSearchHit {
            kind: "session",
            reference: record.message_id.clone(),
            title: format!("Conversation {}", record.session_id),
            score: text_score(&query_lower, &terms, &record.excerpt),
            excerpt: record.excerpt,
            session_id: Some(record.session_id),
            sequence: Some(record.sequence),
        })),
        Err(error) => return storage_error_response(error),
    }

    if let Some(root) = state.vault_dir.as_deref() {
        let workspace = match SafeWorkspace::open(root.as_path()) {
            Ok(workspace) => workspace,
            Err(_) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable");
            }
        };
        match workspace.search_notes(&query, limit.min(50)) {
            Ok(records) => hits.extend(records.into_iter().map(|record| UnifiedSearchHit {
                kind: "vault",
                reference: record.relative_path.clone(),
                title: record.relative_path,
                score: text_score(&query_lower, &terms, &record.excerpt).saturating_add(4),
                excerpt: record.excerpt,
                session_id: None,
                sequence: None,
            })),
            Err(_) => {
                return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault search failed");
            }
        }
        let tasks = match scan_tasks(&workspace) {
            Ok(tasks) => tasks,
            Err(response) => return response,
        };
        hits.extend(tasks.into_iter().filter_map(|task| {
            let score = text_score(
                &query_lower,
                &terms,
                &format!("{} {}", task.relative_path, task.text),
            );
            (score > 0).then_some(UnifiedSearchHit {
                kind: "task",
                reference: task.task_id,
                title: task.text.clone(),
                excerpt: format!(
                    "{}:{} · {}",
                    task.relative_path, task.line_number, task.text
                ),
                score,
                session_id: None,
                sequence: None,
            })
        }));
    }

    let now = match now_rfc3339() {
        Ok(now) => now,
        Err(response) => return response,
    };
    match storage.memory_records(100, 0, &now) {
        Ok(records) => hits.extend(records.into_iter().filter_map(|record| {
            let score = text_score(&query_lower, &terms, &record.summary);
            (score > 0).then(|| UnifiedSearchHit {
                kind: "memory",
                reference: record.memory_id,
                title: format!("{} memory", record.layer),
                excerpt: record.summary,
                score,
                session_id: None,
                sequence: None,
            })
        })),
        Err(error) => return storage_error_response(error),
    }
    match storage.radar_items(100, 0) {
        Ok(records) => hits.extend(records.into_iter().filter_map(|record| {
            let score = text_score(
                &query_lower,
                &terms,
                &format!("{} {} {}", record.title, record.source, record.summary),
            );
            (score > 0).then_some(UnifiedSearchHit {
                kind: "radar",
                reference: record.item_id,
                title: record.title,
                excerpt: record.summary,
                score,
                session_id: None,
                sequence: None,
            })
        })),
        Err(error) => return storage_error_response(error),
    }

    hits.sort_by(|left, right| {
        right
            .score
            .cmp(&left.score)
            .then_with(|| left.kind.cmp(right.kind))
            .then_with(|| left.reference.cmp(&right.reference))
    });
    hits.truncate(limit);
    Json(json!({
        "items": hits,
        "sources": {
            "sessions": true,
            "vault": state.vault_dir.is_some(),
            "tasks": state.vault_dir.is_some(),
            "memory": true,
            "radar": true,
        },
    }))
    .into_response()
}

fn text_score(query: &str, terms: &[&str], text: &str) -> usize {
    let text = text.to_lowercase();
    if text == query {
        return 100;
    }
    let matched = terms.iter().filter(|term| text.contains(**term)).count();
    if matched != terms.len() {
        return 0;
    }
    matched
        .saturating_mul(10)
        .saturating_add(usize::from(text.contains(query)).saturating_mul(20))
        .saturating_add(usize::from(text.starts_with(query)).saturating_mul(10))
}

pub(super) async fn list_memory(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let limit = match bounded_usize_query(request.uri().query(), "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let now = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let records = match storage.memory_records(limit + 1, offset, &now) {
        Ok(records) => records,
        Err(error) => return storage_error_response(error),
    };
    let counts = match storage.memory_counts() {
        Ok(counts) => counts,
        Err(error) => return storage_error_response(error),
    };
    let has_more = records.len() > limit;
    Json(json!({
        "records": records.into_iter().take(limit).collect::<Vec<_>>(),
        "counts": counts,
        "architecture": MEMORY_ARCHITECTURE,
        "page": page(limit, offset, has_more),
    }))
    .into_response()
}

pub(super) async fn create_memory(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<MemoryCreate>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let occurred_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let provenance = if payload.provenance.is_empty() {
        "user"
    } else {
        payload.provenance.as_str()
    };
    let content_hash = sha256_hex(payload.summary.as_bytes());
    match storage.create_memory(NewMemoryRecord {
        memory_id: &payload.memory_id,
        kind: &payload.kind,
        summary: &payload.summary,
        provenance,
        data_class: &payload.data_class,
        retention_class: &payload.retention_class,
        expires_at: payload.expires_at.as_deref(),
        run_id: payload.run_id.as_deref(),
        source_id: payload.source_id.as_deref(),
        content_hash: &content_hash,
        occurred_at: &occurred_at,
    }) {
        Ok(record) => (StatusCode::CREATED, Json(record)).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn correct_memory(
    State(state): State<ApiState>,
    Path(memory_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<MemoryCorrection>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let occurred_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let content_hash = sha256_hex(payload.summary.as_bytes());
    match storage.correct_memory(
        &memory_id,
        &payload.expected_content_hash,
        &payload.summary,
        &payload.data_class,
        &content_hash,
        &occurred_at,
    ) {
        Ok(record) => Json(record).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn delete_memory(
    State(state): State<ApiState>,
    Path(memory_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<ExpectedHash>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    match storage.delete_memory(&memory_id, &payload.expected_content_hash) {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn export_memory(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_READ) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<MemoryExport>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.layers.iter().any(|layer| {
        !matches!(
            layer.as_str(),
            "working" | "episodic" | "semantic" | "profile"
        )
    }) {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid memory export layer",
        );
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let now = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let records = match storage.memory_records(100, 0, &now) {
        Ok(records) => records
            .into_iter()
            .filter(|record| {
                payload.layers.contains(&record.layer) && record.retention_class != "protected"
            })
            .collect::<Vec<_>>(),
        Err(error) => return storage_error_response(error),
    };
    let document = json!({"schema_version": 1, "exported_at": now, "records": records});
    let bytes = match serde_json::to_vec(&document) {
        Ok(bytes) => bytes,
        Err(_) => return storage_unavailable(),
    };
    let digest = sha256_hex(&bytes);
    let identity = sha256_hex(format!("{key}:{digest}").as_bytes());
    Json(json!({
        "artifact_ref": format!("memory-export:{}", &identity[..24]),
        "record_count": records.len(),
        "content_hash": digest,
        "document": document,
    }))
    .into_response()
}

pub(super) async fn purge_memory_source(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<SourcePurge>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    match storage.purge_memory_source(&payload.source_id) {
        Ok(deleted) => Json(json!({
            "source_tombstone": sha256_hex(payload.source_id.as_bytes()),
            "deleted_records": deleted,
            "deleted_derived": 0,
        }))
        .into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn list_feature_approvals(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), APPROVALS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let limit = match bounded_usize_query(request.uri().query(), "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let pending_only = single_query_value(request.uri().query(), "pending_only")
        .ok()
        .flatten()
        != Some("false".to_owned());
    match storage.approvals(pending_only, limit + 1, offset) {
        Ok(records) => {
            let has_more = records.len() > limit;
            Json(json!({
                "approvals": records.into_iter().take(limit).collect::<Vec<_>>(),
                "page": page(limit, offset, has_more),
            }))
            .into_response()
        }
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn decide_feature_approval(
    State(state): State<ApiState>,
    Path(approval_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), APPROVALS_DECIDE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let payload = match parse_json::<ApprovalDecision>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let _decided_by = payload.decided_by;
    let decision = match payload.decision.as_str() {
        "approve" | "approved" => "approved",
        "reject" | "rejected" => "rejected",
        _ => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid approval decision",
            );
        }
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let record = match storage.decide_approval(&approval_id, decision) {
        Ok(record) => record,
        Err(error) => return storage_error_response(error),
    };
    if storage.run(&record.run_id).ok().flatten().is_some() {
        let authorization = restork_core::durable_loop::AgentAuthorization {
            approved_tool_calls: if decision == "approved" {
                [approval_id.clone()].into_iter().collect()
            } else {
                BTreeSet::new()
            },
            denied_tool_calls: if decision == "rejected" {
                [approval_id.clone()].into_iter().collect()
            } else {
                BTreeSet::new()
            },
        };
        if let Err(response) = super::spawn_agent_run(state, record.run_id.clone(), authorization) {
            return response;
        }
    }
    Json(record).into_response()
}

pub(super) async fn preview_task_change(
    State(state): State<ApiState>,
    Path(task_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<TaskToggle>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let workspace = match configured_workspace(&state) {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    let tasks = match scan_tasks(&workspace) {
        Ok(tasks) => tasks,
        Err(response) => return response,
    };
    let Some(task) = tasks.into_iter().find(|task| task.task_id == task_id) else {
        return error_response(StatusCode::NOT_FOUND, "task not found");
    };
    let (content, current_hash) = match workspace.read_note(&task.relative_path) {
        Ok(value) => value,
        Err(_) => return error_response(StatusCode::CONFLICT, "task source changed; refresh it"),
    };
    let mut lines = content.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
    let Some(before) = lines.get(task.line_number.saturating_sub(1)).cloned() else {
        return error_response(StatusCode::CONFLICT, "task source changed; refresh it");
    };
    let marker = if payload.completed {
        "- [x] "
    } else {
        "- [ ] "
    };
    let after = format!("{marker}{}", task.text);
    lines[task.line_number - 1] = after.clone();
    let trailing_newline = content.ends_with('\n');
    let mut next_content = lines.join("\n");
    if trailing_newline {
        next_content.push('\n');
    }
    create_task_preview(
        &state,
        &workspace,
        &key,
        &task.task_id,
        &task.relative_path,
        "toggle",
        &before,
        &after,
        &current_hash,
        &next_content,
    )
}

pub(super) async fn preview_task_capture(
    State(state): State<ApiState>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<TaskCapture>(request, 16 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let text = payload.text.trim();
    if text.is_empty()
        || text.len() > 2_000
        || text.contains(['\n', '\r'])
        || payload
            .priority
            .as_deref()
            .is_some_and(|priority| !matches!(priority, "P0" | "P1" | "P2" | "P3"))
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid task capture");
    }
    let workspace = match configured_workspace(&state) {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    let task_id = format!("restork-{}", &sha256_hex(key.as_bytes())[..16]);
    let priority = payload
        .priority
        .as_deref()
        .map(|value| format!(" [priority:: {value}]"))
        .unwrap_or_default();
    let line = format!("- [ ] {text} #todo{priority} ^{task_id}");
    let relative_path = "Restork Tasks.md";
    let (content, current_hash) = match workspace.read_note(relative_path) {
        Ok(value) => value,
        Err(_) => (String::new(), sha256_hex(b"")),
    };
    let mut next_content = content;
    if !next_content.is_empty() && !next_content.ends_with('\n') {
        next_content.push('\n');
    }
    next_content.push_str(&line);
    next_content.push('\n');
    create_task_preview(
        &state,
        &workspace,
        &key,
        &task_id,
        relative_path,
        "capture",
        "",
        &line,
        &current_hash,
        &next_content,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_task_preview(
    state: &ApiState,
    workspace: &SafeWorkspace,
    key: &str,
    task_id: &str,
    relative_path: &str,
    operation: &str,
    before: &str,
    after: &str,
    current_hash: &str,
    next_content: &str,
) -> Response {
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let preview = match workspace.preview_write(relative_path, next_content) {
        Ok(preview) => preview,
        Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "task write is unsafe"),
    };
    let request = json!({
        "relative_path": relative_path,
        "content": next_content,
        "expected_sha256": preview.current_sha256,
        "postimage_hash": preview.next_sha256,
    });
    let action_digest = json_digest(&request);
    let binding = sha256_hex(format!("{key}:{task_id}:{action_digest}").as_bytes());
    let approval_id = format!("task-approval-{}", &binding[..24]);
    if let Ok(Some(existing)) = storage.task_preview(&approval_id) {
        return Json(task_preview_response(&existing)).into_response();
    }
    let nonce = match random_id("nonce") {
        Ok(value) => value,
        Err(response) => return response,
    };
    let created_at = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let expires_at = (Utc::now() + ChronoDuration::minutes(15)).to_rfc3339();
    let stored = match storage.save_task_preview(NewTaskPreview {
        approval_id: &approval_id,
        idempotency_key: key,
        binding: &binding,
        task_id,
        relative_path,
        operation,
        request: &request,
        before_line: before,
        after_line: after,
        expected_hash: current_hash,
        postimage_hash: request["postimage_hash"].as_str().unwrap_or_default(),
        action_digest: &action_digest,
        policy_version: TASK_POLICY_VERSION,
        nonce: &nonce,
        created_at: &created_at,
        expires_at: &expires_at,
    }) {
        Ok(stored) => stored,
        Err(error) => return storage_error_response(error),
    };
    let approval = task_approval(&stored);
    if let Err(error) = storage.save_approval(&approval_id, "task-write", &expires_at, &approval) {
        return storage_error_response(error);
    }
    Json(task_preview_response(&stored)).into_response()
}

pub(super) async fn apply_task_change(
    State(state): State<ApiState>,
    Path(approval_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let _ = match parse_json::<BTreeMap<String, Value>>(request, 8 * 1024).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let preview = match storage.task_preview(&approval_id) {
        Ok(Some(preview)) => preview,
        Ok(None) => {
            return error_response(StatusCode::CONFLICT, "task approval is missing or used");
        }
        Err(error) => return storage_error_response(error),
    };
    let approval = match storage.approval(&approval_id) {
        Ok(Some(approval)) => approval,
        Ok(None) => {
            return error_response(StatusCode::CONFLICT, "task approval is missing");
        }
        Err(error) => return storage_error_response(error),
    };
    if approval.run_id != "task-write"
        || approval.decision != "approved"
        || approval
            .request
            .get("action_digest")
            .and_then(Value::as_str)
            != Some(preview.action_digest.as_str())
    {
        return error_response(
            StatusCode::CONFLICT,
            "task approval is unapproved or does not match the preview",
        );
    }
    if OffsetDateTime::parse(&preview.expires_at, &Rfc3339)
        .ok()
        .is_none_or(|expires| expires <= OffsetDateTime::now_utc())
    {
        return error_response(
            StatusCode::CONFLICT,
            "task approval expired; preview it again",
        );
    }
    if json_digest(&preview.request) != preview.action_digest {
        return error_response(StatusCode::CONFLICT, "task approval digest changed");
    }
    let workspace = match configured_workspace(&state) {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    let content = match preview.request["content"].as_str() {
        Some(content) => content,
        None => return storage_unavailable(),
    };
    let expected = preview.request["expected_sha256"].as_str();
    if let Err(error) = storage.consume_approval(&approval_id) {
        return storage_error_response(error);
    }
    let result = match workspace.apply_write(&preview.relative_path, content, expected) {
        Ok(result) => result,
        Err(_) => {
            return error_response(
                StatusCode::CONFLICT,
                "task source changed; preview it again",
            );
        }
    };
    if result.next_sha256 != preview.postimage_hash {
        return error_response(StatusCode::CONFLICT, "task postimage digest changed");
    }
    if let Err(error) = storage.consume_task_preview(&approval_id) {
        return storage_error_response(error);
    }
    Json(json!({
        "approval_id": approval_id,
        "task_id": preview.task_id,
        "relative_path": preview.relative_path,
        "content_hash": result.next_sha256,
        "applied": true,
    }))
    .into_response()
}

pub(super) async fn configure_radar(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RADAR_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<RadarConfiguration>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let github_discovery = payload.github_discovery || payload.github_user.is_some();
    if payload.enabled && !github_discovery && !payload.hacker_news {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "enable at least one Radar source",
        );
    }
    let now = Utc::now().to_rfc3339();
    let config = json!({
        "enabled": payload.enabled,
        "github_discovery": github_discovery,
        "hacker_news": payload.hacker_news,
    });
    match storage.put_daily_cache("radar-config", &config, &now, "9999-12-31T23:59:59Z", &now) {
        Ok(_) => {
            let _ = storage.clear_daily_cache("radar-feed");
            Json(config).into_response()
        }
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn list_radar(State(state): State<ApiState>, request: Request) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RADAR_READ) {
        return *response;
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let config = match storage.daily_cache("radar-config") {
        Ok(Some(config)) if config.payload["enabled"].as_bool() == Some(true) => config.payload,
        Ok(_) => {
            return Json(json!({
                "configured": false,
                "items": [],
                "page": page(20, 0, false),
            }))
            .into_response();
        }
        Err(error) => return storage_error_response(error),
    };
    let now = Utc::now();
    let feed_fresh = storage
        .daily_cache("radar-feed")
        .ok()
        .flatten()
        .and_then(|cache| cache.expires_at.parse::<chrono::DateTime<Utc>>().ok())
        .is_some_and(|expires| expires > now);
    if !feed_fresh && let Err(detail) = refresh_radar(storage, &config).await {
        let existing = storage.radar_items(1, 0).unwrap_or_default();
        if existing.is_empty() {
            return error_response_owned(StatusCode::BAD_GATEWAY, detail);
        }
    }
    let limit = match bounded_usize_query(request.uri().query(), "limit", 20, 100) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let offset = match offset_query(request.uri().query()) {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.radar_items(limit + 1, offset) {
        Ok(items) => {
            let has_more = items.len() > limit;
            Json(json!({
                "configured": true,
                "items": items.into_iter().take(limit).collect::<Vec<_>>(),
                "page": page(limit, offset, has_more),
            }))
            .into_response()
        }
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn radar_action(
    State(state): State<ApiState>,
    Path(item_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RADAR_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let payload = match parse_json::<RadarAction>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let next = match payload.action.as_str() {
        "dismiss" => "dismissed",
        "read_later" => "read_later",
        "research" => "researched",
        "make_task" => "read_later",
        _ => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid Radar action"),
    };
    let now = Utc::now().to_rfc3339();
    match storage.update_radar_state(&item_id, next, &now) {
        Ok(item) => Json(json!({
            "item": item,
            "run_id": null,
            "research_artifact": null,
            "task_preview_available": payload.action == "make_task",
            "task_approval_id": null,
        }))
        .into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn get_research_artifact(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), MEMORY_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    match storage.research_artifact(&run_id) {
        Ok(Some(mut artifact)) => {
            normalize_research_note_path(&mut artifact, &run_id);
            Json(artifact).into_response()
        }
        Ok(None) => error_response(StatusCode::NOT_FOUND, "research artifact not found"),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn preview_research_note(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let _ = match parse_json::<BTreeMap<String, Value>>(request, 8 * 1024).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let mut artifact = match storage.research_artifact(&run_id) {
        Ok(Some(artifact)) => artifact,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "research artifact not found"),
        Err(error) => return storage_error_response(error),
    };
    normalize_research_note_path(&mut artifact, &run_id);
    let Some(path) = artifact["note_preview"]["relative_path"].as_str() else {
        return storage_unavailable();
    };
    let Some(markdown) = artifact["note_preview"]["markdown"].as_str() else {
        return storage_unavailable();
    };
    let workspace = match configured_workspace(&state) {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    let (before, expected) = match workspace.read_note(path) {
        Ok((content, hash)) => (content, hash),
        Err(_) => (String::new(), sha256_hex(b"")),
    };
    create_task_preview(
        &state,
        &workspace,
        &key,
        artifact["artifact_id"]
            .as_str()
            .unwrap_or("research-artifact"),
        path,
        "research_note",
        &before,
        markdown,
        &expected,
        markdown,
    )
}

pub(super) async fn preview_study_note(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), TASKS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let _ = match parse_json::<BTreeMap<String, Value>>(request, 8 * 1024).await {
        Ok(value) => value,
        Err(response) => return *response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let session = match storage.study_session(&run_id) {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Study session not found"),
        Err(error) => return storage_error_response(error),
    };
    let artifact = &session["artifact"];
    let Some(path) = artifact["note_preview"]["relative_path"].as_str() else {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Study artifact has no note preview",
        );
    };
    let Some(markdown) = artifact["note_preview"]["markdown"].as_str() else {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "Study artifact has no note preview",
        );
    };
    let workspace = match configured_workspace(&state) {
        Ok(workspace) => workspace,
        Err(response) => return response,
    };
    let (before, expected) = match workspace.read_note(path) {
        Ok((content, hash)) => (content, hash),
        Err(_) => (String::new(), sha256_hex(b"")),
    };
    create_task_preview(
        &state,
        &workspace,
        &key,
        artifact["artifact_id"].as_str().unwrap_or("study-artifact"),
        path,
        "study_note",
        &before,
        markdown,
        &expected,
        markdown,
    )
}

async fn refresh_radar(storage: &restork_storage::Database, config: &Value) -> Result<(), String> {
    let gateway = PublicWebGateway::new().map_err(|_| "Radar network gateway is unavailable")?;
    let mut records = Vec::new();
    let now = Utc::now();
    let github_discovery = config["github_discovery"].as_bool() == Some(true)
        // Transparently migrate existing local configurations that used a username.
        || config["github_user"].as_str().is_some();
    if github_discovery {
        let mut candidates = BTreeMap::<String, Value>::new();
        let mut successful_queries = 0_u8;
        let mut last_error = None;
        for url in github_discovery_urls(now) {
            match gateway.get_json(url.as_str()).await {
                Ok(payload) => {
                    successful_queries = successful_queries.saturating_add(1);
                    for item in payload["items"].as_array().into_iter().flatten() {
                        if let Some(repository) = item["full_name"].as_str() {
                            candidates
                                .entry(repository.to_ascii_lowercase())
                                .or_insert_with(|| item.clone());
                        }
                    }
                }
                Err(error) => last_error = Some(error.status()),
            }
        }
        if successful_queries == 0 {
            return Err(format!(
                "GitHub public AI/Agent Radar refresh failed ({})",
                last_error.unwrap_or("unavailable")
            ));
        }
        let mut github_records = candidates
            .values()
            .filter_map(github_radar_record)
            .collect::<Vec<_>>();
        github_records.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.title.cmp(&right.title))
        });
        github_records.truncate(12);
        records.extend(github_records);
    }
    if config["hacker_news"].as_bool() == Some(true) {
        let ids = gateway
            .get_json("https://hacker-news.firebaseio.com/v0/topstories.json")
            .await
            .map_err(|error| format!("Hacker News Radar refresh failed ({})", error.status()))?;
        let futures = ids
            .as_array()
            .into_iter()
            .flatten()
            .take(12)
            .filter_map(Value::as_u64)
            .map(|id| {
                let gateway = gateway.clone();
                async move {
                    gateway
                        .get_json(&format!(
                            "https://hacker-news.firebaseio.com/v0/item/{id}.json"
                        ))
                        .await
                }
            });
        for item in join_all(futures).await.into_iter().flatten() {
            let Some(id) = item["id"].as_u64() else {
                continue;
            };
            let title = item["title"].as_str().unwrap_or("Hacker News item");
            records.push(NewRadarOwned {
                item_id: format!("hn-{id}"),
                lane: "hn".to_owned(),
                title: title.to_owned(),
                source: "hacker-news".to_owned(),
                url: item["url"]
                    .as_str()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("https://news.ycombinator.com/item?id={id}")),
                summary: format!(
                    "{} points · {} comments",
                    item["score"].as_u64().unwrap_or(0),
                    item["descendants"].as_u64().unwrap_or(0)
                ),
                score: item["score"].as_f64().unwrap_or(0.0),
                stars_total: None,
                published_at: item["time"]
                    .as_i64()
                    .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                    .map(|value| value.to_rfc3339()),
            });
        }
    }
    let occurred_at = now.to_rfc3339();
    if github_discovery {
        storage
            .delete_radar_lane("my_stars")
            .map_err(|_| "Legacy personal Stars could not be removed".to_owned())?;
    }
    for item in &records {
        if item.url.starts_with("https://") {
            storage
                .upsert_radar(NewRadarRecord {
                    item_id: &item.item_id,
                    lane: &item.lane,
                    title: &item.title,
                    source: &item.source,
                    url: &item.url,
                    summary: &item.summary,
                    score: item.score,
                    stars_total: item.stars_total,
                    published_at: item.published_at.as_deref(),
                    state: "new",
                    data_class: "public",
                    occurred_at: &occurred_at,
                })
                .map_err(|_| "Radar cache could not be updated".to_owned())?;
        }
    }
    if github_discovery {
        storage
            .delete_stale_new_radar_lane("trending", &occurred_at)
            .map_err(|_| "GitHub Radar cache could not be pruned".to_owned())?;
    }
    if config["hacker_news"].as_bool() == Some(true) {
        storage
            .delete_stale_new_radar_lane("hn", &occurred_at)
            .map_err(|_| "Hacker News Radar cache could not be pruned".to_owned())?;
    }
    storage
        .put_daily_cache(
            "radar-feed",
            &json!({"count": records.len()}),
            &occurred_at,
            &(now + ChronoDuration::minutes(30)).to_rfc3339(),
            &occurred_at,
        )
        .map_err(|_| "Radar TTL cache could not be updated".to_owned())?;
    Ok(())
}

fn configured_workspace(state: &ApiState) -> Result<SafeWorkspace, Response> {
    let root = state.vault_dir.as_deref().ok_or_else(|| {
        error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is not configured")
    })?;
    SafeWorkspace::open(root.as_path())
        .map_err(|_| error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"))
}

pub(super) fn scan_tasks(workspace: &SafeWorkspace) -> Result<Vec<MarkdownTask>, Response> {
    let paths = workspace
        .markdown_paths(4_000)
        .map_err(|_| error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault scan failed"))?;
    let mut tasks = Vec::new();
    for path in paths {
        let Ok((content, _)) = workspace.read_note(&path) else {
            continue;
        };
        for (index, line) in content.lines().enumerate() {
            let (completed, body) = if let Some(body) = line.strip_prefix("- [ ] ") {
                (false, body)
            } else if let Some(body) = line
                .strip_prefix("- [x] ")
                .or_else(|| line.strip_prefix("- [X] "))
            {
                (true, body)
            } else {
                continue;
            };
            let block_id = body
                .split_whitespace()
                .last()
                .and_then(|value| value.strip_prefix('^'))
                .filter(|value| valid_task_id(value))
                .map(ToOwned::to_owned);
            let locator_hash = sha256_hex(normalize_task_text(body).as_bytes());
            let task_id = block_id
                .clone()
                .unwrap_or_else(|| format!("external-{}", &locator_hash[..24]));
            tasks.push(MarkdownTask {
                task_id,
                relative_path: path.clone(),
                line_number: index + 1,
                text: body.to_owned(),
                completed,
                fields: task_fields(body),
                block_id,
                locator_hash,
            });
        }
    }
    Ok(tasks)
}

fn task_fields(body: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut rest = body;
    while let Some(start) = rest.find('[') {
        rest = &rest[start + 1..];
        let Some(end) = rest.find(']') else {
            break;
        };
        let candidate = &rest[..end];
        if let Some((name, value)) = candidate.split_once(":: ")
            && !name.is_empty()
            && name.bytes().all(|byte| byte.is_ascii_lowercase())
        {
            fields.insert(name.to_owned(), value.to_owned());
        }
        rest = &rest[end + 1..];
    }
    fields
}

fn valid_task_id(value: &str) -> bool {
    value.strip_prefix("restork-").is_some_and(|suffix| {
        !suffix.is_empty()
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    })
}

fn normalize_task_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn task_preview_response(preview: &restork_storage::TaskPreviewRecord) -> Value {
    json!({
        "task_id": preview.task_id,
        "relative_path": preview.relative_path,
        "before_line": preview.before_line,
        "after_line": preview.after_line,
        "expected_hash": preview.expected_hash,
        "postimage_hash": preview.postimage_hash,
        "approval": task_approval(preview),
    })
}

fn task_approval(preview: &restork_storage::TaskPreviewRecord) -> Value {
    json!({
        "approval_id": preview.approval_id,
        "run_id": "task-write",
        "action_kind": "vault_write",
        "risk_class": "local_file_write",
        "human_summary": format!("Apply the reviewed Markdown task change to {}?", preview.relative_path),
        "action_digest": preview.action_digest,
        "canonical_scope": preview.relative_path,
        "resource_versions": {"before": preview.expected_hash, "after": preview.postimage_hash},
        "policy_version": preview.policy_version,
        "preview_ref": format!("task-preview:{}", preview.approval_id),
        "nonce": preview.nonce,
        "expires_at": preview.expires_at,
        "decision": "pending",
    })
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

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) async fn prepare_study(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let payload = match parse_json::<StudyDiagnosticRequest>(request, 32 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.objective.trim().is_empty()
        || payload.objective.len() > 8_000
        || payload
            .target_note
            .as_ref()
            .is_some_and(|path| path.is_empty() || path.len() > 4_096)
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid Study objective");
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    if let Ok(Some(existing)) = storage.study_session(&run_id)
        && existing["diagnostic"]["status"].as_str() == Some("ready")
    {
        return Json(existing["diagnostic"].clone()).into_response();
    }
    let run = match storage.run(&run_id) {
        Ok(Some(run)) if run.mode == "study" && run.state == "proposed" => run,
        Ok(Some(run)) if run.mode == "study" => {
            return error_response_owned(
                StatusCode::CONFLICT,
                format!("Study run is already {}", run.state),
            );
        }
        Ok(Some(_)) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "the selected run is not a Study run",
            );
        }
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "run not found"),
        Err(error) => return storage_error_response(error),
    };
    let Some(root) = state.vault_dir.as_deref() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "Study requires an explicitly configured Obsidian Vault",
        );
    };
    let workspace = match SafeWorkspace::open(root) {
        Ok(workspace) => workspace,
        Err(_) => return error_response(StatusCode::SERVICE_UNAVAILABLE, "Vault is unavailable"),
    };
    let hits = workspace
        .search_notes(&payload.objective, 8)
        .unwrap_or_default();
    let target = if let Some(path) = payload.target_note.as_deref() {
        match workspace.read_note(path) {
            Ok((content, hash)) => Some(json!({
                "relative_path": path,
                "sha256": hash,
                "excerpt": content.chars().take(4_000).collect::<String>(),
            })),
            Err(_) => {
                return error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "the selected Study note is unavailable or unsafe",
                );
            }
        }
    } else {
        None
    };
    let request_value = serde_json::to_value(&payload).unwrap_or(Value::Null);
    let request_hash = sha256_hex(&serde_json::to_vec(&request_value).unwrap_or_default());
    let pending = json!({
        "diagnostic_id": format!("study-diagnostic-{}", &request_hash[..24]),
        "run_id": run_id,
        "objective": payload.objective,
        "target_note": payload.target_note,
        "questions": [],
        "status": "pending",
        "created_at": Utc::now().to_rfc3339(),
    });
    if let Err(error) = storage.save_study_session(
        &run_id,
        &request_hash,
        &request_value,
        &pending,
        None,
        &Utc::now().to_rfc3339(),
    ) {
        return storage_error_response(error);
    }
    let mut task_spec = run.task_spec.clone();
    task_spec["goal"] = Value::String(format!(
        "Create a diagnostic-first Study intake for this objective: {}. Use vault_search before composing. Do not reveal answers. Return only JSON with `questions`, where each question has `prompt` and `response_kind` (`text` or `rating`). Vault search seed evidence: {}. Explicit target note: {}.",
        payload.objective,
        serde_json::to_string(&hits).unwrap_or_default(),
        target.map_or_else(|| "none".to_owned(), |value| value.to_string()),
    ));
    task_spec["study_request_hash"] = Value::String(request_hash);
    if let Err(error) = storage.replace_proposed_run_task_spec(
        &run_id,
        run.state_version,
        &task_spec,
        &Utc::now().to_rfc3339(),
    ) {
        return storage_error_response(error);
    }
    if let Err(response) = super::spawn_agent_run(
        state.clone(),
        run_id.clone(),
        restork_core::durable_loop::AgentAuthorization::default(),
    ) {
        return response;
    }
    for _ in 0..600 {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        if let Ok(Some(session)) = storage.study_session(&run_id) {
            match session["diagnostic"]["status"].as_str() {
                Some("ready") => return Json(session["diagnostic"].clone()).into_response(),
                Some("invalid_output") => {
                    return error_response(
                        StatusCode::BAD_GATEWAY,
                        "the configured model did not return a valid Study diagnostic",
                    );
                }
                _ => {}
            }
        }
        if let Ok(Some(run)) = storage.run(&run_id)
            && matches!(run.state.as_str(), "failed" | "cancelled" | "retryable")
        {
            return error_response_owned(
                StatusCode::BAD_GATEWAY,
                format!(
                    "Study diagnostic stopped: {}",
                    run.stop_reason.unwrap_or(run.state)
                ),
            );
        }
    }
    error_response(
        StatusCode::GATEWAY_TIMEOUT,
        "Study diagnostic exceeded its bounded wait; follow the durable run and retry",
    )
}

pub(super) async fn submit_study_path(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    if let Err(response) = require_idempotency_key(request.headers()) {
        return response;
    }
    let payload = match parse_json::<StudyPathRequest>(request, 64 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.answers.is_empty()
        || payload.answers.len() > 20
        || payload.answers.iter().any(|(id, answer)| {
            id.is_empty() || id.len() > 256 || answer.trim().is_empty() || answer.len() > 8_000
        })
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid Study answers");
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let session = match storage.study_session(&run_id) {
        Ok(Some(session)) if session["diagnostic"]["status"] == "ready" => session,
        Ok(Some(_)) => {
            return error_response(StatusCode::CONFLICT, "Study diagnostic is not ready");
        }
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Study diagnostic not found"),
        Err(error) => return storage_error_response(error),
    };
    if session["diagnostic_submitted"].as_bool() == Some(true) {
        return Json(session["artifact"].clone()).into_response();
    }
    let run = match storage.run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "run not found"),
        Err(error) => return storage_error_response(error),
    };
    let profile_id = run.task_spec["provider_profile_id"]
        .as_str()
        .unwrap_or("deepseek");
    let profile = match super::configured_provider(&state, profile_id) {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "provider is not configured"),
        Err(response) => return response,
    };
    let Some(provider) = state.provider.as_ref() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable",
        );
    };
    let vault_evidence = study_vault_evidence(
        &state,
        session["request"]["objective"].as_str().unwrap_or_default(),
    );
    let prompt = format!(
        "Build and grade a grounded learning path. Return only JSON with: readiness_signal (foundation/developing/ready), objective {{outcome}}, prerequisites (title, relative_path), learning_path (title, outcome), and exercises (kind, prompt, hints, grading_rubric). Do not include answer keys. Diagnostic: {}. Learner answers: {}. Vault evidence: {}",
        session["diagnostic"],
        serde_json::to_string(&payload.answers).unwrap_or_default(),
        vault_evidence,
    );
    let completion = match provider
        .chat(
            &profile,
            &[
                restork_provider::ChatMessage::text(
                    "system",
                    "You are Restork Study. Grade with the configured model, ground claims in the supplied Vault evidence, and never echo the learner's raw answers. Write all feedback in the same language as the learner's goal and answers.",
                ),
                restork_provider::ChatMessage::text("user", prompt),
            ],
            8_192,
        )
        .await
    {
        Ok(completion) => completion,
        Err(error) => {
            return error_response_owned(
                StatusCode::BAD_GATEWAY,
                format!("Study model call failed: {}", error.status()),
            );
        }
    };
    let Some(parsed) = parse_model_json(&completion.content) else {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "the configured model returned an invalid Study path",
        );
    };
    let (artifact, rubrics) =
        match normalize_study_artifact(&run_id, &session, &parsed, &vault_evidence) {
            Some(value) => value,
            None => {
                return error_response(
                    StatusCode::BAD_GATEWAY,
                    "the configured model returned an unsafe or incomplete Study path",
                );
            }
        };
    let submission_hash = sha256_hex(&serde_json::to_vec(&payload.answers).unwrap_or_default());
    match storage.save_study_artifact(
        &run_id,
        &submission_hash,
        &artifact,
        &rubrics,
        &Utc::now().to_rfc3339(),
    ) {
        Ok(artifact) => Json(artifact).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn submit_study_attempt(
    State(state): State<ApiState>,
    Path((run_id, exercise_id)): Path<(String, String)>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<StudyAttemptRequest>(request, 16 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if payload.answer.trim().is_empty()
        || payload.answer.len() > 8_000
        || !(1..=5).contains(&payload.confidence)
    {
        return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid Study attempt");
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let rubric = match storage.study_exercise(&run_id, &exercise_id) {
        Ok(Some(rubric)) => rubric,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Study exercise not found"),
        Err(error) => return storage_error_response(error),
    };
    let run = match storage.run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "run not found"),
        Err(error) => return storage_error_response(error),
    };
    let profile_id = run.task_spec["provider_profile_id"]
        .as_str()
        .unwrap_or("deepseek");
    let profile = match super::configured_provider(&state, profile_id) {
        Ok(Some(profile)) => profile,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "provider is not configured"),
        Err(response) => return response,
    };
    let Some(provider) = state.provider.as_ref() else {
        return error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "provider runtime is unavailable",
        );
    };
    let completion = match provider
        .chat(
            &profile,
            &[
                restork_provider::ChatMessage::text(
                    "system",
                    "Grade one Study response against the supplied rubric. Return only JSON with boolean `correct` and concise `feedback`. Never repeat the learner's full answer. Write `feedback` in the same language as the learner's answer.",
                ),
                restork_provider::ChatMessage::text(
                    "user",
                    format!("Rubric: {rubric}. Learner answer: {}", payload.answer),
                ),
            ],
            1_024,
        )
        .await
    {
        Ok(completion) => completion,
        Err(error) => {
            return error_response_owned(
                StatusCode::BAD_GATEWAY,
                format!("Study grading failed: {}", error.status()),
            );
        }
    };
    let Some(parsed) = parse_model_json(&completion.content) else {
        return error_response(
            StatusCode::BAD_GATEWAY,
            "Study grader returned invalid JSON",
        );
    };
    let Some(correct) = parsed["correct"].as_bool() else {
        return error_response(StatusCode::BAD_GATEWAY, "Study grader omitted its verdict");
    };
    let feedback = bounded_model_text(&parsed["feedback"], 2_000)
        .unwrap_or_else(|| "The grader did not provide bounded feedback.".to_owned());
    let (attempt_count, error_count) = storage
        .study_attempt_counts(&run_id, &exercise_id)
        .unwrap_or_default();
    let next_attempt = attempt_count + 1;
    let next_errors = error_count + i64::from(!correct);
    let interval_days = if correct {
        i64::from(payload.confidence).clamp(1, 5)
    } else {
        0
    };
    let due_at = if correct {
        Utc::now() + ChronoDuration::days(interval_days)
    } else {
        Utc::now() + ChronoDuration::minutes(10)
    };
    let answer_hash = sha256_hex(payload.answer.as_bytes());
    let binding = sha256_hex(format!("{key}\0{run_id}\0{exercise_id}\0{answer_hash}").as_bytes());
    let attempt_id = format!("study-attempt-{}", &binding[..24]);
    let result = json!({
        "attempt_id": attempt_id,
        "run_id": run_id,
        "exercise_id": exercise_id,
        "correct": correct,
        "feedback": feedback,
        "error_count": next_errors,
        "attempt_count": next_attempt,
        "next_review": {
            "action": if correct {"spaced_review"} else {"retry_with_hint"},
            "due_at": due_at.to_rfc3339(),
            "interval_days": interval_days,
            "reason": if correct {"The model-graded response is scheduled for spaced review."} else {"Retry after reviewing the supplied hint; no answer key is revealed."},
        },
        "record_preview": null,
        "created_at": Utc::now().to_rfc3339(),
    });
    match storage.save_study_attempt(
        &attempt_id,
        &run_id,
        &exercise_id,
        &key,
        &binding,
        &answer_hash,
        correct,
        &result,
        &due_at.to_rfc3339(),
        interval_days,
        &Utc::now().to_rfc3339(),
    ) {
        Ok(result) => Json(result).into_response(),
        Err(error) => storage_error_response(error),
    }
}

fn study_vault_evidence(state: &ApiState, objective: &str) -> Value {
    let Some(root) = state.vault_dir.as_deref() else {
        return Value::Array(Vec::new());
    };
    let Ok(workspace) = SafeWorkspace::open(root) else {
        return Value::Array(Vec::new());
    };
    serde_json::to_value(workspace.search_notes(objective, 12).unwrap_or_default())
        .unwrap_or_else(|_| Value::Array(Vec::new()))
}

fn normalize_study_artifact(
    run_id: &str,
    session: &Value,
    parsed: &Value,
    evidence: &Value,
) -> Option<(Value, Vec<(String, Value)>)> {
    let readiness = parsed["readiness_signal"].as_str()?;
    if !matches!(readiness, "foundation" | "developing" | "ready") {
        return None;
    }
    let outcome = bounded_model_text(&parsed["objective"]["outcome"], 2_000)?;
    let allowed_notes = evidence
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["relative_path"].as_str())
        .collect::<BTreeSet<_>>();
    let prerequisites = parsed["prerequisites"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let path = item["relative_path"].as_str()?;
            if !allowed_notes.contains(path) {
                return None;
            }
            Some(json!({
                "relative_path": path,
                "title": bounded_model_text(&item["title"], 240)?,
                "rationale": bounded_model_text(&item["rationale"], 1_000)
                    .unwrap_or_else(|| "Grounded in the selected Vault evidence.".to_owned()),
                "explicit_source": "prerequisite_section",
            }))
        })
        .take(20)
        .collect::<Vec<_>>();
    let mut path = Vec::new();
    for (index, item) in parsed["learning_path"]
        .as_array()?
        .iter()
        .take(24)
        .enumerate()
    {
        let title = bounded_model_text(&item["title"], 240)?;
        let step_outcome = bounded_model_text(&item["outcome"], 2_000)?;
        let refs = item["note_refs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|reference| allowed_notes.contains(*reference))
            .take(20)
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>();
        path.push(json!({
            "step_id": format!("study-step-{}", &sha256_hex(format!("{run_id}\0{}\0{title}", index + 1).as_bytes())[..24]),
            "order": index + 1,
            "title": title,
            "outcome": step_outcome,
            "note_refs": refs,
        }));
    }
    if path.is_empty() {
        return None;
    }
    let mut exercises = Vec::new();
    let mut rubrics = Vec::new();
    for (index, item) in parsed["exercises"].as_array()?.iter().take(20).enumerate() {
        let prompt = bounded_model_text(&item["prompt"], 2_000)?;
        let concept = bounded_model_text(&item["concept"], 240)
            .unwrap_or_else(|| "Grounded practice".to_owned());
        let kind = item["kind"].as_str().unwrap_or("active_recall");
        if !matches!(kind, "active_recall" | "application") {
            return None;
        }
        let grading_rubric = bounded_model_text(&item["grading_rubric"], 2_000)?;
        let exercise_id = format!(
            "study-exercise-{}",
            &sha256_hex(format!("{run_id}\0{}\0{prompt}", index + 1).as_bytes())[..24]
        );
        let hints = item["hints"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|hint| bounded_model_text(hint, 500))
            .take(5)
            .collect::<Vec<_>>();
        rubrics.push((
            exercise_id.clone(),
            json!({
                "prompt": prompt,
                "concept": concept,
                "grading_rubric": grading_rubric,
            }),
        ));
        exercises.push(json!({
            "exercise_id": exercise_id,
            "concept": concept,
            "kind": kind,
            "prompt": prompt,
            "hints": hints,
            "answer_revealed": false,
        }));
    }
    if exercises.is_empty() {
        return None;
    }
    let related_notes = evidence
        .as_array()
        .into_iter()
        .flatten()
        .take(20)
        .filter_map(|item| {
            let path = item["relative_path"].as_str()?;
            Some(json!({
                "relative_path": path,
                "title": FsPath::new(path).file_stem()?.to_string_lossy(),
            }))
        })
        .collect::<Vec<_>>();
    let objective_id = format!("study-objective-{}", &sha256_hex(outcome.as_bytes())[..24]);
    let artifact_id = format!(
        "study-artifact-{}",
        &sha256_hex(format!("{run_id}\0{objective_id}").as_bytes())[..24]
    );
    let prerequisite_ratio = if prerequisites.is_empty() { 0.0 } else { 1.0 };
    let note_markdown = study_note_markdown(
        &outcome,
        readiness,
        &parsed["objective"]["success_criteria"],
        &prerequisites,
        &path,
        &exercises,
        &related_notes,
    );
    let note_path = format!("Restork Study - {}.md", study_note_slug(&outcome, run_id));
    let artifact = json!({
        "artifact_id": artifact_id,
        "run_id": run_id,
        "readiness_signal": readiness,
        "objective": {
            "objective_id": objective_id,
            "outcome": outcome,
            "success_criteria": parsed["objective"]["success_criteria"].as_array().into_iter().flatten().filter_map(|value| bounded_model_text(value, 1_000)).take(20).collect::<Vec<_>>(),
        },
        "prerequisites": prerequisites,
        "related_notes": related_notes,
        "learning_path": path,
        "exercises": exercises,
        "note_preview": {
            "action": "create",
            "relative_path": note_path,
            "expected_hash": null,
            "markdown_hash": sha256_hex(note_markdown.as_bytes()),
            "markdown": note_markdown,
        },
        "metrics": {
            "diagnostic_completed": true,
            "explicit_prerequisite_ratio": prerequisite_ratio,
            "practice_count": rubrics.len(),
            "related_note_count": evidence.as_array().map_or(0, Vec::len),
        },
        "sensitivity": "personal",
        "created_at": Utc::now().to_rfc3339(),
        "validation": {"status": "validated", "mechanism": "model_grade_plus_vault_refs"},
        "synthesizer": session["diagnostic"]["synthesizer"],
    });
    Some((artifact, rubrics))
}

/// Render the Markdown note that mirrors a validated Study artifact into the
/// Vault. Only artifact-grounded fields are written; answer keys stay in the
/// app and are never part of the note.
fn study_note_markdown(
    outcome: &str,
    readiness: &str,
    success_criteria: &Value,
    prerequisites: &[Value],
    path: &[Value],
    exercises: &[Value],
    related_notes: &[Value],
) -> String {
    let mut note = format!(
        "# Restork Study: {outcome}\n\n> Generated by Restork Study · Readiness: {readiness}\n"
    );
    let criteria = success_criteria
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    if !criteria.is_empty() {
        note.push_str("\n## Success criteria\n");
        for criterion in criteria {
            note.push_str(&format!("- {criterion}\n"));
        }
    }
    if !prerequisites.is_empty() {
        note.push_str("\n## Prerequisites\n");
        for item in prerequisites {
            let title = item["title"].as_str().unwrap_or("Vault note");
            let relative_path = item["relative_path"].as_str().unwrap_or_default();
            let rationale = item["rationale"].as_str().unwrap_or_default();
            note.push_str(&format!(
                "- [[{title}]] (`{relative_path}`) — {rationale}\n"
            ));
        }
    }
    note.push_str("\n## Learning path\n");
    for step in path {
        let order = step["order"].as_u64().unwrap_or(0);
        let title = step["title"].as_str().unwrap_or("Step");
        let step_outcome = step["outcome"].as_str().unwrap_or_default();
        note.push_str(&format!("{order}. **{title}** — {step_outcome}\n"));
        let refs = step["note_refs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(|reference| format!("`{reference}`"))
            .collect::<Vec<_>>();
        if !refs.is_empty() {
            note.push_str(&format!("   - Notes: {}\n", refs.join(", ")));
        }
    }
    note.push_str("\n## Exercises\n");
    for exercise in exercises {
        let kind = exercise["kind"].as_str().unwrap_or("active_recall");
        let prompt = exercise["prompt"].as_str().unwrap_or_default();
        let concept = exercise["concept"].as_str().unwrap_or_default();
        note.push_str(&format!("- [{kind}] {prompt} — concept: {concept}\n"));
        for hint in exercise["hints"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            note.push_str(&format!("  - Hint: {hint}\n"));
        }
    }
    if !related_notes.is_empty() {
        note.push_str("\n## Related notes\n");
        for item in related_notes {
            let title = item["title"].as_str().unwrap_or("Vault note");
            let relative_path = item["relative_path"].as_str().unwrap_or_default();
            note.push_str(&format!("- [[{title}]] (`{relative_path}`)\n"));
        }
    }
    note
}

pub(super) async fn plan_work(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    let idempotency_key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<WorkStart>(request, 128 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    if let Err(detail) = validate_work_start(&payload) {
        return error_response_owned(StatusCode::UNPROCESSABLE_ENTITY, detail);
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let run = match storage.run(&run_id) {
        Ok(Some(run)) if run.mode == "work" => run,
        Ok(Some(_)) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "the selected run is not a Work run",
            );
        }
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "run not found"),
        Err(error) => return storage_error_response(error),
    };
    let mut request_value = match serde_json::to_value(&payload) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    let request_hash = sha256_hex(
        serde_json::to_vec(&request_value)
            .unwrap_or_default()
            .as_slice(),
    );
    if let Ok(Some(existing)) = storage.work_session(&run_id) {
        if existing["request_hash"].as_str() == Some(&request_hash) {
            return Json(existing["plan"].clone()).into_response();
        }
        return error_response(
            StatusCode::CONFLICT,
            "this Work run already froze a different workspace request",
        );
    }
    let (workspace_root, grant_file) = match resolve_work_root(&payload) {
        Ok(value) => value,
        Err(detail) => return error_response_owned(StatusCode::UNPROCESSABLE_ENTITY, detail),
    };
    if let Some(request) = request_value.as_object_mut() {
        request.insert(
            "workspace_root".to_owned(),
            Value::String(workspace_root.to_string_lossy().into_owned()),
        );
        request.remove("workspace_grant_id");
    }
    let workspace = match SafeWorkspace::open(&workspace_root) {
        Ok(workspace) => workspace,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "workspace root must be an existing readable directory without a symlink boundary",
            );
        }
    };
    let snapshot = match workspace.work_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "workspace exceeds the bounded read-only inspection policy",
            );
        }
    };
    let target_files = match canonical_work_paths(&workspace, &payload.target_files) {
        Ok(paths) => paths,
        Err(detail) => return error_response_owned(StatusCode::UNPROCESSABLE_ENTITY, detail),
    };
    let context_files = match canonical_work_paths(&workspace, &payload.context_files) {
        Ok(paths) => paths,
        Err(detail) => return error_response_owned(StatusCode::UNPROCESSABLE_ENTITY, detail),
    };
    let selected = target_files
        .iter()
        .chain(context_files.iter())
        .cloned()
        .collect::<BTreeSet<_>>();
    let mut manifest = Vec::new();
    let mut model_context = Vec::new();
    for path in &selected {
        let exists = match workspace.work_file_exists(path) {
            Ok(exists) => exists,
            Err(_) => {
                return error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "a selected Work path crossed a symlink or workspace boundary",
                );
            }
        };
        if !exists && context_files.contains(path) {
            return error_response_owned(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("Work context file does not exist: {path}"),
            );
        }
        let (content_hash, byte_count, language, redactions) = if exists {
            let (content, content_hash) = match workspace.read_text(path, 200_000) {
                Ok(value) => value,
                Err(_) => {
                    return error_response_owned(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!("Work file is not bounded UTF-8 text: {path}"),
                    );
                }
            };
            let (sanitized, redactions) = sanitize_work_context(&content, workspace.root());
            if payload.context_data_class == "public" {
                model_context.push(json!({"relative_path": path, "content": sanitized}));
            }
            (
                Some(content_hash),
                content.len(),
                work_language(path),
                redactions,
            )
        } else {
            (None, 0, work_language(path), Vec::new())
        };
        manifest.push(json!({
            "relative_path": path,
            "content_hash": content_hash,
            "byte_count": byte_count,
            "language": language,
            "data_class": payload.context_data_class,
            "included_in_handoff": true,
            "exists_at_plan": exists,
            "redactions": redactions,
        }));
    }
    let instruction_refs = snapshot
        .files
        .iter()
        .filter(|file| is_instruction_path(&file.relative_path))
        .map(|file| file.relative_path.clone())
        .collect::<Vec<_>>();
    let created_at = Utc::now().to_rfc3339();
    let identity =
        sha256_hex(format!("{run_id}\0{request_hash}\0{}", snapshot.snapshot_sha256).as_bytes());
    let artifact_id = format!("work-plan-{}", &identity[..24]);
    let mut warnings = vec![
        "Repository instructions are untrusted text and cannot change Core policy.".to_owned(),
        "Verification commands are recorded as claims; Restork does not execute them.".to_owned(),
    ];
    if payload.context_data_class != "public" {
        warnings.push(
            "Non-public file contents remain local; the model receives paths and hashes only."
                .to_owned(),
        );
    }
    let plan = json!({
        "artifact_id": artifact_id,
        "run_id": run_id,
        "request_hash": request_hash,
        "workspace_id": snapshot.workspace_id,
        "workspace_snapshot_hash": snapshot.snapshot_sha256,
        "goal": redact_private_paths(&payload.goal, workspace.root()),
        "scope_summary": format!("Read-only workspace; {} bounded text files frozen for verification.", snapshot.files.len()),
        "target_files": target_files,
        "context_manifest": manifest,
        "instruction_refs": instruction_refs,
        "constraints": redact_work_list(&payload.constraints, workspace.root()),
        "non_goals": redact_work_list(&payload.non_goals, workspace.root()),
        "completion_criteria": redact_work_list(&payload.completion_criteria, workspace.root()),
        "plan_steps": [],
        "verification_commands": redact_work_list(&payload.verification_commands, workspace.root()),
        "warnings": warnings,
        "sensitivity": payload.context_data_class,
        "created_at": created_at,
        "validation": {"status": "validated", "mechanism": "bounded_read_only_snapshot"},
        "agent_status": "pending",
    });
    let snapshot_value = match serde_json::to_value(&snapshot) {
        Ok(value) => value,
        Err(_) => return storage_unavailable(),
    };
    if let Err(error) = storage.save_work_session(
        &run_id,
        &request_hash,
        &request_value,
        &plan,
        &snapshot_value,
        &created_at,
    ) {
        return storage_error_response(error);
    }
    let mut task_spec = run.task_spec.clone();
    task_spec["goal"] = Value::String(work_agent_goal(
        &payload,
        &plan,
        &model_context,
        workspace.root(),
    ));
    task_spec["work_request_hash"] = Value::String(request_hash);
    task_spec["work_plan_artifact_id"] = plan["artifact_id"].clone();
    if let Err(error) =
        storage.replace_proposed_run_task_spec(&run_id, run.state_version, &task_spec, &created_at)
    {
        return storage_error_response(error);
    }
    if let Err(response) = super::spawn_agent_run(
        state,
        run_id,
        restork_core::durable_loop::AgentAuthorization::default(),
    ) {
        return response;
    }
    if let Some(path) = grant_file {
        let _ = fs::remove_file(path);
    }
    let _ = idempotency_key;
    (StatusCode::ACCEPTED, Json(plan)).into_response()
}

pub(super) async fn preview_work_handoff(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let session = match storage.work_session(&run_id) {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Work plan not found"),
        Err(error) => return storage_error_response(error),
    };
    if session["plan"]["agent_status"].as_str() != Some("ready") {
        return error_response(
            StatusCode::CONFLICT,
            "the agent-authored Work plan is not ready yet; follow the run stream and retry",
        );
    }
    let root = session["request"]["workspace_root"]
        .as_str()
        .unwrap_or_default();
    let workspace = match SafeWorkspace::open(root) {
        Ok(workspace) => workspace,
        Err(_) => return error_response(StatusCode::CONFLICT, "Work workspace is unavailable"),
    };
    let contexts = match frozen_work_context(&workspace, &session["plan"]["context_manifest"]) {
        Ok(contexts) => contexts,
        Err(detail) => return error_response_owned(StatusCode::CONFLICT, detail),
    };
    let created_at = Utc::now();
    let handoff_id = format!(
        "work-handoff-{}",
        &sha256_hex(format!("{}\0{key}", session["plan"]["artifact_id"]).as_bytes())[..24]
    );
    let envelope = json!({
        "handoff_id": handoff_id,
        "run_id": run_id,
        "plan_ref": session["plan"]["artifact_id"],
        "workspace_id": session["plan"]["workspace_id"],
        "base_snapshot_hash": session["plan"]["workspace_snapshot_hash"],
        "goal": session["plan"]["goal"],
        "target_files": session["plan"]["target_files"],
        "constraints": session["plan"]["constraints"],
        "non_goals": session["plan"]["non_goals"],
        "completion_criteria": session["plan"]["completion_criteria"],
        "proposed_verification_commands": session["plan"]["verification_commands"],
        "context": contexts,
        "executor_boundary": "external_user_started_no_restork_executor",
        "created_at": created_at.to_rfc3339(),
        "validation": {"status": "validated", "mechanism": "frozen_context_hashes"},
    });
    let bytes = match serde_json::to_vec(&envelope) {
        Ok(bytes) if bytes.len() <= 2_000_000 => bytes,
        _ => {
            return error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "Work handoff exceeds the private export limit",
            );
        }
    };
    let package_hash = sha256_hex(&bytes);
    let approval_id = format!(
        "work-approval-{}",
        &sha256_hex(format!("{key}\0{package_hash}").as_bytes())[..24]
    );
    let nonce = sha256_hex(format!("nonce\0{approval_id}").as_bytes());
    let expires_at = (created_at + ChronoDuration::minutes(10)).to_rfc3339();
    let artifact_ref = format!("work-handoffs/{handoff_id}.json");
    let approval = json!({
        "approval_id": approval_id,
        "run_id": run_id,
        "action_kind": "handoff_export",
        "risk_class": "local_file_write",
        "human_summary": format!("Export reviewed Work handoff {handoff_id} to private artifacts?"),
        "action_digest": package_hash,
        "canonical_scope": format!("private-artifact:{artifact_ref}"),
        "resource_versions": {"workspace_snapshot": session["plan"]["workspace_snapshot_hash"]},
        "policy_version": "work-handoff-v1",
        "preview_ref": format!("work-preview:{handoff_id}"),
        "nonce": nonce,
        "expires_at": expires_at,
        "decision": "pending",
    });
    let preview = json!({
        "plan": session["plan"],
        "envelope": envelope,
        "package_hash": package_hash,
        "byte_count": bytes.len(),
        "approval": approval,
    });
    let binding = sha256_hex(format!("{key}\0{}", preview["package_hash"]).as_bytes());
    if let Err(error) =
        storage.save_work_preview(&run_id, &key, &binding, &preview, &created_at.to_rfc3339())
    {
        return storage_error_response(error);
    }
    if let Err(error) = storage.save_approval(&approval_id, &run_id, &expires_at, &approval) {
        return storage_error_response(error);
    }
    (StatusCode::CREATED, Json(preview)).into_response()
}

pub(super) async fn export_work_handoff(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_WRITE) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let payload = match parse_json::<WorkExport>(request, 8 * 1024).await {
        Ok(payload) => payload,
        Err(response) => return *response,
    };
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let session = match storage.work_session(&run_id) {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Work handoff not found"),
        Err(error) => return storage_error_response(error),
    };
    if let Some(export) = session["export"].as_object()
        && export.get("approval_id").and_then(Value::as_str) == Some(&payload.approval_id)
    {
        return Json(Value::Object(export.clone())).into_response();
    }
    let preview = &session["preview"];
    if preview["approval"]["approval_id"].as_str() != Some(&payload.approval_id) {
        return error_response(
            StatusCode::CONFLICT,
            "Work approval does not match the preview",
        );
    }
    let approval = match storage.approval(&payload.approval_id) {
        Ok(Some(approval)) => approval,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "approval not found"),
        Err(error) => return storage_error_response(error),
    };
    if approval.decision != "approved" && approval.decision != "consumed" {
        return error_response(
            StatusCode::FORBIDDEN,
            "Work export requires explicit approval",
        );
    }
    let package = match serde_json::to_vec(&preview["envelope"]) {
        Ok(package) => package,
        Err(_) => return storage_unavailable(),
    };
    let package_hash = sha256_hex(&package);
    if preview["package_hash"].as_str() != Some(&package_hash)
        || approval
            .request
            .get("action_digest")
            .and_then(Value::as_str)
            != Some(&package_hash)
    {
        return error_response(
            StatusCode::CONFLICT,
            "Work handoff bytes changed after approval preview",
        );
    }
    let root = session["request"]["workspace_root"]
        .as_str()
        .unwrap_or_default();
    let workspace = match SafeWorkspace::open(root) {
        Ok(workspace) => workspace,
        Err(_) => return error_response(StatusCode::CONFLICT, "Work workspace is unavailable"),
    };
    if let Err(detail) = frozen_work_context(&workspace, &session["plan"]["context_manifest"]) {
        return error_response_owned(StatusCode::CONFLICT, detail);
    }
    let artifact_ref = format!(
        "work-handoffs/{}.json",
        preview["envelope"]["handoff_id"]
            .as_str()
            .unwrap_or("invalid")
    );
    let artifact_root = match storage.artifact_directory() {
        Ok(path) => path,
        Err(error) => return storage_error_response(error),
    };
    if artifact_root.starts_with(workspace.root()) {
        return error_response(
            StatusCode::CONFLICT,
            "private Work artifacts cannot be stored inside the selected workspace",
        );
    }
    let final_path = artifact_root.join(&artifact_ref);
    let pending_path = final_path.with_extension("json.pending");
    if let Some(parent) = final_path.parent()
        && let Err(error) = create_private_directory(parent)
    {
        return error_response_owned(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    if final_path.exists() {
        if fs::read(&final_path)
            .ok()
            .as_deref()
            .map(sha256_hex)
            .as_deref()
            != Some(&package_hash)
        {
            return error_response(
                StatusCode::CONFLICT,
                "private handoff destination already contains different bytes",
            );
        }
    } else {
        if let Err(error) = write_private_file(&pending_path, &package) {
            return error_response_owned(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        if approval.decision == "approved"
            && let Err(error) = storage.consume_approval(&payload.approval_id)
        {
            return storage_error_response(error);
        }
        if let Err(error) = fs::rename(&pending_path, &final_path) {
            return error_response_owned(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    let exported_at = Utc::now().to_rfc3339();
    let result = json!({
        "run_id": run_id,
        "approval_id": payload.approval_id,
        "artifact_ref": artifact_ref,
        "package_hash": package_hash,
        "byte_count": package.len(),
        "applied": true,
        "exported_at": exported_at,
    });
    let binding = sha256_hex(format!("{key}\0{package_hash}").as_bytes());
    match storage.save_work_export(&run_id, &key, &binding, &result, &exported_at) {
        Ok(result) => Json(result).into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn verify_work(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_READ) {
        return *response;
    }
    let key = match idempotency_key(request.headers()) {
        Ok(value) => value.to_owned(),
        Err(response) => return response,
    };
    let manifest = match parse_json::<WorkResultManifest>(request, 256 * 1024).await {
        Ok(manifest) => manifest,
        Err(response) => return *response,
    };
    if manifest.schema_version != 1
        || manifest.run_id != run_id
        || manifest.summary.len() > 32_000
        || manifest.changed_files.len() > 2_000
        || manifest.artifacts.len() > 2_000
        || manifest.claimed_commands.len() > 100
    {
        return error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid Work result manifest",
        );
    }
    let Some(storage) = state.storage.as_ref() else {
        return storage_unavailable();
    };
    let session = match storage.work_session(&run_id) {
        Ok(Some(session)) => session,
        Ok(None) => return error_response(StatusCode::NOT_FOUND, "Work plan not found"),
        Err(error) => return storage_error_response(error),
    };
    if manifest.plan_artifact_id != session["plan"]["artifact_id"].as_str().unwrap_or_default()
        || manifest.base_snapshot_hash
            != session["plan"]["workspace_snapshot_hash"]
                .as_str()
                .unwrap_or_default()
    {
        return error_response(StatusCode::CONFLICT, "Work result references a stale plan");
    }
    let workspace = match SafeWorkspace::open(
        session["request"]["workspace_root"]
            .as_str()
            .unwrap_or_default(),
    ) {
        Ok(workspace) => workspace,
        Err(_) => return error_response(StatusCode::CONFLICT, "Work workspace is unavailable"),
    };
    let current = match workspace.work_snapshot() {
        Ok(snapshot) => snapshot,
        Err(_) => return error_response(StatusCode::CONFLICT, "Work workspace cannot be verified"),
    };
    let initial = snapshot_hashes(&session["snapshot"]);
    let observed = current
        .files
        .iter()
        .map(|file| (file.relative_path.clone(), file.sha256.clone()))
        .collect::<BTreeMap<_, _>>();
    let targets = session["plan"]["target_files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect::<BTreeSet<_>>();
    let mut claimed = BTreeSet::new();
    let mut changed_files = Vec::new();
    for item in &manifest.changed_files {
        let path = match workspace.validate_work_path(&item.relative_path) {
            Ok(path) => path,
            Err(_) => return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid Work path"),
        };
        claimed.insert(path.clone());
        let before = initial.get(&path).cloned();
        let after = observed.get(&path).cloned();
        let (status, reason) = if !targets.contains(path.as_str()) {
            (
                "mismatched",
                "The changed path is outside the frozen target set.",
            )
        } else if item.before_hash != before {
            (
                "mismatched",
                "The claimed preimage does not match the frozen workspace.",
            )
        } else if item.after_hash != after {
            (
                "mismatched",
                "The claimed postimage does not match read-only filesystem evidence.",
            )
        } else {
            (
                "matched",
                "Preimage and postimage match frozen and current evidence.",
            )
        };
        changed_files.push(json!({
            "relative_path": path,
            "status": status,
            "expected_hash": item.after_hash,
            "observed_hash": after,
            "reason": reason,
        }));
    }
    let actual_changed = initial
        .keys()
        .chain(observed.keys())
        .filter(|path| initial.get(*path) != observed.get(*path))
        .cloned()
        .collect::<BTreeSet<_>>();
    let unexpected_changes = actual_changed
        .difference(&claimed)
        .cloned()
        .collect::<Vec<_>>();
    let mut artifacts = Vec::new();
    for item in &manifest.artifacts {
        let path = match workspace.validate_work_path(&item.relative_path) {
            Ok(path) => path,
            Err(_) => {
                return error_response(StatusCode::UNPROCESSABLE_ENTITY, "invalid artifact path");
            }
        };
        let observed_hash = observed.get(&path).cloned();
        let matched = observed_hash.as_deref() == Some(item.content_hash.as_str());
        artifacts.push(json!({
            "relative_path": path,
            "status": if matched {"matched"} else {"mismatched"},
            "expected_hash": item.content_hash,
            "observed_hash": observed_hash,
            "reason": if matched {"Artifact hash matches read-only filesystem evidence."} else {"Artifact hash does not match read-only filesystem evidence."},
        }));
    }
    let commands = manifest
        .claimed_commands
        .iter()
        .map(|item| json!({
            "command_hash": sha256_hex(item.command.as_bytes()),
            "claimed_exit_code": item.exit_code,
            "status": "unverified",
            "reason": "Restork did not execute this command; the exit code remains an external claim.",
        }))
        .collect::<Vec<_>>();
    let evidence_matches = changed_files
        .iter()
        .chain(artifacts.iter())
        .all(|value| value["status"] == "matched");
    let has_evidence = !changed_files.is_empty() || !artifacts.is_empty();
    let independently_verified = has_evidence && evidence_matches && unexpected_changes.is_empty();
    let completion_eligible = independently_verified && commands.is_empty();
    let status = if !independently_verified {
        "failed"
    } else if commands.is_empty() {
        "verified"
    } else {
        "partial"
    };
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap_or_default();
    let manifest_hash = sha256_hex(&manifest_bytes);
    let verification_id = format!(
        "work-verification-{}",
        &sha256_hex(format!("{run_id}\0{manifest_hash}").as_bytes())[..24]
    );
    let created_at = Utc::now().to_rfc3339();
    let report = json!({
        "verification_id": verification_id,
        "run_id": run_id,
        "manifest_hash": manifest_hash,
        "status": status,
        "changed_files": changed_files,
        "artifacts": artifacts,
        "commands": commands,
        "unexpected_changes": unexpected_changes,
        "completion_eligible": completion_eligible,
        "task_update_preview": completion_eligible.then(|| json!({
            "run_id": run_id,
            "action": "mark_complete",
            "suggested_markdown": format!("- [x] Verified Work result [run:: {run_id}] [evidence:: {verification_id}]"),
            "evidence_ref": verification_id,
            "apply_available": false,
        })),
        "created_at": created_at,
    });
    let binding = sha256_hex(format!("{key}\0{manifest_hash}").as_bytes());
    match storage.save_work_verification(
        NewWorkVerification {
            verification_id: &verification_id,
            run_id: &run_id,
            idempotency_key: &key,
            binding: &binding,
            manifest_hash: &manifest_hash,
            created_at: &created_at,
        },
        &report,
    ) {
        Ok(report) => Json(report).into_response(),
        Err(error) => storage_error_response(error),
    }
}

fn validate_work_start(payload: &WorkStart) -> Result<(), String> {
    let root_valid = payload.workspace_root.as_deref().is_some_and(|root| {
        !root.is_empty() && root.len() <= 4_096 && FsPath::new(root).is_absolute()
    });
    let grant_valid = payload.workspace_grant_id.as_deref().is_some_and(|grant| {
        grant.len() == 32 && grant.bytes().all(|byte| byte.is_ascii_hexdigit())
    });
    if payload.goal.trim().is_empty()
        || payload.goal.len() > 32_000
        || root_valid == grant_valid
        || payload.target_files.len() > 500
        || payload.context_files.len() > 500
        || !matches!(
            payload.context_data_class.as_str(),
            "public" | "personal" | "confidential"
        )
    {
        return Err("invalid Work goal, workspace, target list, or data class".to_owned());
    }
    for list in [
        &payload.constraints,
        &payload.non_goals,
        &payload.completion_criteria,
        &payload.verification_commands,
    ] {
        if list.len() > 200
            || list
                .iter()
                .any(|item| item.is_empty() || item.len() > 4_096)
        {
            return Err("Work constraints and verification claims must be bounded".to_owned());
        }
    }
    Ok(())
}

fn resolve_work_root(payload: &WorkStart) -> Result<(PathBuf, Option<PathBuf>), String> {
    if let Some(root) = payload.workspace_root.as_deref() {
        return Ok((PathBuf::from(root), None));
    }
    let directory = std::env::var_os("RESTORK_DESKTOP_WORKSPACE_GRANTS")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    resolve_work_root_with_grant_dir(payload, directory.as_deref())
}

fn resolve_work_root_with_grant_dir(
    payload: &WorkStart,
    directory: Option<&FsPath>,
) -> Result<(PathBuf, Option<PathBuf>), String> {
    if let Some(root) = payload.workspace_root.as_deref() {
        return Ok((PathBuf::from(root), None));
    }
    let grant_id = payload
        .workspace_grant_id
        .as_deref()
        .ok_or_else(|| "choose one Work workspace".to_owned())?;
    let directory = directory
        .filter(|path| path.is_absolute())
        .ok_or_else(|| "desktop workspace grants are unavailable".to_owned())?;
    let grant_file = directory.join(format!("{grant_id}.grant"));
    let metadata = fs::symlink_metadata(&grant_file).map_err(|_| {
        "the project-folder grant is unavailable; choose the folder again".to_owned()
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err("the project-folder grant is invalid; choose the folder again".to_owned());
    }
    let age = metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or(Duration::MAX);
    if age > Duration::from_secs(30 * 60) {
        return Err("the project-folder grant expired; choose the folder again".to_owned());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let file = options.open(&grant_file).map_err(|_| {
        "the project-folder grant is unavailable; choose the folder again".to_owned()
    })?;
    let mut root = String::new();
    file.take(4_097)
        .read_to_string(&mut root)
        .map_err(|_| "the project-folder grant is invalid; choose the folder again".to_owned())?;
    let root = root.trim();
    if root.is_empty()
        || root.len() > 4_096
        || root.contains(['\0', '\r', '\n'])
        || !FsPath::new(root).is_absolute()
    {
        return Err("the project-folder grant is invalid; choose the folder again".to_owned());
    }
    Ok((PathBuf::from(root), Some(grant_file)))
}

fn canonical_work_paths(
    workspace: &SafeWorkspace,
    paths: &[String],
) -> Result<Vec<String>, String> {
    let mut unique = BTreeSet::new();
    for path in paths {
        let canonical = workspace
            .validate_work_path(path)
            .map_err(|_| format!("Work path is outside the text allowlist: {path}"))?;
        unique.insert(canonical);
    }
    Ok(unique.into_iter().collect())
}

fn work_language(path: &str) -> String {
    FsPath::new(path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("text")
        .to_ascii_lowercase()
}

fn is_instruction_path(path: &str) -> bool {
    let folded = path.to_ascii_lowercase();
    matches!(
        FsPath::new(&folded)
            .file_name()
            .and_then(|value| value.to_str()),
        Some("agents.md" | "claude.md" | "contributing.md" | "readme.md")
    ) || folded == ".github/copilot-instructions.md"
}

fn redact_work_list(values: &[String], root: &FsPath) -> Vec<String> {
    values
        .iter()
        .map(|value| redact_private_paths(value, root))
        .collect()
}

fn redact_private_paths(value: &str, root: &FsPath) -> String {
    value
        .replace(root.to_string_lossy().as_ref(), "[WORKSPACE]")
        .split_whitespace()
        .map(|token| {
            if token.starts_with("/Users/")
                || token.starts_with("/home/")
                || (token.len() > 9 && token.as_bytes().get(1) == Some(&b':'))
            {
                "[PRIVATE_PATH]".to_owned()
            } else {
                token.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn sanitize_work_context(content: &str, root: &FsPath) -> (String, Vec<String>) {
    let mut redactions = BTreeSet::new();
    let mut private_key = false;
    let mut lines = Vec::new();
    for line in content.lines() {
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
            private_key = true;
            redactions.insert("private_key");
            lines.push("[REDACTED PRIVATE KEY]".to_owned());
            continue;
        }
        if private_key {
            if line.contains("-----END") && line.contains("PRIVATE KEY-----") {
                private_key = false;
            }
            continue;
        }
        let folded = line.to_ascii_lowercase();
        if [
            "api_key",
            "api-key",
            "authorization",
            "password",
            "passwd",
            "secret",
            "token",
        ]
        .iter()
        .any(|name| folded.trim_start().starts_with(name))
            && (line.contains('=') || line.contains(':'))
        {
            let split = line.find('=').or_else(|| line.find(':')).unwrap_or(0);
            lines.push(format!("{}[REDACTED]", &line[..=split]));
            redactions.insert("secret_assignment");
            continue;
        }
        let redacted = redact_private_paths(line, root);
        if redacted != line {
            redactions.insert("personal_absolute_path");
        }
        lines.push(redacted);
    }
    (
        lines.join("\n"),
        redactions.into_iter().map(str::to_owned).collect(),
    )
}

fn work_agent_goal(
    payload: &WorkStart,
    plan: &Value,
    model_context: &[Value],
    root: &FsPath,
) -> String {
    format!(
        "Author a concrete Work plan for this frozen request. Return only one JSON object with a `plan_steps` array; each step must contain `title`, `intent`, `target_files`, and `verification`. Never claim execution. Goal: {}\nTargets and hashes: {}\nConstraints: {}\nNon-goals: {}\nCompletion criteria: {}\nPublic reviewed context: {}",
        redact_private_paths(&payload.goal, root),
        plan["context_manifest"],
        plan["constraints"],
        plan["non_goals"],
        plan["completion_criteria"],
        Value::Array(model_context.to_vec()),
    )
}

fn frozen_work_context(workspace: &SafeWorkspace, manifest: &Value) -> Result<Vec<Value>, String> {
    let mut contexts = Vec::new();
    for item in manifest
        .as_array()
        .ok_or_else(|| "Work context manifest is invalid".to_owned())?
    {
        if item["included_in_handoff"].as_bool() != Some(true) {
            continue;
        }
        let path = item["relative_path"]
            .as_str()
            .ok_or_else(|| "Work context path is invalid".to_owned())?;
        let existed = item["exists_at_plan"].as_bool() == Some(true);
        if !existed {
            if workspace.work_file_exists(path).unwrap_or(true) {
                return Err(format!(
                    "new Work target appeared after the plan was frozen: {path}"
                ));
            }
            contexts.push(json!({
                "relative_path": path,
                "content_hash": null,
                "byte_count": 0,
                "data_class": item["data_class"],
                "content": "",
                "exists_at_plan": false,
                "redactions": [],
            }));
            continue;
        }
        let (content, hash) = workspace
            .read_text(path, 200_000)
            .map_err(|_| format!("Work context is no longer readable: {path}"))?;
        if item["content_hash"].as_str() != Some(&hash) {
            return Err(format!(
                "Work context changed after the plan was frozen: {path}"
            ));
        }
        let (content, redactions) = sanitize_work_context(&content, workspace.root());
        contexts.push(json!({
            "relative_path": path,
            "content_hash": hash,
            "byte_count": content.len(),
            "data_class": item["data_class"],
            "content": content,
            "exists_at_plan": true,
            "redactions": redactions,
        }));
    }
    Ok(contexts)
}

fn snapshot_hashes(snapshot: &Value) -> BTreeMap<String, String> {
    snapshot["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| {
            Some((
                file["relative_path"].as_str()?.to_owned(),
                file["sha256"].as_str()?.to_owned(),
            ))
        })
        .collect()
}

fn create_private_directory(path: &FsPath) -> std::io::Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_file(path: &FsPath, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

pub(super) fn persist_agent_outcome(storage: &Database, run: &RunRecord, outcome: &AgentOutcome) {
    if outcome.stop_reason != restork_core::durable_loop::AgentStopReason::Completed {
        return;
    }
    crate::memory_suggestion_api::offer_from_outcome(storage, run, outcome);
    if run.mode == "study" {
        let Some(output) = outcome.output.as_deref() else {
            return;
        };
        let Ok(Some(session)) = storage.study_session(&run.run_id) else {
            return;
        };
        let parsed = parse_model_json(output);
        let questions = parsed
            .as_ref()
            .and_then(|value| value["questions"].as_array())
            .map(|questions| {
                questions
                    .iter()
                    .take(8)
                    .enumerate()
                    .filter_map(|(index, question)| {
                        let prompt = bounded_model_text(&question["prompt"], 2_000)?;
                        let response_kind = match question["response_kind"].as_str() {
                            Some("rating") => "rating",
                            Some("text" | "free_text") | None => "free_text",
                            Some(_) => return None,
                        };
                        Some(json!({
                            "question_id": format!("study-question-{}", &sha256_hex(format!("{}\0{}\0{prompt}", run.run_id, index + 1).as_bytes())[..24]),
                            "prompt": prompt,
                            "response_kind": response_kind,
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut diagnostic = session["diagnostic"].clone();
        diagnostic["questions"] = Value::Array(questions.clone());
        diagnostic["status"] = Value::String(
            if questions.is_empty() {
                "invalid_output"
            } else {
                "ready"
            }
            .to_owned(),
        );
        diagnostic["synthesizer"] = json!({
            "kind": "provider_agent",
            "provider_profile_id": run.task_spec["provider_profile_id"],
            "prompt": run.task_spec["prompt"],
        });
        let _ = storage.save_study_session(
            &run.run_id,
            session["request_hash"].as_str().unwrap_or_default(),
            &session["request"],
            &diagnostic,
            None,
            &Utc::now().to_rfc3339(),
        );
        return;
    }
    if run.mode == "work" {
        let Some(output) = outcome.output.as_deref() else {
            return;
        };
        let Ok(Some(session)) = storage.work_session(&run.run_id) else {
            return;
        };
        let mut plan = session["plan"].clone();
        let parsed = parse_model_json(output);
        let steps = parsed
            .as_ref()
            .and_then(|value| value["plan_steps"].as_array())
            .map(|steps| {
                steps
                    .iter()
                    .take(32)
                    .enumerate()
                    .filter_map(|(index, step)| {
                        let title = bounded_model_text(&step["title"], 240)?;
                        let intent = bounded_model_text(&step["intent"], 4_000)?;
                        let target_files = step["target_files"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .filter(|path| {
                                plan["target_files"].as_array().is_some_and(|targets| {
                                    targets.iter().any(|target| target == path)
                                })
                            })
                            .take(100)
                            .map(ToOwned::to_owned)
                            .collect::<Vec<_>>();
                        let verification = step["verification"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter_map(Value::as_str)
                            .filter(|value| !value.is_empty() && value.len() <= 4_096)
                            .take(50)
                            .map(ToOwned::to_owned)
                            .collect::<Vec<_>>();
                        let step_id = format!(
                            "work-step-{}",
                            &sha256_hex(
                                format!("{}\0{}\0{title}", run.run_id, index + 1).as_bytes()
                            )[..24]
                        );
                        Some(json!({
                            "step_id": step_id,
                            "order": index + 1,
                            "title": title,
                            "intent": intent,
                            "target_files": target_files,
                            "verification": verification,
                        }))
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let ready = !steps.is_empty();
        plan["plan_steps"] = Value::Array(steps);
        plan["agent_status"] =
            Value::String(if ready { "ready" } else { "invalid_output" }.to_owned());
        plan["synthesizer"] = json!({
            "kind": "provider_agent",
            "provider_profile_id": run.task_spec["provider_profile_id"],
            "prompt": run.task_spec["prompt"],
        });
        if !ready && let Some(warnings) = plan["warnings"].as_array_mut() {
            warnings.push(Value::String(
                "The model did not return a valid structured plan; no handoff can be approved."
                    .to_owned(),
            ));
        }
        let _ = storage.save_work_session(
            &run.run_id,
            session["request_hash"].as_str().unwrap_or_default(),
            &session["request"],
            &plan,
            &session["snapshot"],
            &Utc::now().to_rfc3339(),
        );
        return;
    }
    if run.mode == "research" {
        let Some(output) = outcome.output.as_deref() else {
            return;
        };
        let question = run.task_spec["goal"].as_str().unwrap_or("Restork research");
        let mut events = Vec::new();
        let mut cursor = 0;
        loop {
            let Ok(page) = storage.events_after(&run.run_id, cursor, 100) else {
                return;
            };
            if page.items.is_empty() {
                break;
            }
            cursor = page.items.last().map_or(cursor, |event| event.sequence);
            events.extend(page.items);
            if page.next_after.is_none() {
                break;
            }
        }
        let mut sources = Vec::<(String, String)>::new();
        for event in events.iter().filter(|event| event.kind == "tool.completed") {
            let Some(result) = event.metadata["observation"]["result"].as_object() else {
                continue;
            };
            let content = serde_json::to_string(result).unwrap_or_default();
            if let Some(citations) = result.get("citations").and_then(Value::as_array) {
                for citation in citations {
                    if let Some(url) = citation["url"].as_str() {
                        sources.push((url.to_owned(), content.clone()));
                    }
                }
            }
            if let Some(path) = result.get("relative_path").and_then(Value::as_str) {
                sources.push((path.to_owned(), content.clone()));
            }
            if !content.is_empty() && !sources.iter().any(|(_, value)| value == &content) {
                sources.push((format!("tool-event:{}", event.sequence), content));
            }
        }
        let parsed = parse_model_json(output).unwrap_or_else(|| json!({"answer": output}));
        let title =
            bounded_model_text(&parsed["title"], 160).unwrap_or_else(|| question.to_owned());
        let claims = parsed["claims"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(index, claim)| {
                let statement = claim["statement"].as_str()?.to_owned();
                let claim_id = claim["claim_id"]
                    .as_str()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("claim-{}", index + 1));
                let references = claim["evidence_refs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect();
                Some((claim_id, statement, references))
            })
            .collect::<Vec<_>>();
        let ledger = build_ledger(sources, claims);
        let supported = ledger.claims.iter().filter(|claim| claim.grounded).count();
        let supported_rate = if ledger.claims.is_empty() {
            0.0
        } else {
            supported as f64 / ledger.claims.len() as f64
        };
        let artifact_id = format!("research-{}", &sha256_hex(run.run_id.as_bytes())[..24]);
        let answer = parsed["answer"].as_str().unwrap_or(output);
        let markdown = format!(
            "# Research: {}\n\n{}\n\n## Evidence\n{}\n",
            question,
            answer,
            ledger
                .chunks
                .iter()
                .map(|chunk| format!("- `{}` — {}", chunk.evidence_id, chunk.source_ref))
                .collect::<Vec<_>>()
                .join("\n")
        );
        let artifact = json!({
            "artifact_id": artifact_id,
            "run_id": run.run_id,
            "title": title,
            "question": question,
            "answer": answer,
            "claims": ledger.claims.iter().map(|claim| json!({
                "claim_id": claim.claim_id,
                "statement": claim.statement,
                "kind": if claim.grounded {"grounded"} else {"inference"},
                "evidence_refs": claim.evidence_refs,
                "inference_basis": (!claim.grounded).then_some("No valid evidence reference was supplied by the synthesizer."),
            })).collect::<Vec<_>>(),
            "evidence": ledger.chunks,
            "conflicts": parsed["conflicts"].as_array().cloned().unwrap_or_default(),
            "unresolved_questions": parsed["unresolved_questions"].as_array().cloned().unwrap_or_default(),
            "unresolved_evidence_refs": ledger.unresolved_references,
            "related_notes": [],
            "note_preview": {
                "action": "create",
                "relative_path": research_note_path(&title, &run.run_id),
                "expected_hash": null,
                "markdown_hash": sha256_hex(markdown.as_bytes()),
                "markdown": markdown,
            },
            "metrics": {
                "supported_claim_rate": supported_rate,
                "primary_source_ratio": null,
                "citation_correctness": null,
                "duplicate_sources": 0,
                "related_note_count": 0,
                "conflict_count": parsed["conflicts"].as_array().map_or(0, Vec::len),
            },
            "synthesizer": {
                "kind": "provider_agent",
                "provider_profile_id": run.task_spec["provider_profile_id"],
                "prompt": run.task_spec["prompt"],
            },
        });
        let _ = storage.save_research_artifact(
            artifact["artifact_id"]
                .as_str()
                .unwrap_or("research-artifact"),
            &run.run_id,
            &artifact,
            &Utc::now().to_rfc3339(),
        );
    }
}

fn bounded_model_text(value: &Value, maximum: usize) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= maximum && !value.contains('\0'))
        .map(ToOwned::to_owned)
}

fn parse_model_json(output: &str) -> Option<Value> {
    let trimmed = output.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return value.is_object().then_some(value);
    }
    let start = trimmed.rfind("```json")? + "```json".len();
    let end = trimmed[start..].find("```")? + start;
    serde_json::from_str::<Value>(trimmed[start..end].trim())
        .ok()
        .filter(Value::is_object)
}

fn research_note_path(question: &str, run_id: &str) -> String {
    format!(
        "Restork Research - {}.md",
        study_note_slug(question, run_id)
    )
}

fn normalize_research_note_path(artifact: &mut Value, run_id: &str) {
    let Some(path) = artifact["note_preview"]["relative_path"].as_str() else {
        return;
    };
    let Some(identifier) = path
        .strip_prefix("Restork Research - run-")
        .and_then(|value| value.strip_suffix(".md"))
    else {
        return;
    };
    if identifier.is_empty() || !identifier.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        return;
    }
    let Some(title) = artifact["title"]
        .as_str()
        .or_else(|| artifact["question"].as_str())
    else {
        return;
    };
    artifact["note_preview"]["relative_path"] = Value::String(research_note_path(title, run_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn study_note_slug_keeps_cjk_and_collapses_separators() {
        assert_eq!(
            study_note_slug("Agent Harness 总览", "run-1"),
            "Agent-Harness-总览"
        );
        assert_eq!(
            study_note_slug("a/b\\c:d*e?f\"g<h>i|j", "run-1"),
            "a-b-c-d-e-f-g-h-i-j"
        );
    }

    #[test]
    fn study_note_slug_falls_back_and_caps_length() {
        assert!(study_note_slug("///...", "run-abc").starts_with("run-"));
        let long = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
        assert!(study_note_slug(long, "run-1").chars().count() <= 48);
        assert!(!study_note_slug(long, "run-1").ends_with('-'));
    }

    #[test]
    fn research_note_path_uses_the_question_instead_of_the_run_id() {
        let path = research_note_path("RAG 精确召回：订单号与价格", "run-secret-internal-id");
        assert_eq!(path, "Restork Research - RAG-精确召回-订单号与价格.md");
        assert!(!path.contains("run-secret-internal-id"));
    }

    #[test]
    fn legacy_research_artifact_is_migrated_when_it_is_read_or_retried() {
        let mut artifact = json!({
            "title": "Pi 与 DeepSeek Harness 对比",
            "question": "Pi 与 DeepSeek Harness 对比",
            "note_preview": {
                "relative_path": "Restork Research - run-b74d7d07a6960ae2a3ad6191bc5b5061.md"
            }
        });
        normalize_research_note_path(&mut artifact, "run-b74d7d07a6960ae2a3ad6191bc5b5061");
        assert_eq!(
            artifact["note_preview"]["relative_path"],
            "Restork Research - Pi-与-DeepSeek-Harness-对比.md"
        );
    }

    #[test]
    fn study_note_markdown_renders_grounded_sections() {
        let note = study_note_markdown(
            "Agent Harness 总览",
            "ready",
            &json!(["能说出 harness 的职责"]),
            &[
                json!({"title": "学习-Agent Harness 总览", "relative_path": "学习-Agent Harness 总览.md", "rationale": "基础概念"}),
            ],
            &[
                json!({"order": 1, "title": "Harness 是什么", "outcome": "说清控制层", "note_refs": ["学习-Agent Harness 总览.md"]}),
            ],
            &[
                json!({"kind": "active_recall", "prompt": "harness 和 loop 的区别", "concept": "harness", "hints": ["从职责边界想"]}),
            ],
            &[
                json!({"title": "学习-Agent Loop与Loop Engineering", "relative_path": "学习-Agent Loop与Loop Engineering.md"}),
            ],
        );
        assert!(note.starts_with("# Restork Study: Agent Harness 总览\n"));
        assert!(note.contains("Readiness: ready"));
        assert!(note.contains("- 能说出 harness 的职责"));
        assert!(
            note.contains("[[学习-Agent Harness 总览]] (`学习-Agent Harness 总览.md`) — 基础概念")
        );
        assert!(note.contains("1. **Harness 是什么** — 说清控制层"));
        assert!(note.contains("- [active_recall] harness 和 loop 的区别 — concept: harness"));
        assert!(note.contains("  - Hint: 从职责边界想"));
        assert!(note.contains("[[学习-Agent Loop与Loop Engineering]]"));
        // Answer keys / rubrics must never leak into the note.
        assert!(!note.contains("grading_rubric"));
    }

    #[test]
    fn work_folder_grant_resolves_without_exposing_the_path_in_the_request() {
        let grant_dir = tempfile::tempdir().expect("grant directory");
        let workspace = tempfile::tempdir().expect("workspace");
        let grant_id = "0123456789abcdef0123456789abcdef";
        fs::write(
            grant_dir.path().join(format!("{grant_id}.grant")),
            workspace.path().to_string_lossy().as_bytes(),
        )
        .expect("grant fixture");
        let payload = WorkStart {
            goal: "prepare the release".to_owned(),
            workspace_root: None,
            workspace_grant_id: Some(grant_id.to_owned()),
            target_files: Vec::new(),
            context_files: Vec::new(),
            constraints: Vec::new(),
            non_goals: Vec::new(),
            completion_criteria: Vec::new(),
            verification_commands: Vec::new(),
            context_data_class: "public".to_owned(),
        };

        assert!(validate_work_start(&payload).is_ok());
        let (resolved, consumed) =
            resolve_work_root_with_grant_dir(&payload, Some(grant_dir.path()))
                .expect("resolved grant");
        assert_eq!(resolved, workspace.path());
        assert_eq!(
            consumed,
            Some(grant_dir.path().join(format!("{grant_id}.grant")))
        );
    }
}
