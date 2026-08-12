//! Optional run-summary suggestions. This is not the memory system's main path:
//! a completed Research/Study/Work run may offer one preview. Default is no.
//! Accept writes episodic `run_summary` only. Profile is never written here.

use axum::{
    Json,
    extract::{Path, Request, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use chrono::{Duration, Utc};
use restork_core::{
    auth::{MEMORY_WRITE, RUNS_READ},
    durable_loop::{AgentOutcome, AgentStopReason},
};
use restork_storage::{Database, NewMemorySuggestion, RunRecord};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::{
    ApiState, authorize, error_response, now_rfc3339, random_id, require_idempotency_key,
    storage_error_response, storage_unavailable,
};

const SUMMARY_LIMIT: usize = 800;

pub(super) fn offer_from_outcome(storage: &Database, run: &RunRecord, outcome: &AgentOutcome) {
    if outcome.stop_reason != AgentStopReason::Completed {
        return;
    }
    if !matches!(run.mode.as_str(), "research" | "study" | "work") {
        return;
    }
    let Some(output) = outcome.output.as_deref() else {
        return;
    };
    let goal = run.task_spec["goal"].as_str().unwrap_or_default();
    let Some(summary) = extract_run_summary(&run.mode, goal, output) else {
        return;
    };
    let Ok(created_at) = now_rfc3339() else {
        return;
    };
    let expires_at = (Utc::now() + Duration::hours(24)).to_rfc3339();
    let suggestion_id = format!("run-summary-{}", &sha256_hex(run.run_id.as_bytes())[..24]);
    let content_hash = sha256_hex(summary.as_bytes());
    let data_class = match run.task_spec["data_class"].as_str() {
        Some("public") => "public",
        Some("confidential") => "confidential",
        _ => "personal",
    };
    let _ = storage.offer_memory_suggestion(NewMemorySuggestion {
        suggestion_id: &suggestion_id,
        run_id: &run.run_id,
        mode: &run.mode,
        summary: &summary,
        data_class,
        content_hash: &content_hash,
        created_at: &created_at,
        expires_at: &expires_at,
    });
}

pub(super) async fn get_run_summary_suggestion(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
    request: Request,
) -> Response {
    if let Err(response) = authorize(&state.authority, request.headers(), RUNS_READ) {
        return *response;
    }
    let Some(storage) = state.storage else {
        return storage_unavailable();
    };
    let now = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.pending_memory_suggestion(&run_id, &now) {
        Ok(Some(suggestion)) => Json(json!({
            "suggestion_id": suggestion.suggestion_id,
            "run_id": suggestion.run_id,
            "mode": suggestion.mode,
            "summary": suggestion.summary,
            "data_class": suggestion.data_class,
            "expires_at": suggestion.expires_at,
        }))
        .into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn accept_run_summary_suggestion(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
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
    let now = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    let memory_id = match random_id("run-summary") {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.accept_memory_suggestion(&run_id, &memory_id, &now) {
        Ok(record) => {
            if record.layer != "episodic" {
                return error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "run summary must stay episodic",
                );
            }
            Json(record).into_response()
        }
        Err(error) => storage_error_response(error),
    }
}

pub(super) async fn dismiss_run_summary_suggestion(
    State(state): State<ApiState>,
    Path(run_id): Path<String>,
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
    let now = match now_rfc3339() {
        Ok(value) => value,
        Err(response) => return response,
    };
    match storage.dismiss_memory_suggestion(&run_id, &now) {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => storage_error_response(error),
    }
}

pub(super) fn pending_run_summaries_json(storage: &Database, now: &str) -> Value {
    match storage.latest_pending_memory_suggestion(now) {
        Ok(Some(suggestion)) if !suggestion.summary.is_empty() => json!([{
            "suggestion_id": suggestion.suggestion_id,
            "run_id": suggestion.run_id,
            "mode": suggestion.mode,
            "summary": suggestion.summary,
            "data_class": suggestion.data_class,
            "expires_at": suggestion.expires_at,
        }]),
        _ => json!([]),
    }
}

pub(super) fn extract_run_summary(mode: &str, goal: &str, output: &str) -> Option<String> {
    let parsed = parse_model_object(output);
    let raw = match mode {
        "research" => research_summary(parsed.as_ref(), output),
        "study" => study_summary(goal, parsed.as_ref()),
        "work" => work_summary(goal, parsed.as_ref()),
        _ => return None,
    };
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    Some(collapsed.chars().take(SUMMARY_LIMIT).collect())
}

fn research_summary(parsed: Option<&Value>, output: &str) -> String {
    if let Some(answer) = parsed.and_then(|value| value["answer"].as_str())
        && !answer.trim().is_empty()
    {
        return answer.to_owned();
    }
    if let Some(statement) = parsed
        .and_then(|value| value["claims"].as_array())
        .into_iter()
        .flatten()
        .find_map(|claim| claim["statement"].as_str())
    {
        return statement.to_owned();
    }
    output.to_owned()
}

fn study_summary(goal: &str, parsed: Option<&Value>) -> String {
    let question = parsed
        .and_then(|value| value["questions"].as_array())
        .into_iter()
        .flatten()
        .find_map(|question| question["prompt"].as_str())
        .unwrap_or("");
    [goal.trim(), question.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn work_summary(goal: &str, parsed: Option<&Value>) -> String {
    let steps = parsed
        .and_then(|value| value["plan_steps"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|step| step["title"].as_str())
        .take(3)
        .collect::<Vec<_>>();
    let mut parts = Vec::new();
    if !goal.trim().is_empty() {
        parts.push(goal.trim().to_owned());
    }
    if !steps.is_empty() {
        parts.push(steps.join(" / "));
    }
    parts.join(" · ")
}

fn parse_model_object(output: &str) -> Option<Value> {
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

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{extract_run_summary, offer_from_outcome};
    use restork_core::durable_loop::{AgentOutcome, AgentStopReason};
    use restork_storage::{Database, NewRun};
    use serde_json::json;

    fn outcome(run_id: &str, reason: AgentStopReason, output: Option<&str>) -> AgentOutcome {
        AgentOutcome {
            run_id: run_id.to_owned(),
            state: "completed".to_owned(),
            stop_reason: reason,
            output: output.map(ToOwned::to_owned),
            iterations: 1,
            repairs: 0,
            total_tokens: 8,
            cost_usd_micros: 0,
        }
    }

    #[test]
    fn research_uses_answer_and_ignores_empty_output() {
        let summary = extract_run_summary(
            "research",
            "Compare two papers",
            r#"{"answer":"The papers disagree on identification.","claims":[]}"#,
        )
        .expect("summary");
        assert_eq!(summary, "The papers disagree on identification.");
        assert!(extract_run_summary("research", "goal", "   ").is_none());
    }

    #[test]
    fn work_joins_goal_and_step_titles() {
        let summary = extract_run_summary(
            "work",
            "Draft the weekly report",
            r#"{"plan_steps":[{"title":"Collect runs"},{"title":"Write draft"}]}"#,
        )
        .expect("summary");
        assert_eq!(
            summary,
            "Draft the weekly report · Collect runs / Write draft"
        );
    }

    #[test]
    fn completed_run_offers_pending_summary_and_cancelled_run_does_not() {
        let directory = tempfile::tempdir().expect("tempdir");
        let database = Database::open(directory.path().join("restork.db")).expect("open");
        database
            .create_run(NewRun {
                run_id: "run-offer",
                task_id: "task-offer",
                task_spec: &json!({"goal": "Compare two papers", "data_class": "personal"}),
                mode: "research",
                state: "completed",
                occurred_at: "2026-08-13T00:00:00Z",
            })
            .expect("create run");
        let run = database.run("run-offer").expect("load").expect("run");
        offer_from_outcome(
            &database,
            &run,
            &outcome(
                "run-offer",
                AgentStopReason::Completed,
                Some(r#"{"answer":"The papers disagree on identification."}"#),
            ),
        );
        let pending = database
            .pending_memory_suggestion("run-offer", "2026-08-13T01:00:00Z")
            .expect("pending")
            .expect("suggestion");
        assert_eq!(pending.summary, "The papers disagree on identification.");
        assert_eq!(pending.status, "pending");

        database
            .create_run(NewRun {
                run_id: "run-cancelled",
                task_id: "task-cancelled",
                task_spec: &json!({"goal": "Compare two papers"}),
                mode: "research",
                state: "cancelled",
                occurred_at: "2026-08-13T00:02:00Z",
            })
            .expect("create cancelled");
        let cancelled = database.run("run-cancelled").expect("load").expect("run");
        offer_from_outcome(
            &database,
            &cancelled,
            &outcome(
                "run-cancelled",
                AgentStopReason::Cancelled,
                Some(r#"{"answer":"nope"}"#),
            ),
        );
        assert!(
            database
                .pending_memory_suggestion("run-cancelled", "2026-08-13T01:00:00Z")
                .expect("pending")
                .is_none()
        );
    }
}
