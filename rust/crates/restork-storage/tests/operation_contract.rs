use std::path::PathBuf;

use restork_storage::{Database, NewContextPreview, NewConversationOperation, NewSession};
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("create test directory"))
    }

    fn database(&self) -> PathBuf {
        self.0.path().join("restork.db")
    }
}

fn create_session(database: &Database) {
    database
        .create_session(NewSession {
            session_id: "session-1",
            title: "Synthetic conversation",
            profile_id: "safe-mode",
            locale: Some("en"),
            occurred_at: "2026-08-03T00:00:00Z",
        })
        .expect("create session");
}

fn create_operation(database: &Database, id: &str, key: &str) {
    database
        .create_conversation_operation(NewConversationOperation {
            operation_id: id,
            session_id: "session-1",
            idempotency_key: key,
            user_message_id: &format!("message-{id}"),
            content: "Synthetic public question",
            context: &json!({}),
            data_class: "public",
            context_preview_hash: None,
            provider_binding: &json!({"mode": "safe"}),
            occurred_at: "2026-08-03T00:01:00Z",
        })
        .expect("create operation");
}

#[test]
fn operation_is_idempotent_replayable_and_cancellation_wins_the_effect_race() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.database()).expect("open database");
    create_session(&database);

    let first = database
        .create_conversation_operation(NewConversationOperation {
            operation_id: "operation-1",
            session_id: "session-1",
            idempotency_key: "request-1",
            user_message_id: "message-user-1",
            content: "Synthetic public question",
            context: &json!({}),
            data_class: "public",
            context_preview_hash: None,
            provider_binding: &json!({"provider": "fixture"}),
            occurred_at: "2026-08-03T00:01:00Z",
        })
        .expect("create operation");
    let replay = database
        .create_conversation_operation(NewConversationOperation {
            operation_id: "operation-different",
            session_id: "session-1",
            idempotency_key: "request-1",
            user_message_id: "message-different",
            content: "Synthetic public question",
            context: &json!({}),
            data_class: "public",
            context_preview_hash: None,
            provider_binding: &json!({"provider": "fixture"}),
            occurred_at: "2026-08-03T00:01:01Z",
        })
        .expect("replay operation");
    assert!(!first.replayed);
    assert!(replay.replayed);
    assert_eq!(replay.operation.operation_id, "operation-1");

    database
        .start_conversation_operation("operation-1", "2026-08-03T00:01:02Z")
        .expect("start operation");
    let cancelling = database
        .request_operation_cancel("operation-1", "2026-08-03T00:01:03Z")
        .expect("request cancel");
    assert_eq!(cancelling.state, "cancel_requested");
    assert!(
        database
            .complete_conversation_operation(
                "operation-1",
                "message-assistant-1",
                "must not be committed",
                &json!({}),
                "public",
                "2026-08-03T00:01:04Z",
            )
            .is_err()
    );
    let cancelled = database
        .finish_operation_cancelled("operation-1", "2026-08-03T00:01:05Z")
        .expect("finish cancellation");
    assert_eq!(cancelled.state, "cancelled");
    let events = database
        .operation_events_after("operation-1", 0, 100)
        .expect("replay events");
    assert_eq!(events.first().expect("queued event").sequence, 1);
    assert_eq!(
        events.last().expect("cancelled event").kind,
        "conversation.cancelled"
    );
    assert_eq!(
        database
            .session_messages_page("session-1", 0, 100)
            .expect("messages")
            .items
            .len(),
        1
    );
}

#[test]
fn context_preview_is_single_use_and_restart_fails_abandoned_work() {
    let directory = TestDirectory::new();
    let path = directory.database();
    let database = Database::open(&path).expect("open database");
    create_session(&database);
    let hash = "a".repeat(64);
    database
        .save_context_preview(NewContextPreview {
            preview_id: "preview-1",
            session_id: "session-1",
            content_hash: &hash,
            manifest: &json!({"items": [], "destination": "fixture"}),
            data_class: "public",
            byte_count: 0,
            estimated_tokens: 0,
            created_at: "2026-08-03T00:00:10Z",
            expires_at: "2026-08-03T01:00:10Z",
        })
        .expect("save preview");
    database
        .create_conversation_operation(NewConversationOperation {
            operation_id: "operation-preview",
            session_id: "session-1",
            idempotency_key: "request-preview",
            user_message_id: "message-preview",
            content: "Use reviewed context",
            context: &json!({"preview_hash": hash}),
            data_class: "public",
            context_preview_hash: Some(&hash),
            provider_binding: &json!({"provider": "fixture"}),
            occurred_at: "2026-08-03T00:01:00Z",
        })
        .expect("bind preview");
    assert!(
        database
            .create_conversation_operation(NewConversationOperation {
                operation_id: "operation-preview-2",
                session_id: "session-1",
                idempotency_key: "request-preview-2",
                user_message_id: "message-preview-2",
                content: "Reuse reviewed context",
                context: &json!({"preview_hash": hash}),
                data_class: "public",
                context_preview_hash: Some(&hash),
                provider_binding: &json!({"provider": "fixture"}),
                occurred_at: "2026-08-03T00:01:01Z",
            })
            .is_err()
    );
    drop(database);

    let reopened = Database::open(&path).expect("reopen database");
    let recovered = reopened
        .conversation_operation("operation-preview")
        .expect("operation")
        .expect("stored operation");
    assert_eq!(recovered.state, "failed");
    assert_eq!(recovered.error_code.as_deref(), Some("runtime_restarted"));
}

#[test]
fn completed_operation_atomically_persists_the_assistant_and_terminal_event() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.database()).expect("open database");
    create_session(&database);
    create_operation(&database, "operation-complete", "request-complete");
    database
        .start_conversation_operation("operation-complete", "2026-08-03T00:02:00Z")
        .expect("start operation");
    let (operation, message) = database
        .complete_conversation_operation(
            "operation-complete",
            "message-assistant-complete",
            "Synthetic bounded answer",
            &json!({"tool_access": false}),
            "public",
            "2026-08-03T00:02:01Z",
        )
        .expect("complete operation");
    assert_eq!(operation.state, "completed");
    assert_eq!(message.role, "assistant");
    let events = database
        .operation_events_after("operation-complete", 0, 100)
        .expect("events");
    assert_eq!(
        events.last().expect("terminal event").kind,
        "conversation.completed"
    );
}
