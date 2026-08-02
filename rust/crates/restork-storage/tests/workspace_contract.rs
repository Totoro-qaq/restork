use std::{fs, path::PathBuf};

use restork_storage::{Database, NewSession, NewSessionMessage, SessionCursor};
use serde_json::json;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("test entropy");
        let suffix = suffix
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let path = std::env::temp_dir().join(format!("restork-workspace-{suffix}"));
        fs::create_dir(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn personal_settings_use_optimistic_versions_and_can_be_cleared() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.join("restork.db")).expect("database");
    assert!(
        database
            .personal_settings()
            .expect("empty settings")
            .is_none()
    );

    let first = database
        .put_personal_settings(
            &json!({"display_name": "Synthetic User", "locale": "zh-CN"}),
            None,
            "2026-08-02T08:00:00Z",
        )
        .expect("create settings");
    assert_eq!(first.version, 1);
    assert!(
        database
            .put_personal_settings(
                &json!({"display_name": "stale"}),
                Some(0),
                "2026-08-02T08:01:00Z",
            )
            .is_err()
    );
    let second = database
        .put_personal_settings(
            &json!({"display_name": "Synthetic User", "theme": "light"}),
            Some(1),
            "2026-08-02T08:02:00Z",
        )
        .expect("update settings");
    assert_eq!(second.version, 2);
    database
        .clear_personal_settings(Some(2))
        .expect("clear settings");
    assert!(
        database
            .personal_settings()
            .expect("cleared settings")
            .is_none()
    );
}

#[test]
fn sessions_messages_search_and_keyset_pagination_are_durable() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.join("restork.db")).expect("database");
    for (id, updated) in [
        ("session-a", "2026-08-02T08:00:00Z"),
        ("session-b", "2026-08-02T09:00:00Z"),
        ("session-c", "2026-08-02T10:00:00Z"),
    ] {
        database
            .create_session(NewSession {
                session_id: id,
                title: "Synthetic workspace",
                profile_id: "safe-mode",
                locale: Some("en"),
                occurred_at: updated,
            })
            .expect("create session");
    }

    let first = database
        .sessions_page(None, 2, false)
        .expect("first session page");
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["session-c", "session-b"]
    );
    let second = database
        .sessions_page(first.next.as_ref(), 2, false)
        .expect("second session page");
    assert_eq!(second.items[0].session_id, "session-a");
    assert!(second.next.is_none());

    for (id, role, content) in [
        ("message-1", "user", "Investigate durable event replay"),
        ("message-2", "assistant", "A reviewable proposal is ready"),
    ] {
        database
            .append_session_message(NewSessionMessage {
                message_id: id,
                session_id: "session-c",
                role,
                content,
                context: &json!({}),
                data_class: "public",
                occurred_at: "2026-08-02T10:01:00Z",
            })
            .expect("append message");
    }
    let messages = database
        .session_messages_page("session-c", 0, 1)
        .expect("message page");
    assert_eq!(messages.items[0].sequence, 1);
    assert_eq!(messages.next_after, Some(1));
    let hits = database
        .search_session_messages("durable event", 10)
        .expect("literal FTS search");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].session_id, "session-c");

    database
        .archive_session("session-c", 1, "2026-08-02T11:00:00Z")
        .expect("archive session");
    assert_eq!(
        database
            .sessions_page(None, 10, false)
            .expect("active sessions")
            .items
            .len(),
        2
    );
    database
        .delete_session("session-c", 2)
        .expect("delete session");
    assert!(
        database
            .session_messages_page("session-c", 0, 10)
            .expect("deleted messages")
            .items
            .is_empty()
    );
}

#[test]
fn cursor_serialization_shape_is_stable() {
    let cursor = SessionCursor {
        updated_at: "2026-08-02T10:00:00Z".to_owned(),
        session_id: "session-c".to_owned(),
    };
    assert_eq!(
        serde_json::to_value(cursor).expect("serialize cursor"),
        json!({"updated_at": "2026-08-02T10:00:00Z", "session_id": "session-c"})
    );
}
