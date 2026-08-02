//! Durable SQLite ownership for the Rust-first Restork runtime.

use std::{
    collections::BTreeSet,
    fmt, fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

mod automation;
mod catalog;
mod daily;
mod mcp;
mod operation;
mod workspace;

pub use automation::{CheckpointFileBlob, CheckpointRecord, EvaluationRecord, SubtaskRecord};
pub use catalog::{
    CatalogCursor, DeliverableExportRecord, DeliverablePage, DeliverableRecord, ExtensionPage,
    ExtensionRecord, ExtensionRevisionRecord, SchedulePage, ScheduleRecord, ScheduleRunRecord,
};
pub use daily::{
    CalendarIntervalRecord, DailyCacheRecord, DailySourceRecord, MusicPreferenceRecord,
};
pub use mcp::{McpExecutionCreateResult, McpExecutionRecord, NewMcpExecution};
pub use operation::{
    ContextPreviewRecord, ConversationOperationRecord, NewContextPreview, NewConversationOperation,
    OperationCreateResult, OperationEventRecord,
};
pub use workspace::{
    ConfigurationProfileRecord, MessagePage, NewSession, NewSessionMessage, PersonalSettingsRecord,
    PromptRevisionRecord, ProviderProfileRecord, SessionCursor, SessionPage, SessionRecord,
    SessionSearchHit, StoredSessionMessage,
};

const SCHEMA_VERSION: i64 = 10;

const MIGRATION_LEDGER: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
);
"#;

const V1_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    event_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL CHECK (seq > 0),
    occurred_at TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    UNIQUE (run_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_spec_json TEXT,
    mode TEXT NOT NULL,
    state TEXT NOT NULL,
    state_version INTEGER NOT NULL CHECK (state_version >= 0),
    stop_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    decision TEXT NOT NULL,
    request_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS effect_intents (
    intent_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    phase TEXT NOT NULL,
    retry_contract TEXT NOT NULL,
    artifact_refs_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS event_snapshots (
    run_id TEXT PRIMARY KEY,
    covered_seq INTEGER NOT NULL CHECK (covered_seq >= 0),
    snapshot_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    response_json TEXT NOT NULL,
    PRIMARY KEY (operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS transient_blobs (
    blob_id TEXT PRIMARY KEY,
    run_id TEXT,
    source_id TEXT,
    expires_at TEXT NOT NULL,
    payload BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS run_budgets (
    run_id TEXT PRIMARY KEY,
    budget_json TEXT NOT NULL,
    started_at TEXT NOT NULL,
    steps INTEGER NOT NULL DEFAULT 0,
    retries INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    child_tasks INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS run_checkpoints (
    run_id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    blob_ref TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_records (
    memory_id TEXT PRIMARY KEY,
    layer TEXT NOT NULL CHECK (layer = 'episodic'),
    kind TEXT NOT NULL,
    summary TEXT NOT NULL,
    provenance TEXT NOT NULL,
    data_class TEXT NOT NULL CHECK (data_class NOT IN ('secret', 'credential')),
    retention_class TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT,
    last_accessed_at TEXT,
    run_id TEXT,
    source_id TEXT,
    content_hash TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS memory_records_source_id
    ON memory_records (source_id);
CREATE INDEX IF NOT EXISTS memory_records_retention
    ON memory_records (retention_class, expires_at, last_accessed_at);

CREATE TABLE IF NOT EXISTS conversation_turns (
    turn_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    mode TEXT NOT NULL,
    user_message_id TEXT NOT NULL UNIQUE,
    user_content TEXT NOT NULL,
    assistant_message_id TEXT UNIQUE,
    assistant_content TEXT,
    data_class TEXT NOT NULL CHECK (data_class NOT IN ('secret', 'credential')),
    prompt_id TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    dropped_messages INTEGER NOT NULL DEFAULT 0 CHECK (dropped_messages >= 0),
    estimated_context_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_context_tokens >= 0),
    total_tokens INTEGER CHECK (total_tokens >= 0),
    created_at TEXT NOT NULL,
    completed_at TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    binding TEXT NOT NULL,
    UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS conversation_turns_run_sequence
    ON conversation_turns (run_id, sequence);

CREATE TABLE IF NOT EXISTS radar_items (
    item_id TEXT PRIMARY KEY,
    lane TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    url TEXT NOT NULL,
    summary TEXT NOT NULL,
    score REAL NOT NULL,
    published_at TEXT,
    state TEXT NOT NULL,
    data_class TEXT NOT NULL CHECK (data_class NOT IN ('secret', 'credential')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_write_previews (
    approval_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    binding TEXT NOT NULL,
    task_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    operation TEXT NOT NULL,
    request_json TEXT NOT NULL,
    before_line TEXT NOT NULL,
    after_line TEXT NOT NULL,
    expected_hash TEXT NOT NULL,
    postimage_hash TEXT NOT NULL,
    action_digest TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_cache (
    cache_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS research_artifacts (
    artifact_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL UNIQUE,
    artifact_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_sessions (
    run_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    diagnostic_json TEXT NOT NULL,
    diagnostic_submission_hash TEXT,
    artifact_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_exercise_rubrics (
    exercise_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    required_terms_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    binding TEXT NOT NULL,
    answer_hash TEXT NOT NULL,
    correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
    result_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS study_review_state (
    run_id TEXT NOT NULL,
    exercise_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    interval_days INTEGER NOT NULL CHECK (interval_days >= 0),
    error_count INTEGER NOT NULL CHECK (error_count >= 0),
    successful_count INTEGER NOT NULL CHECK (successful_count >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, exercise_id)
);

CREATE TABLE IF NOT EXISTS work_sessions (
    run_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    preview_idempotency_key TEXT UNIQUE,
    preview_binding TEXT,
    preview_json TEXT,
    export_idempotency_key TEXT UNIQUE,
    export_binding TEXT,
    export_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_verifications (
    verification_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    binding TEXT NOT NULL,
    manifest_hash TEXT NOT NULL,
    report_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"#;

const IDEMPOTENCY_BINDING: &str = "ALTER TABLE idempotency_records ADD COLUMN binding TEXT;";
const PERSONAL_DAILY: &str = include_str!("../migrations/0003_personal_daily.sql");
const WORKSPACE: &str = include_str!("../migrations/0004_workspace.sql");
const EXTENSIONS: &str = include_str!("../migrations/0005_extensions.sql");
const DELIVERABLES: &str = include_str!("../migrations/0006_deliverables.sql");
const AUTOMATION: &str = include_str!("../migrations/0007_automation.sql");
const INTERACTIVE_CORE: &str = include_str!("../migrations/0008_interactive_core.sql");
const EXTENSION_RUNTIME: &str = include_str!("../migrations/0009_extension_runtime.sql");
const ARTIFACT_RECOVERY: &str = include_str!("../migrations/0010_artifact_recovery.sql");

#[derive(Clone, Copy)]
struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: [Migration; 10] = [
    Migration {
        version: 1,
        name: "v1_schema_adoption",
        sql: V1_SCHEMA,
    },
    Migration {
        version: 2,
        name: "idempotency_binding",
        sql: IDEMPOTENCY_BINDING,
    },
    Migration {
        version: 3,
        name: "personal_daily",
        sql: PERSONAL_DAILY,
    },
    Migration {
        version: 4,
        name: "conversation_workspace",
        sql: WORKSPACE,
    },
    Migration {
        version: 5,
        name: "extension_center",
        sql: EXTENSIONS,
    },
    Migration {
        version: 6,
        name: "deliverables",
        sql: DELIVERABLES,
    },
    Migration {
        version: 7,
        name: "automation_recovery",
        sql: AUTOMATION,
    },
    Migration {
        version: 8,
        name: "interactive_core",
        sql: INTERACTIVE_CORE,
    },
    Migration {
        version: 9,
        name: "extension_runtime",
        sql: EXTENSION_RUNTIME,
    },
    Migration {
        version: 10,
        name: "artifact_recovery",
        sql: ARTIFACT_RECOVERY,
    },
];

#[derive(Debug)]
pub enum StorageError {
    Sql(rusqlite::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    Invalid(&'static str),
    Conflict(&'static str),
    Poisoned,
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(error) => write!(formatter, "database operation failed: {error}"),
            Self::Io(error) => write!(formatter, "database file operation failed: {error}"),
            Self::Json(error) => write!(formatter, "stored JSON is invalid: {error}"),
            Self::Invalid(message) | Self::Conflict(message) => formatter.write_str(message),
            Self::Poisoned => formatter.write_str("database lock is unavailable"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

pub struct Database {
    path: PathBuf,
    connection: Mutex<Connection>,
    migration_backup: Option<PathBuf>,
}

#[derive(Clone, Copy)]
pub struct NewRun<'a> {
    pub run_id: &'a str,
    pub task_id: &'a str,
    pub task_spec: &'a Value,
    pub mode: &'a str,
    pub state: &'a str,
    pub occurred_at: &'a str,
}

#[derive(Clone, Copy)]
pub struct NewEvent<'a> {
    pub event_id: &'a str,
    pub run_id: &'a str,
    pub occurred_at: &'a str,
    pub kind: &'a str,
    pub metadata: &'a Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredEvent {
    pub event_id: String,
    pub run_id: String,
    pub sequence: i64,
    pub occurred_at: String,
    pub kind: String,
    pub metadata: Value,
    pub schema_version: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EventPage {
    pub items: Vec<StoredEvent>,
    pub next_after: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StoredSnapshot {
    pub run_id: String,
    pub covered_sequence: i64,
    pub snapshot: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReplayWindow {
    pub snapshot: Option<StoredSnapshot>,
    pub events: Vec<StoredEvent>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdempotentResponse {
    pub response: Value,
    pub replayed: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppliedMigration {
    pub version: i64,
    pub name: String,
    pub checksum: String,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StorageError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let had_data = path.metadata().is_ok_and(|metadata| metadata.len() > 0);
        let mut connection = Connection::open(&path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        let previous: i64 =
            connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if previous > SCHEMA_VERSION {
            return Err(StorageError::Invalid(
                "database schema is newer than this Core",
            ));
        }
        let migration_backup = if had_data && previous < SCHEMA_VERSION {
            Some(create_backup(&connection, &path)?)
        } else {
            None
        };
        migrate(&mut connection, previous)?;
        validate_migration_history(&connection)?;
        let database = Self {
            path,
            connection: Mutex::new(connection),
            migration_backup,
        };
        let restarted_at = OffsetDateTime::now_utc().format(&Rfc3339).map_err(|_| {
            StorageError::Invalid("system time is unavailable during operation recovery")
        })?;
        database.fail_abandoned_operations(&restarted_at)?;
        Ok(database)
    }

    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    #[must_use]
    pub fn migration_backup(&self) -> Option<&Path> {
        self.migration_backup.as_deref()
    }

    pub fn schema_version(&self) -> Result<i64, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(connection.pragma_query_value(None, "user_version", |row| row.get(0))?)
    }

    pub fn table_names(&self) -> Result<BTreeSet<String>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        let names = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<BTreeSet<_>, _>>()?;
        Ok(names)
    }

    pub fn migration_history(&self) -> Result<Vec<AppliedMigration>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC",
        )?;
        let history = statement
            .query_map([], |row| {
                Ok(AppliedMigration {
                    version: row.get(0)?,
                    name: row.get(1)?,
                    checksum: row.get(2)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(history)
    }

    pub fn run_exists(&self, run_id: &str) -> Result<bool, StorageError> {
        validate_identifier(run_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE run_id = ?1)",
            [run_id],
            |row| row.get(0),
        )?)
    }

    pub fn run_state(&self, run_id: &str) -> Result<Option<String>, StorageError> {
        validate_identifier(run_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        Ok(connection
            .query_row(
                "SELECT state FROM runs WHERE run_id = ?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn create_run(&self, run: NewRun<'_>) -> Result<(), StorageError> {
        validate_identifier(run.run_id)?;
        validate_identifier(run.task_id)?;
        validate_text(run.mode, 32)?;
        validate_text(run.state, 64)?;
        validate_timestamp(run.occurred_at)?;
        validate_object(run.task_spec, "task specification must be a JSON object")?;
        let task_spec = serde_json::to_string(run.task_spec)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO runs (run_id, task_id, task_spec_json, mode, state, state_version, \
             stop_reason, created_at, updated_at, schema_version) \
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL, ?6, ?6, 1)",
            params![
                run.run_id,
                run.task_id,
                task_spec,
                run.mode,
                run.state,
                run.occurred_at
            ],
        )?;
        Ok(())
    }

    pub fn append_event(&self, event: NewEvent<'_>) -> Result<StoredEvent, StorageError> {
        validate_identifier(event.event_id)?;
        validate_identifier(event.run_id)?;
        validate_text(event.kind, 128)?;
        validate_timestamp(event.occurred_at)?;
        validate_object(event.metadata, "event metadata must be a JSON object")?;
        let metadata = serde_json::to_string(event.metadata)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let run_exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE run_id = ?1)",
            [event.run_id],
            |row| row.get(0),
        )?;
        if !run_exists {
            return Err(StorageError::Invalid("event run does not exist"));
        }
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE run_id = ?1",
            [event.run_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO events \
             (event_id, run_id, seq, occurred_at, kind, metadata_json, schema_version) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)",
            params![
                event.event_id,
                event.run_id,
                sequence,
                event.occurred_at,
                event.kind,
                metadata,
            ],
        )?;
        transaction.commit()?;
        Ok(StoredEvent {
            event_id: event.event_id.to_owned(),
            run_id: event.run_id.to_owned(),
            sequence,
            occurred_at: event.occurred_at.to_owned(),
            kind: event.kind.to_owned(),
            metadata: event.metadata.clone(),
            schema_version: 1,
        })
    }

    pub fn events_after(
        &self,
        run_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<EventPage, StorageError> {
        validate_identifier(run_id)?;
        if after < 0 || !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("event page bounds are invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT event_id, run_id, seq, occurred_at, kind, metadata_json, schema_version \
             FROM events WHERE run_id = ?1 AND seq > ?2 ORDER BY seq ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                run_id,
                after,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            stored_event_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next_after = has_more.then(|| items.last().expect("non-empty bounded page").sequence);
        Ok(EventPage { items, next_after })
    }

    pub fn save_snapshot(
        &self,
        run_id: &str,
        covered_sequence: i64,
        snapshot: &Value,
    ) -> Result<StoredSnapshot, StorageError> {
        validate_identifier(run_id)?;
        if covered_sequence < 0 {
            return Err(StorageError::Invalid(
                "snapshot sequence must not be negative",
            ));
        }
        validate_object(snapshot, "event snapshot must be a JSON object")?;
        let snapshot_json = serde_json::to_string(snapshot)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let maximum: Option<i64> = transaction.query_row(
            "SELECT MAX(seq) FROM events WHERE run_id = ?1",
            [run_id],
            |row| row.get(0),
        )?;
        if maximum.is_none() || maximum.is_some_and(|value| covered_sequence > value) {
            return Err(StorageError::Invalid(
                "snapshot cannot cover events that do not exist",
            ));
        }
        let updated = transaction.execute(
            "INSERT INTO event_snapshots (run_id, covered_seq, snapshot_json) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(run_id) DO UPDATE SET \
                 covered_seq = excluded.covered_seq, snapshot_json = excluded.snapshot_json \
             WHERE excluded.covered_seq >= event_snapshots.covered_seq",
            params![run_id, covered_sequence, snapshot_json],
        )?;
        if updated != 1 {
            return Err(StorageError::Conflict(
                "snapshot sequence cannot move backwards",
            ));
        }
        transaction.commit()?;
        Ok(StoredSnapshot {
            run_id: run_id.to_owned(),
            covered_sequence,
            snapshot: snapshot.clone(),
        })
    }

    pub fn replay_window(
        &self,
        run_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<ReplayWindow, StorageError> {
        validate_identifier(run_id)?;
        if after < 0 || !(1..=10_000).contains(&limit) {
            return Err(StorageError::Invalid("replay window bounds are invalid"));
        }
        let snapshot = {
            let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
            connection
                .query_row(
                    "SELECT covered_seq, snapshot_json FROM event_snapshots \
                     WHERE run_id = ?1 AND covered_seq > ?2",
                    params![run_id, after],
                    |row| {
                        let covered_sequence = row.get(0)?;
                        let document: String = row.get(1)?;
                        let snapshot = serde_json::from_str(&document).map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                document.len(),
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?;
                        Ok(StoredSnapshot {
                            run_id: run_id.to_owned(),
                            covered_sequence,
                            snapshot,
                        })
                    },
                )
                .optional()?
        };
        let cursor = snapshot
            .as_ref()
            .map_or(after, |snapshot| snapshot.covered_sequence);
        let mut events = Vec::new();
        let mut next = cursor;
        while events.len() < limit {
            let remaining = (limit - events.len()).min(100);
            let page = self.events_after(run_id, next, remaining)?;
            if let Some(last) = page.items.last() {
                next = last.sequence;
            }
            events.extend(page.items);
            if page.next_after.is_none() {
                break;
            }
        }
        Ok(ReplayWindow { snapshot, events })
    }

    pub fn record_idempotent(
        &self,
        operation: &str,
        key: &str,
        binding: &str,
        response: &Value,
    ) -> Result<IdempotentResponse, StorageError> {
        validate_text(operation, 128)?;
        validate_text(key, 256)?;
        validate_text(binding, 256)?;
        let response_json = serde_json::to_string(response)?;
        let resource_id = response
            .get("run_id")
            .and_then(Value::as_str)
            .unwrap_or("response");
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT binding, response_json FROM idempotency_records \
                 WHERE operation = ?1 AND idempotency_key = ?2",
                params![operation, key],
                |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        if let Some((existing_binding, stored)) = existing {
            if existing_binding.as_deref() != Some(binding) {
                return Err(StorageError::Conflict(
                    "idempotency key was reused with another request",
                ));
            }
            return Ok(IdempotentResponse {
                response: serde_json::from_str(&stored)?,
                replayed: true,
            });
        }
        transaction.execute(
            "INSERT INTO idempotency_records \
             (operation, idempotency_key, resource_id, response_json, binding) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![operation, key, resource_id, response_json, binding],
        )?;
        transaction.commit()?;
        Ok(IdempotentResponse {
            response: response.clone(),
            replayed: false,
        })
    }
}

fn migrate(connection: &mut Connection, previous: i64) -> Result<(), StorageError> {
    connection.execute_batch(MIGRATION_LEDGER)?;
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > previous)
    {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if migration.version != 2
            || !table_columns(&transaction, "idempotency_records")?.contains("binding")
        {
            transaction.execute_batch(migration.sql)?;
        }
        let checksum = Sha256::digest(migration.sql.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        transaction.execute(
            "INSERT INTO schema_migrations (version, name, applied_at, checksum) \
             VALUES (?1, ?2, ?3, ?4)",
            params![migration.version, migration.name, now_rfc3339()?, checksum,],
        )?;
        transaction.pragma_update(None, "user_version", migration.version)?;
        transaction.commit()?;
    }
    Ok(())
}

fn validate_migration_history(connection: &Connection) -> Result<(), StorageError> {
    for migration in MIGRATIONS {
        let recorded = connection
            .query_row(
                "SELECT name, checksum FROM schema_migrations WHERE version = ?1",
                [migration.version],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()?;
        let checksum = Sha256::digest(migration.sql.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let matches = recorded.as_ref().is_some_and(|(name, recorded_checksum)| {
            name == migration.name
                && (recorded_checksum == &checksum
                    || legacy_equivalent_checksum(migration.version, recorded_checksum))
        });
        if !matches {
            return Err(StorageError::Conflict(
                "database migration history does not match this Core",
            ));
        }
    }
    Ok(())
}

fn legacy_equivalent_checksum(version: i64, checksum: &str) -> bool {
    // These checksums shipped in pre-release desktop builds. Their SQL differs
    // from the frozen migration only by one trailing blank line; both variants
    // produce byte-for-byte identical sqlite_schema rows. Keep the allowlist
    // exact so arbitrary ledger edits and genuinely drifted migrations still
    // fail closed.
    matches!(
        (version, checksum),
        (
            3,
            "97581e498ba21a4e921ba3829d06be87f9cc22a711e564072b133343be554f0a"
        ) | (
            5,
            "5b123f947c66bf0e9fa381c61de1fdd32394758953659cd6477c4e60b1af8256"
        ) | (
            7,
            "c708cd1c349f281ecbe342bc8b4b5d3eebb5104e3bbd15fc1c54bec0bf85d3fb"
        ) | (
            8,
            "1bd1046039d2e6be8f10fe35a9d99255419c57ae12ee9f048faf7f7666df0acd"
        )
    )
}

fn table_columns(
    transaction: &rusqlite::Transaction<'_>,
    table: &str,
) -> Result<BTreeSet<String>, StorageError> {
    let mut statement = transaction.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    Ok(columns)
}

fn create_backup(connection: &Connection, path: &Path) -> Result<PathBuf, StorageError> {
    let stamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
    let filename = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(StorageError::Invalid("database filename is invalid"))?;
    let backup = path.with_file_name(format!("{filename}.pre-v{SCHEMA_VERSION}-{stamp}.bak"));
    let backup_text = backup
        .to_str()
        .ok_or(StorageError::Invalid("database backup path is invalid"))?;
    connection.execute("VACUUM INTO ?1", [backup_text])?;
    Ok(backup)
}

fn stored_event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredEvent> {
    let metadata_json: String = row.get(5)?;
    let metadata = serde_json::from_str(&metadata_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            metadata_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(StoredEvent {
        event_id: row.get(0)?,
        run_id: row.get(1)?,
        sequence: row.get(2)?,
        occurred_at: row.get(3)?,
        kind: row.get(4)?,
        metadata,
        schema_version: row.get(6)?,
    })
}

fn validate_identifier(value: &str) -> Result<(), StorageError> {
    validate_text(value, 256)
}

fn validate_text(value: &str, maximum: usize) -> Result<(), StorageError> {
    if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
        return Err(StorageError::Invalid(
            "database input is empty or outside its size limit",
        ));
    }
    Ok(())
}

fn validate_timestamp(value: &str) -> Result<(), StorageError> {
    validate_text(value, 64)?;
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| StorageError::Invalid("timestamp must be RFC 3339"))?;
    Ok(())
}

fn validate_object(value: &Value, message: &'static str) -> Result<(), StorageError> {
    if value.is_object() {
        Ok(())
    } else {
        Err(StorageError::Invalid(message))
    }
}

fn now_rfc3339() -> Result<String, StorageError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| StorageError::Invalid("timestamp formatting failed"))
}
