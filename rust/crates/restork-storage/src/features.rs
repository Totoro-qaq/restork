//! Durable records for the feature domains retained by the Rust Core.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Database, StorageError, validate_identifier, validate_text, validate_timestamp};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MemoryRecord {
    pub memory_id: String,
    pub layer: String,
    pub kind: String,
    pub summary: String,
    pub provenance: String,
    pub data_class: String,
    pub retention_class: String,
    pub created_at: String,
    pub updated_at: String,
    pub expires_at: Option<String>,
    pub last_accessed_at: Option<String>,
    pub run_id: Option<String>,
    pub source_id: Option<String>,
    pub content_hash: String,
    pub version: i64,
}

#[derive(Clone, Copy)]
pub struct NewMemoryRecord<'a> {
    pub memory_id: &'a str,
    pub kind: &'a str,
    pub summary: &'a str,
    pub provenance: &'a str,
    pub data_class: &'a str,
    pub retention_class: &'a str,
    pub expires_at: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub source_id: Option<&'a str>,
    pub content_hash: &'a str,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct RadarRecord {
    pub item_id: String,
    pub lane: String,
    pub title: String,
    pub source: String,
    pub url: String,
    pub summary: String,
    pub score: f64,
    pub stars_total: Option<i64>,
    pub stars_daily: Option<i64>,
    pub stars_weekly: Option<i64>,
    pub published_at: Option<String>,
    pub state: String,
    pub data_class: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy)]
pub struct NewRadarRecord<'a> {
    pub item_id: &'a str,
    pub lane: &'a str,
    pub title: &'a str,
    pub source: &'a str,
    pub url: &'a str,
    pub summary: &'a str,
    pub score: f64,
    pub stars_total: Option<i64>,
    pub published_at: Option<&'a str>,
    pub state: &'a str,
    pub data_class: &'a str,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LocalTodoRecord {
    pub task_id: String,
    pub title: String,
    pub details: String,
    pub priority: Option<String>,
    pub due_at: Option<String>,
    pub status: String,
    pub origin: String,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
}

#[derive(Clone, Copy)]
pub struct NewLocalTodo<'a> {
    pub task_id: &'a str,
    pub title: &'a str,
    pub details: &'a str,
    pub priority: Option<&'a str>,
    pub due_at: Option<&'a str>,
    pub status: &'a str,
    pub origin: &'a str,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TaskPreviewRecord {
    pub approval_id: String,
    pub idempotency_key: String,
    pub binding: String,
    pub task_id: String,
    pub relative_path: String,
    pub operation: String,
    pub request: Value,
    pub before_line: String,
    pub after_line: String,
    pub expected_hash: String,
    pub postimage_hash: String,
    pub action_digest: String,
    pub policy_version: String,
    pub nonce: String,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApprovalRecord {
    pub approval_id: String,
    pub run_id: String,
    pub expires_at: String,
    pub decision: String,
    #[serde(flatten)]
    pub request: BTreeMap<String, Value>,
}

#[derive(Clone, Copy)]
pub struct NewTaskPreview<'a> {
    pub approval_id: &'a str,
    pub idempotency_key: &'a str,
    pub binding: &'a str,
    pub task_id: &'a str,
    pub relative_path: &'a str,
    pub operation: &'a str,
    pub request: &'a Value,
    pub before_line: &'a str,
    pub after_line: &'a str,
    pub expected_hash: &'a str,
    pub postimage_hash: &'a str,
    pub action_digest: &'a str,
    pub policy_version: &'a str,
    pub nonce: &'a str,
    pub created_at: &'a str,
    pub expires_at: &'a str,
}

#[derive(Clone, Copy)]
pub struct NewWorkVerification<'a> {
    pub verification_id: &'a str,
    pub run_id: &'a str,
    pub idempotency_key: &'a str,
    pub binding: &'a str,
    pub manifest_hash: &'a str,
    pub created_at: &'a str,
}

impl Database {
    pub fn local_todo_count(&self) -> Result<usize, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let count = connection.query_row(
            "SELECT COUNT(*) FROM local_todos WHERE deleted_at IS NULL",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        usize::try_from(count).map_err(|_| StorageError::Invalid("invalid local Todo count"))
    }

    pub fn local_todos(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<LocalTodoRecord>, StorageError> {
        if !(1..=500).contains(&limit) {
            return Err(StorageError::Invalid("invalid local Todo page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT task_id, title, details, priority, due_at, status, origin, created_at, updated_at, deleted_at
             FROM local_todos WHERE deleted_at IS NULL
             ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END,
                      updated_at DESC, task_id
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows =
            statement.query_map(params![limit as i64, offset as i64], local_todo_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn deleted_local_todos(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<LocalTodoRecord>, StorageError> {
        if !(1..=101).contains(&limit) {
            return Err(StorageError::Invalid("invalid deleted Todo page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT task_id, title, details, priority, due_at, status, origin, created_at, updated_at, deleted_at
             FROM local_todos WHERE deleted_at IS NOT NULL
             ORDER BY deleted_at DESC, task_id
             LIMIT ?1 OFFSET ?2",
        )?;
        let rows =
            statement.query_map(params![limit as i64, offset as i64], local_todo_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn local_todo(&self, task_id: &str) -> Result<Option<LocalTodoRecord>, StorageError> {
        validate_identifier(task_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        local_todo_by_id(&connection, task_id)
    }

    pub fn put_local_todo(
        &self,
        todo: NewLocalTodo<'_>,
        expected_updated_at: Option<&str>,
    ) -> Result<LocalTodoRecord, StorageError> {
        validate_local_todo(todo)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = if let Some(expected_updated_at) = expected_updated_at {
            validate_timestamp(expected_updated_at)?;
            connection.execute(
                "UPDATE local_todos SET title=?2, details=?3, priority=?4, due_at=?5,
                        status=?6, updated_at=?7
                 WHERE task_id=?1 AND updated_at=?8 AND deleted_at IS NULL",
                params![
                    todo.task_id,
                    todo.title,
                    todo.details,
                    todo.priority,
                    todo.due_at,
                    todo.status,
                    todo.occurred_at,
                    expected_updated_at,
                ],
            )?
        } else {
            connection.execute(
                "INSERT INTO local_todos
                    (task_id, title, details, priority, due_at, status, origin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    todo.task_id,
                    todo.title,
                    todo.details,
                    todo.priority,
                    todo.due_at,
                    todo.status,
                    todo.origin,
                    todo.occurred_at,
                ],
            )?
        };
        if changed == 0 {
            return Err(StorageError::Conflict(
                "local Todo changed; refresh and try again",
            ));
        }
        local_todo_by_id(&connection, todo.task_id)?
            .ok_or(StorageError::Invalid("local Todo did not persist"))
    }

    pub fn delete_local_todo(
        &self,
        task_id: &str,
        expected_updated_at: &str,
    ) -> Result<(), StorageError> {
        validate_identifier(task_id)?;
        validate_timestamp(expected_updated_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let deleted_at = super::now_rfc3339()?;
        let changed = connection.execute(
            "UPDATE local_todos SET deleted_at=?3, updated_at=?3
             WHERE task_id=?1 AND updated_at=?2 AND deleted_at IS NULL",
            params![task_id, expected_updated_at, deleted_at],
        )?;
        if changed == 0 {
            return Err(StorageError::Conflict(
                "local Todo changed; refresh and try again",
            ));
        }
        Ok(())
    }

    pub fn restore_local_todo(
        &self,
        task_id: &str,
        expected_updated_at: &str,
    ) -> Result<LocalTodoRecord, StorageError> {
        validate_identifier(task_id)?;
        validate_timestamp(expected_updated_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let restored_at = super::now_rfc3339()?;
        let changed = connection.execute(
            "UPDATE local_todos SET deleted_at=NULL, updated_at=?3
             WHERE task_id=?1 AND updated_at=?2 AND deleted_at IS NOT NULL",
            params![task_id, expected_updated_at, restored_at],
        )?;
        if changed == 0 {
            return Err(StorageError::Conflict(
                "local Todo changed; refresh and try again",
            ));
        }
        local_todo_by_id(&connection, task_id)?
            .ok_or(StorageError::Invalid("local Todo did not restore"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_conversation_turn(
        &self,
        turn_id: &str,
        run_id: &str,
        mode: &str,
        user_message_id: &str,
        user_content: &str,
        assistant_message_id: &str,
        assistant_content: &str,
        data_class: &str,
        prompt_id: &str,
        prompt_version: &str,
        prompt_hash: &str,
        dropped_messages: i64,
        estimated_context_tokens: i64,
        total_tokens: Option<i64>,
        idempotency_key: &str,
        binding: &str,
        occurred_at: &str,
    ) -> Result<Value, StorageError> {
        if user_content.is_empty()
            || user_content.len() > 1_000_000
            || assistant_content.len() > 1_000_000
            || !matches!(data_class, "public" | "personal" | "confidential")
            || dropped_messages < 0
            || estimated_context_tokens < 0
        {
            return Err(StorageError::Invalid("invalid conversation turn"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let sequence: i64 = connection.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM conversation_turns WHERE run_id=?1",
            [run_id],
            |row| row.get(0),
        )?;
        match connection.execute(
            "INSERT INTO conversation_turns (turn_id, run_id, sequence, mode, user_message_id,
                    user_content, assistant_message_id, assistant_content, data_class, prompt_id,
                    prompt_version, prompt_hash, dropped_messages, estimated_context_tokens,
                    total_tokens, created_at, completed_at, idempotency_key, binding)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                    ?15, ?16, ?16, ?17, ?18)",
            params![
                turn_id,
                run_id,
                sequence,
                mode,
                user_message_id,
                user_content,
                assistant_message_id,
                assistant_content,
                data_class,
                prompt_id,
                prompt_version,
                prompt_hash,
                dropped_messages,
                estimated_context_tokens,
                total_tokens,
                occurred_at,
                idempotency_key,
                binding,
            ],
        ) {
            Ok(_) => conversation_turn_by_id(&connection, turn_id)?
                .ok_or(StorageError::Invalid("conversation turn did not persist")),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                let existing = conversation_turn_by_key(&connection, idempotency_key)?
                    .ok_or(StorageError::Conflict("conversation idempotency conflict"))?;
                if existing["binding"].as_str() != Some(binding) {
                    return Err(StorageError::Conflict(
                        "conversation idempotency binding changed",
                    ));
                }
                Ok(existing)
            }
            Err(error) => Err(error.into()),
        }
    }

    pub fn conversation_turns(
        &self,
        run_id: &str,
        before: Option<i64>,
        limit: usize,
    ) -> Result<Vec<Value>, StorageError> {
        if !(1..=100).contains(&limit) || before.is_some_and(|value| value <= 0) {
            return Err(StorageError::Invalid("invalid conversation page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT turn_id, run_id, sequence, mode, user_message_id, user_content,
                    assistant_message_id, assistant_content, data_class, prompt_id, prompt_version,
                    prompt_hash, dropped_messages, estimated_context_tokens, total_tokens,
                    created_at, completed_at, binding
             FROM conversation_turns WHERE run_id=?1 AND (?2 IS NULL OR sequence < ?2)
             ORDER BY sequence DESC LIMIT ?3",
        )?;
        let mut turns = statement
            .query_map(
                params![run_id, before, limit as i64],
                conversation_turn_from_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        turns.reverse();
        Ok(turns)
    }
    pub fn approval(&self, approval_id: &str) -> Result<Option<ApprovalRecord>, StorageError> {
        if approval_id.is_empty() || approval_id.len() > 256 {
            return Err(StorageError::Invalid("invalid approval identifier"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        approval_by_id(&connection, approval_id)
    }

    pub fn save_approval(
        &self,
        approval_id: &str,
        run_id: &str,
        expires_at: &str,
        request: &Value,
    ) -> Result<ApprovalRecord, StorageError> {
        if approval_id.is_empty() || run_id.is_empty() || !request.is_object() {
            return Err(StorageError::Invalid("invalid approval request"));
        }
        let document = serde_json::to_string(request)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO approvals (approval_id, run_id, expires_at, decision, request_json)
             VALUES (?1, ?2, ?3, 'pending', ?4)
             ON CONFLICT(approval_id) DO UPDATE SET
                 expires_at=excluded.expires_at, request_json=excluded.request_json
             WHERE approvals.decision = 'pending'",
            params![approval_id, run_id, expires_at, document],
        )?;
        approval_by_id(&connection, approval_id)?
            .ok_or(StorageError::Invalid("approval did not persist"))
    }

    pub fn approvals(
        &self,
        pending_only: bool,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<ApprovalRecord>, StorageError> {
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("invalid approval page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let sql = if pending_only {
            "SELECT approval_id, run_id, expires_at, decision, request_json FROM approvals
             WHERE decision = 'pending' ORDER BY expires_at, approval_id LIMIT ?1 OFFSET ?2"
        } else {
            "SELECT approval_id, run_id, expires_at, decision, request_json FROM approvals
             ORDER BY expires_at DESC, approval_id LIMIT ?1 OFFSET ?2"
        };
        let mut statement = connection.prepare(sql)?;
        let rows = statement.query_map(params![limit as i64, offset as i64], approval_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn decide_approval(
        &self,
        approval_id: &str,
        decision: &str,
    ) -> Result<ApprovalRecord, StorageError> {
        if !matches!(decision, "approved" | "rejected") {
            return Err(StorageError::Invalid("invalid approval decision"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "UPDATE approvals SET decision = ?1 WHERE approval_id = ?2 AND decision = 'pending'",
            params![decision, approval_id],
        )? != 1
        {
            return Err(StorageError::Conflict(
                "approval is missing or already decided",
            ));
        }
        approval_by_id(&connection, approval_id)?
            .ok_or(StorageError::Invalid("approval disappeared"))
    }

    pub fn consume_approval(&self, approval_id: &str) -> Result<ApprovalRecord, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "UPDATE approvals SET decision = 'consumed'
             WHERE approval_id = ?1 AND decision = 'approved'",
            [approval_id],
        )? != 1
        {
            return Err(StorageError::Conflict(
                "approval is missing, unapproved, or already consumed",
            ));
        }
        approval_by_id(&connection, approval_id)?
            .ok_or(StorageError::Invalid("approval disappeared"))
    }

    /// Revoke authority that was reviewed against a previous Vault root.
    ///
    /// A desktop Vault switch keeps durable history but must never carry an
    /// unconsumed approval or its write preview into the newly granted root.
    pub fn invalidate_vault_bound_authority(&self) -> Result<usize, StorageError> {
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let invalidated = transaction.execute(
            "UPDATE approvals SET decision = 'rejected'
             WHERE decision IN ('pending', 'approved')",
            [],
        )?;
        transaction.execute("DELETE FROM task_write_previews", [])?;
        transaction.commit()?;
        Ok(invalidated)
    }

    pub fn create_memory(&self, memory: NewMemoryRecord<'_>) -> Result<MemoryRecord, StorageError> {
        validate_memory(&memory)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO memory_records (
                memory_id, layer, kind, summary, provenance, data_class, retention_class,
                created_at, updated_at, expires_at, last_accessed_at, run_id, source_id,
                content_hash, version
             ) VALUES (?1, 'episodic', ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?7, ?9, ?10, ?11, 1)",
            params![
                memory.memory_id,
                memory.kind,
                memory.summary,
                memory.provenance,
                memory.data_class,
                memory.retention_class,
                memory.occurred_at,
                memory.expires_at,
                memory.run_id,
                memory.source_id,
                memory.content_hash,
            ],
        )?;
        memory_by_id(&connection, memory.memory_id)?
            .ok_or(StorageError::Invalid("memory insert did not persist"))
    }

    pub fn memory_records(
        &self,
        limit: usize,
        offset: usize,
        now: &str,
    ) -> Result<Vec<MemoryRecord>, StorageError> {
        if !(1..=100).contains(&limit) || now.is_empty() {
            return Err(StorageError::Invalid("invalid memory page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "DELETE FROM memory_records WHERE retention_class IN ('transient', 'cache') AND expires_at IS NOT NULL AND expires_at <= ?1",
            [now],
        )?;
        let mut statement = connection.prepare(
            "SELECT memory_id, layer, kind, summary, provenance, data_class, retention_class,
                    created_at, updated_at, expires_at, last_accessed_at, run_id, source_id,
                    content_hash, version
             FROM memory_records ORDER BY updated_at DESC, memory_id LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit as i64, offset as i64], memory_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn memory_record(&self, memory_id: &str) -> Result<Option<MemoryRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        memory_by_id(&connection, memory_id)
    }

    pub fn memory_counts(&self) -> Result<BTreeMap<String, usize>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut counts = BTreeMap::from([
            ("working".to_owned(), 0),
            ("episodic".to_owned(), 0),
            ("semantic".to_owned(), 0),
            ("profile".to_owned(), 0),
        ]);
        let episodic = connection.query_row("SELECT COUNT(*) FROM memory_records", [], |row| {
            row.get::<_, i64>(0)
        })?;
        counts.insert(
            "episodic".to_owned(),
            usize::try_from(episodic).unwrap_or(usize::MAX),
        );
        Ok(counts)
    }

    pub fn correct_memory(
        &self,
        memory_id: &str,
        expected_hash: &str,
        summary: &str,
        data_class: &str,
        next_hash: &str,
        occurred_at: &str,
    ) -> Result<MemoryRecord, StorageError> {
        if summary.len() > 32_000 || !valid_data_class(data_class) || !valid_hash(next_hash) {
            return Err(StorageError::Invalid("invalid memory correction"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE memory_records SET summary = ?1, data_class = ?2, content_hash = ?3,
                    updated_at = ?4, last_accessed_at = ?4, version = version + 1
             WHERE memory_id = ?5 AND content_hash = ?6 AND retention_class != 'protected'",
            params![
                summary,
                data_class,
                next_hash,
                occurred_at,
                memory_id,
                expected_hash
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("memory changed or is protected"));
        }
        memory_by_id(&connection, memory_id)?.ok_or(StorageError::Invalid("memory disappeared"))
    }

    pub fn delete_memory(
        &self,
        memory_id: &str,
        expected_hash: &str,
    ) -> Result<bool, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "DELETE FROM memory_records WHERE memory_id = ?1 AND content_hash = ?2 AND retention_class != 'protected'",
            params![memory_id, expected_hash],
        )?;
        if changed == 0 {
            return Err(StorageError::Conflict("memory changed or is protected"));
        }
        Ok(true)
    }

    pub fn purge_memory_source(&self, source_id: &str) -> Result<usize, StorageError> {
        if source_id.is_empty() || source_id.len() > 512 {
            return Err(StorageError::Invalid("invalid memory source"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .execute(
                "DELETE FROM memory_records WHERE source_id = ?1 AND retention_class != 'protected'",
                [source_id],
            )
            .map_err(Into::into)
    }

    pub fn upsert_radar(&self, item: NewRadarRecord<'_>) -> Result<RadarRecord, StorageError> {
        if item.item_id.is_empty()
            || item.title.is_empty()
            || item.title.len() > 1_000
            || item.summary.len() > 8_000
            || !matches!(item.lane, "my_stars" | "trending" | "hn" | "papers")
            || !matches!(
                item.state,
                "new" | "read_later" | "dismissed" | "researched"
            )
            || !valid_data_class(item.data_class)
            || !item.url.starts_with("https://")
            || !item.score.is_finite()
        {
            return Err(StorageError::Invalid("invalid Radar item"));
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO radar_items (
                item_id, lane, title, source, url, summary, score, stars_total, published_at,
                state, data_class, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
             ON CONFLICT(item_id) DO UPDATE SET
                lane=excluded.lane, title=excluded.title, source=excluded.source,
                url=excluded.url, summary=excluded.summary, score=excluded.score,
                stars_total=excluded.stars_total, published_at=excluded.published_at,
                updated_at=excluded.updated_at",
            params![
                item.item_id,
                item.lane,
                item.title,
                item.source,
                item.url,
                item.summary,
                item.score,
                item.stars_total,
                item.published_at,
                item.state,
                item.data_class,
                item.occurred_at,
            ],
        )?;
        if let Some(stars_total) = item.stars_total {
            let observed_on = item
                .occurred_at
                .get(..10)
                .ok_or(StorageError::Invalid("invalid Radar snapshot timestamp"))?;
            transaction.execute(
                "INSERT INTO radar_star_snapshots (item_id, observed_on, stars_total, observed_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(item_id, observed_on) DO UPDATE SET
                    stars_total=excluded.stars_total, observed_at=excluded.observed_at",
                params![item.item_id, observed_on, stars_total, item.occurred_at],
            )?;
            let stars_daily = radar_star_baseline(
                &transaction,
                item.item_id,
                observed_on,
                stars_total,
                "-1 day",
            )?;
            let stars_weekly = radar_star_baseline(
                &transaction,
                item.item_id,
                observed_on,
                stars_total,
                "-7 day",
            )?;
            transaction.execute(
                "UPDATE radar_items SET stars_daily = ?2, stars_weekly = ?3 WHERE item_id = ?1",
                params![item.item_id, stars_daily, stars_weekly],
            )?;
        }
        transaction.commit()?;
        radar_by_id(&connection, item.item_id)?
            .ok_or(StorageError::Invalid("Radar insert did not persist"))
    }

    pub fn radar_items(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<RadarRecord>, StorageError> {
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("invalid Radar page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT item_id, lane, title, source, url, summary, score, stars_total,
                    stars_daily, stars_weekly, published_at, state, data_class, created_at, updated_at
             FROM radar_items WHERE state != 'dismissed'
             ORDER BY score DESC, updated_at DESC, item_id LIMIT ?1 OFFSET ?2",
        )?;
        let rows = statement.query_map(params![limit as i64, offset as i64], radar_from_row)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub fn delete_radar_lane(&self, lane: &str) -> Result<usize, StorageError> {
        if !matches!(lane, "my_stars" | "trending" | "hn" | "papers") {
            return Err(StorageError::Invalid("invalid Radar lane"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .execute("DELETE FROM radar_items WHERE lane = ?1", [lane])
            .map_err(Into::into)
    }

    pub fn delete_new_radar_lane(&self, lane: &str) -> Result<usize, StorageError> {
        if !matches!(lane, "my_stars" | "trending" | "hn" | "papers") {
            return Err(StorageError::Invalid("invalid Radar lane"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .execute(
                "DELETE FROM radar_items WHERE lane = ?1 AND state = 'new'",
                [lane],
            )
            .map_err(Into::into)
    }

    pub fn delete_stale_new_radar_lane(
        &self,
        lane: &str,
        refreshed_at: &str,
    ) -> Result<usize, StorageError> {
        if !matches!(lane, "my_stars" | "trending" | "hn" | "papers") {
            return Err(StorageError::Invalid("invalid Radar lane"));
        }
        validate_timestamp(refreshed_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .execute(
                "DELETE FROM radar_items WHERE lane = ?1 AND state = 'new' AND updated_at < ?2",
                params![lane, refreshed_at],
            )
            .map_err(Into::into)
    }

    pub fn update_radar_state(
        &self,
        item_id: &str,
        state: &str,
        occurred_at: &str,
    ) -> Result<RadarRecord, StorageError> {
        if !matches!(state, "new" | "read_later" | "dismissed" | "researched") {
            return Err(StorageError::Invalid("invalid Radar state"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "UPDATE radar_items SET state = ?1, updated_at = ?2 WHERE item_id = ?3",
            params![state, occurred_at, item_id],
        )? != 1
        {
            return Err(StorageError::Invalid("Radar item not found"));
        }
        radar_by_id(&connection, item_id)?.ok_or(StorageError::Invalid("Radar item disappeared"))
    }

    pub fn save_task_preview(
        &self,
        preview: NewTaskPreview<'_>,
    ) -> Result<TaskPreviewRecord, StorageError> {
        let request = serde_json::to_string(preview.request)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO task_write_previews (
                approval_id, idempotency_key, binding, task_id, relative_path, operation,
                request_json, before_line, after_line, expected_hash, postimage_hash,
                action_digest, policy_version, nonce, created_at, expires_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                preview.approval_id,
                preview.idempotency_key,
                preview.binding,
                preview.task_id,
                preview.relative_path,
                preview.operation,
                request,
                preview.before_line,
                preview.after_line,
                preview.expected_hash,
                preview.postimage_hash,
                preview.action_digest,
                preview.policy_version,
                preview.nonce,
                preview.created_at,
                preview.expires_at,
            ],
        )?;
        task_preview_by_id(&connection, preview.approval_id)?
            .ok_or(StorageError::Invalid("task preview did not persist"))
    }

    pub fn task_preview(
        &self,
        approval_id: &str,
    ) -> Result<Option<TaskPreviewRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        task_preview_by_id(&connection, approval_id)
    }

    pub fn consume_task_preview(&self, approval_id: &str) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "DELETE FROM task_write_previews WHERE approval_id = ?1",
            [approval_id],
        )? != 1
        {
            return Err(StorageError::Conflict("task approval was already used"));
        }
        Ok(())
    }

    pub fn save_research_artifact(
        &self,
        artifact_id: &str,
        run_id: &str,
        artifact: &Value,
        created_at: &str,
    ) -> Result<Value, StorageError> {
        let document = serde_json::to_string(artifact)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO research_artifacts (artifact_id, run_id, artifact_json, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(run_id) DO UPDATE SET artifact_id=excluded.artifact_id,
                 artifact_json=excluded.artifact_json, created_at=excluded.created_at",
            params![artifact_id, run_id, document, created_at],
        )?;
        Ok(artifact.clone())
    }

    pub fn research_artifact(&self, run_id: &str) -> Result<Option<Value>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let document = connection
            .query_row(
                "SELECT artifact_json FROM research_artifacts WHERE run_id = ?1",
                [run_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        document
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn save_study_session(
        &self,
        run_id: &str,
        request_hash: &str,
        request: &Value,
        diagnostic: &Value,
        artifact: Option<&Value>,
        occurred_at: &str,
    ) -> Result<(), StorageError> {
        let request = serde_json::to_string(request)?;
        let diagnostic = serde_json::to_string(diagnostic)?;
        let artifact = artifact.map(serde_json::to_string).transpose()?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO study_sessions (run_id, request_hash, request_json, diagnostic_json,
                artifact_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(run_id) DO UPDATE SET diagnostic_json=excluded.diagnostic_json,
                artifact_json=excluded.artifact_json, updated_at=excluded.updated_at",
            params![
                run_id,
                request_hash,
                request,
                diagnostic,
                artifact,
                occurred_at
            ],
        )?;
        Ok(())
    }

    pub fn study_session(&self, run_id: &str) -> Result<Option<Value>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT request_hash, request_json, diagnostic_json, diagnostic_submission_hash,
                        artifact_json, created_at, updated_at FROM study_sessions WHERE run_id = ?1",
                [run_id],
                |row| {
                    let request: String = row.get(1)?;
                    let diagnostic: String = row.get(2)?;
                    let artifact: Option<String> = row.get(4)?;
                    Ok(serde_json::json!({
                        "run_id": run_id,
                        "request_hash": row.get::<_, String>(0)?,
                        "request": serde_json::from_str::<Value>(&request).unwrap_or(Value::Null),
                        "diagnostic": serde_json::from_str::<Value>(&diagnostic).unwrap_or(Value::Null),
                        "diagnostic_submitted": row.get::<_, Option<String>>(3)?.is_some(),
                        "artifact": artifact.and_then(|value| serde_json::from_str::<Value>(&value).ok()),
                        "created_at": row.get::<_, String>(5)?,
                        "updated_at": row.get::<_, String>(6)?,
                    }))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_study_artifact(
        &self,
        run_id: &str,
        submission_hash: &str,
        artifact: &Value,
        rubrics: &[(String, Value)],
        occurred_at: &str,
    ) -> Result<Value, StorageError> {
        if !valid_hash(submission_hash) || !artifact.is_object() || rubrics.len() > 100 {
            return Err(StorageError::Invalid("invalid Study artifact"));
        }
        let document = serde_json::to_string(artifact)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction()?;
        if transaction.execute(
            "UPDATE study_sessions SET diagnostic_submission_hash=?1, artifact_json=?2,
                    updated_at=?3 WHERE run_id=?4 AND diagnostic_submission_hash IS NULL",
            params![submission_hash, document, occurred_at, run_id],
        )? != 1
        {
            return Err(StorageError::Conflict(
                "Study diagnostic was already submitted or the run is missing",
            ));
        }
        for (exercise_id, rubric) in rubrics {
            transaction.execute(
                "INSERT INTO study_exercise_rubrics (exercise_id, run_id, required_terms_json)
                 VALUES (?1, ?2, ?3)",
                params![exercise_id, run_id, serde_json::to_string(rubric)?],
            )?;
        }
        transaction.commit()?;
        Ok(artifact.clone())
    }

    pub fn study_exercise(
        &self,
        run_id: &str,
        exercise_id: &str,
    ) -> Result<Option<Value>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let rubric = connection
            .query_row(
                "SELECT required_terms_json FROM study_exercise_rubrics
                 WHERE run_id=?1 AND exercise_id=?2",
                params![run_id, exercise_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        rubric
            .map(|value| serde_json::from_str(&value).map_err(Into::into))
            .transpose()
    }

    pub fn study_attempt_counts(
        &self,
        run_id: &str,
        exercise_id: &str,
    ) -> Result<(i64, i64), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END), 0)
                 FROM study_attempts WHERE run_id=?1 AND exercise_id=?2",
                params![run_id, exercise_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_study_attempt(
        &self,
        attempt_id: &str,
        run_id: &str,
        exercise_id: &str,
        idempotency_key: &str,
        binding: &str,
        answer_hash: &str,
        correct: bool,
        result: &Value,
        due_at: &str,
        interval_days: i64,
        occurred_at: &str,
    ) -> Result<Value, StorageError> {
        if !valid_hash(answer_hash) || !valid_hash(binding) || !result.is_object() {
            return Err(StorageError::Invalid("invalid Study attempt"));
        }
        let document = serde_json::to_string(result)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO study_attempts (attempt_id, run_id, exercise_id, idempotency_key,
                    binding, answer_hash, correct, result_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                attempt_id,
                run_id,
                exercise_id,
                idempotency_key,
                binding,
                answer_hash,
                i64::from(correct),
                document,
                occurred_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO study_review_state (run_id, exercise_id, due_at, interval_days,
                    error_count, successful_count, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(run_id, exercise_id) DO UPDATE SET due_at=excluded.due_at,
                    interval_days=excluded.interval_days,
                    error_count=study_review_state.error_count + excluded.error_count,
                    successful_count=study_review_state.successful_count + excluded.successful_count,
                    updated_at=excluded.updated_at",
            params![
                run_id,
                exercise_id,
                due_at,
                interval_days,
                i64::from(!correct),
                i64::from(correct),
                occurred_at,
            ],
        )?;
        transaction.commit()?;
        Ok(result.clone())
    }

    pub fn save_work_session(
        &self,
        run_id: &str,
        request_hash: &str,
        request: &Value,
        plan: &Value,
        snapshot: &Value,
        occurred_at: &str,
    ) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO work_sessions (run_id, request_hash, request_json, plan_json, snapshot_json,
                created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
             ON CONFLICT(run_id) DO UPDATE SET request_hash=excluded.request_hash,
                request_json=excluded.request_json, plan_json=excluded.plan_json,
                snapshot_json=excluded.snapshot_json, updated_at=excluded.updated_at",
            params![
                run_id,
                request_hash,
                serde_json::to_string(request)?,
                serde_json::to_string(plan)?,
                serde_json::to_string(snapshot)?,
                occurred_at,
            ],
        )?;
        Ok(())
    }

    pub fn work_session(&self, run_id: &str) -> Result<Option<Value>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT request_hash, request_json, plan_json, snapshot_json, preview_json,
                        export_json, created_at, updated_at FROM work_sessions WHERE run_id = ?1",
                [run_id],
                |row| {
                    let parse = |value: String| {
                        serde_json::from_str::<Value>(&value).unwrap_or(Value::Null)
                    };
                    Ok(serde_json::json!({
                        "run_id": run_id,
                        "request_hash": row.get::<_, String>(0)?,
                        "request": parse(row.get(1)?),
                        "plan": parse(row.get(2)?),
                        "snapshot": parse(row.get(3)?),
                        "preview": row.get::<_, Option<String>>(4)?.map(parse),
                        "export": row.get::<_, Option<String>>(5)?.map(parse),
                        "created_at": row.get::<_, String>(6)?,
                        "updated_at": row.get::<_, String>(7)?,
                    }))
                },
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn save_work_preview(
        &self,
        run_id: &str,
        idempotency_key: &str,
        binding: &str,
        preview: &Value,
        occurred_at: &str,
    ) -> Result<Value, StorageError> {
        let document = serde_json::to_string(preview)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "UPDATE work_sessions SET preview_idempotency_key=?1, preview_binding=?2,
                    preview_json=?3, updated_at=?4
             WHERE run_id=?5 AND (preview_idempotency_key IS NULL OR
                    (preview_idempotency_key=?1 AND preview_binding=?2))",
            params![idempotency_key, binding, document, occurred_at, run_id],
        )? != 1
        {
            return Err(StorageError::Conflict(
                "work preview idempotency binding changed",
            ));
        }
        Ok(preview.clone())
    }

    pub fn save_work_export(
        &self,
        run_id: &str,
        idempotency_key: &str,
        binding: &str,
        export: &Value,
        occurred_at: &str,
    ) -> Result<Value, StorageError> {
        let document = serde_json::to_string(export)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        if connection.execute(
            "UPDATE work_sessions SET export_idempotency_key=?1, export_binding=?2,
                    export_json=?3, updated_at=?4
             WHERE run_id=?5 AND (export_idempotency_key IS NULL OR
                    (export_idempotency_key=?1 AND export_binding=?2))",
            params![idempotency_key, binding, document, occurred_at, run_id],
        )? != 1
        {
            return Err(StorageError::Conflict(
                "work export idempotency binding changed",
            ));
        }
        Ok(export.clone())
    }

    pub fn save_work_verification(
        &self,
        record: NewWorkVerification<'_>,
        report: &Value,
    ) -> Result<Value, StorageError> {
        let document = serde_json::to_string(report)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO work_verifications (verification_id, run_id, idempotency_key, binding,
                manifest_hash, report_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.verification_id,
                record.run_id,
                record.idempotency_key,
                record.binding,
                record.manifest_hash,
                document,
                record.created_at
            ],
        )?;
        Ok(report.clone())
    }

    pub fn artifact_directory(&self) -> Result<std::path::PathBuf, StorageError> {
        let parent = self
            .path
            .parent()
            .ok_or(StorageError::Invalid("state database has no parent"))?;
        Ok(parent.join("artifacts"))
    }
}

fn conversation_turn_by_id(
    connection: &rusqlite::Connection,
    turn_id: &str,
) -> Result<Option<Value>, StorageError> {
    connection
        .query_row(
            "SELECT turn_id, run_id, sequence, mode, user_message_id, user_content,
                    assistant_message_id, assistant_content, data_class, prompt_id, prompt_version,
                    prompt_hash, dropped_messages, estimated_context_tokens, total_tokens,
                    created_at, completed_at, binding
             FROM conversation_turns WHERE turn_id=?1",
            [turn_id],
            conversation_turn_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn conversation_turn_by_key(
    connection: &rusqlite::Connection,
    idempotency_key: &str,
) -> Result<Option<Value>, StorageError> {
    connection
        .query_row(
            "SELECT turn_id, run_id, sequence, mode, user_message_id, user_content,
                    assistant_message_id, assistant_content, data_class, prompt_id, prompt_version,
                    prompt_hash, dropped_messages, estimated_context_tokens, total_tokens,
                    created_at, completed_at, binding
             FROM conversation_turns WHERE idempotency_key=?1",
            [idempotency_key],
            conversation_turn_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn conversation_turn_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let run_id = row.get::<_, String>(1)?;
    let sequence = row.get::<_, i64>(2)?;
    let data_class = row.get::<_, String>(8)?;
    let created_at = row.get::<_, String>(15)?;
    let assistant_id = row.get::<_, Option<String>>(6)?;
    let assistant_content = row.get::<_, Option<String>>(7)?;
    let completed_at = row.get::<_, Option<String>>(16)?;
    Ok(serde_json::json!({
        "turn_id": row.get::<_, String>(0)?,
        "run_id": run_id,
        "sequence": sequence,
        "mode": row.get::<_, String>(3)?,
        "user": {
            "message_id": row.get::<_, String>(4)?,
            "run_id": run_id,
            "turn_sequence": sequence,
            "role": "user",
            "content": row.get::<_, String>(5)?,
            "created_at": created_at,
            "data_class": data_class,
        },
        "assistant": match (assistant_id, assistant_content) {
            (Some(message_id), Some(content)) => Some(serde_json::json!({
                "message_id": message_id,
                "run_id": run_id,
                "turn_sequence": sequence,
                "role": "assistant",
                "content": content,
                "created_at": completed_at.unwrap_or_else(|| created_at.clone()),
                "data_class": data_class,
            })),
            _ => None,
        },
        "prompt_id": row.get::<_, String>(9)?,
        "prompt_version": row.get::<_, String>(10)?,
        "prompt_hash": row.get::<_, String>(11)?,
        "dropped_messages": row.get::<_, i64>(12)?,
        "estimated_context_tokens": row.get::<_, i64>(13)?,
        "total_tokens": row.get::<_, Option<i64>>(14)?,
        "binding": row.get::<_, String>(17)?,
    }))
}

fn validate_memory(memory: &NewMemoryRecord<'_>) -> Result<(), StorageError> {
    if memory.memory_id.is_empty()
        || memory.memory_id.len() > 256
        || memory.kind.is_empty()
        || memory.kind.len() > 128
        || memory.summary.is_empty()
        || memory.summary.len() > 32_000
        || !matches!(memory.provenance, "user" | "run" | "source" | "system")
        || !valid_data_class(memory.data_class)
        || !matches!(
            memory.retention_class,
            "transient" | "cache" | "session" | "durable" | "protected"
        )
        || !valid_hash(memory.content_hash)
        || matches!(memory.retention_class, "transient" | "cache") != memory.expires_at.is_some()
    {
        return Err(StorageError::Invalid("invalid memory record"));
    }
    Ok(())
}

fn valid_data_class(value: &str) -> bool {
    matches!(value, "public" | "personal" | "confidential")
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn memory_by_id(
    connection: &rusqlite::Connection,
    memory_id: &str,
) -> Result<Option<MemoryRecord>, StorageError> {
    connection
        .query_row(
            "SELECT memory_id, layer, kind, summary, provenance, data_class, retention_class,
                    created_at, updated_at, expires_at, last_accessed_at, run_id, source_id,
                    content_hash, version FROM memory_records WHERE memory_id = ?1",
            [memory_id],
            memory_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn memory_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryRecord> {
    Ok(MemoryRecord {
        memory_id: row.get(0)?,
        layer: row.get(1)?,
        kind: row.get(2)?,
        summary: row.get(3)?,
        provenance: row.get(4)?,
        data_class: row.get(5)?,
        retention_class: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        expires_at: row.get(9)?,
        last_accessed_at: row.get(10)?,
        run_id: row.get(11)?,
        source_id: row.get(12)?,
        content_hash: row.get(13)?,
        version: row.get(14)?,
    })
}

fn radar_by_id(
    connection: &rusqlite::Connection,
    item_id: &str,
) -> Result<Option<RadarRecord>, StorageError> {
    connection
        .query_row(
            "SELECT item_id, lane, title, source, url, summary, score, stars_total,
                    stars_daily, stars_weekly, published_at, state, data_class, created_at,
                    updated_at FROM radar_items WHERE item_id = ?1",
            [item_id],
            radar_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn radar_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RadarRecord> {
    Ok(RadarRecord {
        item_id: row.get(0)?,
        lane: row.get(1)?,
        title: row.get(2)?,
        source: row.get(3)?,
        url: row.get(4)?,
        summary: row.get(5)?,
        score: row.get(6)?,
        stars_total: row.get(7)?,
        stars_daily: row.get(8)?,
        stars_weekly: row.get(9)?,
        published_at: row.get(10)?,
        state: row.get(11)?,
        data_class: row.get(12)?,
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn radar_star_baseline(
    transaction: &rusqlite::Transaction<'_>,
    item_id: &str,
    observed_on: &str,
    stars_total: i64,
    offset: &str,
) -> Result<Option<i64>, StorageError> {
    let baseline = transaction
        .query_row(
            "SELECT stars_total FROM radar_star_snapshots
             WHERE item_id = ?1 AND observed_on = date(?2, ?3)",
            params![item_id, observed_on, offset],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(baseline.map(|baseline| stars_total.saturating_sub(baseline)))
}

fn validate_local_todo(todo: NewLocalTodo<'_>) -> Result<(), StorageError> {
    validate_identifier(todo.task_id)?;
    validate_text(todo.title, 2_000)?;
    if todo.details.len() > 16_000 || todo.details.contains('\0') {
        return Err(StorageError::Invalid("local Todo details are invalid"));
    }
    if todo
        .priority
        .is_some_and(|priority| !matches!(priority, "P0" | "P1" | "P2" | "P3"))
        || !matches!(todo.status, "open" | "completed")
        || !matches!(todo.origin, "user" | "model")
    {
        return Err(StorageError::Invalid("local Todo fields are invalid"));
    }
    if let Some(due_at) = todo.due_at {
        validate_timestamp(due_at)?;
    }
    validate_timestamp(todo.occurred_at)
}

fn local_todo_by_id(
    connection: &rusqlite::Connection,
    task_id: &str,
) -> Result<Option<LocalTodoRecord>, StorageError> {
    connection
        .query_row(
            "SELECT task_id, title, details, priority, due_at, status, origin, created_at, updated_at, deleted_at
             FROM local_todos WHERE task_id=?1 AND deleted_at IS NULL",
            [task_id],
            local_todo_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn local_todo_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalTodoRecord> {
    Ok(LocalTodoRecord {
        task_id: row.get(0)?,
        title: row.get(1)?,
        details: row.get(2)?,
        priority: row.get(3)?,
        due_at: row.get(4)?,
        status: row.get(5)?,
        origin: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        deleted_at: row.get(9)?,
    })
}

fn task_preview_by_id(
    connection: &rusqlite::Connection,
    approval_id: &str,
) -> Result<Option<TaskPreviewRecord>, StorageError> {
    connection
        .query_row(
            "SELECT approval_id, idempotency_key, binding, task_id, relative_path, operation,
                    request_json, before_line, after_line, expected_hash, postimage_hash,
                    action_digest, policy_version, nonce, created_at, expires_at
             FROM task_write_previews WHERE approval_id = ?1",
            [approval_id],
            |row| {
                let request: String = row.get(6)?;
                Ok(TaskPreviewRecord {
                    approval_id: row.get(0)?,
                    idempotency_key: row.get(1)?,
                    binding: row.get(2)?,
                    task_id: row.get(3)?,
                    relative_path: row.get(4)?,
                    operation: row.get(5)?,
                    request: serde_json::from_str(&request).unwrap_or(Value::Null),
                    before_line: row.get(7)?,
                    after_line: row.get(8)?,
                    expected_hash: row.get(9)?,
                    postimage_hash: row.get(10)?,
                    action_digest: row.get(11)?,
                    policy_version: row.get(12)?,
                    nonce: row.get(13)?,
                    created_at: row.get(14)?,
                    expires_at: row.get(15)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn approval_by_id(
    connection: &rusqlite::Connection,
    approval_id: &str,
) -> Result<Option<ApprovalRecord>, StorageError> {
    connection
        .query_row(
            "SELECT approval_id, run_id, expires_at, decision, request_json
             FROM approvals WHERE approval_id = ?1",
            [approval_id],
            approval_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn approval_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApprovalRecord> {
    let document: String = row.get(4)?;
    let mut request =
        serde_json::from_str::<BTreeMap<String, Value>>(&document).unwrap_or_default();
    for reserved in ["approval_id", "run_id", "expires_at", "decision"] {
        request.remove(reserved);
    }
    Ok(ApprovalRecord {
        approval_id: row.get(0)?,
        run_id: row.get(1)?,
        expires_at: row.get(2)?,
        decision: row.get(3)?,
        request,
    })
}
