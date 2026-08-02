use rusqlite::{OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Database, StorageError, StoredSessionMessage, validate_identifier, validate_object,
    validate_text, validate_timestamp,
};

const TERMINAL_STATES: [&str; 3] = ["completed", "cancelled", "failed"];

#[derive(Clone, Copy)]
pub struct NewConversationOperation<'a> {
    pub operation_id: &'a str,
    pub session_id: &'a str,
    pub idempotency_key: &'a str,
    pub user_message_id: &'a str,
    pub content: &'a str,
    pub context: &'a Value,
    pub data_class: &'a str,
    pub context_preview_hash: Option<&'a str>,
    pub provider_binding: &'a Value,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ConversationOperationRecord {
    pub operation_id: String,
    pub session_id: String,
    pub user_message_id: String,
    pub assistant_message_id: Option<String>,
    pub state: String,
    pub phase: String,
    pub context_preview_hash: Option<String>,
    pub provider_binding: Value,
    pub cancel_requested: bool,
    pub error_code: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct OperationEventRecord {
    pub operation_id: String,
    pub sequence: i64,
    pub occurred_at: String,
    pub kind: String,
    pub data: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct OperationCreateResult {
    pub operation: ConversationOperationRecord,
    pub user_message: StoredSessionMessage,
    pub replayed: bool,
}

#[derive(Clone, Copy)]
pub struct NewContextPreview<'a> {
    pub preview_id: &'a str,
    pub session_id: &'a str,
    pub content_hash: &'a str,
    pub manifest: &'a Value,
    pub data_class: &'a str,
    pub byte_count: i64,
    pub estimated_tokens: i64,
    pub created_at: &'a str,
    pub expires_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ContextPreviewRecord {
    pub preview_id: String,
    pub session_id: String,
    pub content_hash: String,
    pub manifest: Value,
    pub data_class: String,
    pub byte_count: i64,
    pub estimated_tokens: i64,
    pub created_at: String,
    pub expires_at: String,
    pub used_operation_id: Option<String>,
}

impl Database {
    pub fn create_conversation_operation(
        &self,
        input: NewConversationOperation<'_>,
    ) -> Result<OperationCreateResult, StorageError> {
        validate_identifier(input.operation_id)?;
        validate_identifier(input.session_id)?;
        validate_identifier(input.user_message_id)?;
        validate_idempotency(input.idempotency_key)?;
        validate_text(input.content, 64_000)?;
        validate_object(input.context, "message context must be a JSON object")?;
        validate_text(input.data_class, 32)?;
        if let Some(hash) = input.context_preview_hash {
            validate_hash(hash)?;
        }
        validate_object(
            input.provider_binding,
            "provider binding must be a JSON object",
        )?;
        validate_timestamp(input.occurred_at)?;

        let context_json = serde_json::to_string(input.context)?;
        let provider_json = serde_json::to_string(input.provider_binding)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if let Some(operation) = operation_by_idempotency(&transaction, input.idempotency_key)? {
            let user_message = message_by_id(&transaction, &operation.user_message_id)?.ok_or(
                StorageError::Invalid("operation user message is unavailable"),
            )?;
            return Ok(OperationCreateResult {
                operation,
                user_message,
                replayed: true,
            });
        }
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM sessions WHERE session_id = ?1",
                [input.session_id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            Some("active") => {}
            Some(_) => return Err(StorageError::Conflict("session is archived")),
            None => return Err(StorageError::Invalid("session does not exist")),
        }
        if let Some(hash) = input.context_preview_hash {
            let preview: Option<(String, String, Option<String>)> = transaction
                .query_row(
                    "SELECT session_id, expires_at, used_operation_id FROM context_previews \
                     WHERE content_hash = ?1",
                    [hash],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((preview_session, expires_at, used_by)) = preview else {
                return Err(StorageError::Conflict("context preview is missing"));
            };
            if preview_session != input.session_id
                || expires_at.as_str() <= input.occurred_at
                || used_by.is_some()
            {
                return Err(StorageError::Conflict(
                    "context preview is stale or already used",
                ));
            }
        }
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_messages WHERE session_id = ?1",
            [input.session_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO session_messages \
             (message_id, session_id, sequence, role, content, context_json, data_class, created_at) \
             VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6, ?7)",
            params![
                input.user_message_id,
                input.session_id,
                sequence,
                input.content,
                context_json,
                input.data_class,
                input.occurred_at,
            ],
        )?;
        transaction.execute(
            "INSERT INTO conversation_operations \
             (operation_id, session_id, idempotency_key, user_message_id, state, phase, \
              context_preview_hash, provider_binding_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'queued', 'queued', ?5, ?6, ?7, ?7)",
            params![
                input.operation_id,
                input.session_id,
                input.idempotency_key,
                input.user_message_id,
                input.context_preview_hash,
                provider_json,
                input.occurred_at,
            ],
        )?;
        if let Some(hash) = input.context_preview_hash {
            transaction.execute(
                "UPDATE context_previews SET used_operation_id = ?2 WHERE content_hash = ?1",
                params![hash, input.operation_id],
            )?;
        }
        insert_event(
            &transaction,
            input.operation_id,
            input.occurred_at,
            "conversation.queued",
            &serde_json::json!({"phase": "queued"}),
        )?;
        transaction.execute(
            "UPDATE sessions SET updated_at = MAX(updated_at, ?2) WHERE session_id = ?1",
            params![input.session_id, input.occurred_at],
        )?;
        transaction.commit()?;
        Ok(OperationCreateResult {
            operation: ConversationOperationRecord {
                operation_id: input.operation_id.to_owned(),
                session_id: input.session_id.to_owned(),
                user_message_id: input.user_message_id.to_owned(),
                assistant_message_id: None,
                state: "queued".to_owned(),
                phase: "queued".to_owned(),
                context_preview_hash: input.context_preview_hash.map(str::to_owned),
                provider_binding: input.provider_binding.clone(),
                cancel_requested: false,
                error_code: None,
                created_at: input.occurred_at.to_owned(),
                updated_at: input.occurred_at.to_owned(),
                completed_at: None,
            },
            user_message: StoredSessionMessage {
                message_id: input.user_message_id.to_owned(),
                session_id: input.session_id.to_owned(),
                sequence,
                role: "user".to_owned(),
                content: input.content.to_owned(),
                context: input.context.clone(),
                data_class: input.data_class.to_owned(),
                created_at: input.occurred_at.to_owned(),
            },
            replayed: false,
        })
    }

    pub fn conversation_operation(
        &self,
        operation_id: &str,
    ) -> Result<Option<ConversationOperationRecord>, StorageError> {
        validate_identifier(operation_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        operation_by_id(&connection, operation_id)
    }

    pub fn operation_events_after(
        &self,
        operation_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<Vec<OperationEventRecord>, StorageError> {
        validate_identifier(operation_id)?;
        if after < 0 || !(1..=1_000).contains(&limit) {
            return Err(StorageError::Invalid("operation event page is invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT operation_id, sequence, occurred_at, kind, data_json FROM operation_events \
             WHERE operation_id = ?1 AND sequence > ?2 ORDER BY sequence ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                operation_id,
                after,
                i64::try_from(limit).expect("bounded limit")
            ],
            event_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn start_conversation_operation(
        &self,
        operation_id: &str,
        occurred_at: &str,
    ) -> Result<ConversationOperationRecord, StorageError> {
        transition_operation(
            self,
            operation_id,
            &["queued", "preparing"],
            "streaming",
            "model",
            "conversation.model_started",
            &serde_json::json!({"phase": "model"}),
            None,
            occurred_at,
        )
    }

    pub fn request_operation_cancel(
        &self,
        operation_id: &str,
        occurred_at: &str,
    ) -> Result<ConversationOperationRecord, StorageError> {
        validate_identifier(operation_id)?;
        validate_timestamp(occurred_at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = operation_by_id(&transaction, operation_id)?
            .ok_or(StorageError::Invalid("operation does not exist"))?;
        if TERMINAL_STATES.contains(&current.state.as_str()) || current.cancel_requested {
            return Ok(current);
        }
        transaction.execute(
            "UPDATE conversation_operations SET state = 'cancel_requested', phase = 'cancelling', \
             cancel_requested = 1, updated_at = ?2 WHERE operation_id = ?1",
            params![operation_id, occurred_at],
        )?;
        insert_event(
            &transaction,
            operation_id,
            occurred_at,
            "conversation.cancel_requested",
            &serde_json::json!({"phase": "cancelling"}),
        )?;
        transaction.commit()?;
        drop(connection);
        self.conversation_operation(operation_id)?
            .ok_or(StorageError::Invalid("operation does not exist"))
    }

    pub fn finish_operation_cancelled(
        &self,
        operation_id: &str,
        occurred_at: &str,
    ) -> Result<ConversationOperationRecord, StorageError> {
        transition_operation(
            self,
            operation_id,
            &[
                "queued",
                "preparing",
                "streaming",
                "validating",
                "cancel_requested",
            ],
            "cancelled",
            "cancelled",
            "conversation.cancelled",
            &serde_json::json!({"phase": "cancelled"}),
            Some("cancelled"),
            occurred_at,
        )
    }

    pub fn fail_conversation_operation(
        &self,
        operation_id: &str,
        error_code: &str,
        occurred_at: &str,
    ) -> Result<ConversationOperationRecord, StorageError> {
        validate_text(error_code, 128)?;
        let current = self
            .conversation_operation(operation_id)?
            .ok_or(StorageError::Invalid("operation does not exist"))?;
        if current.cancel_requested || current.state == "cancel_requested" {
            return self.finish_operation_cancelled(operation_id, occurred_at);
        }
        transition_operation(
            self,
            operation_id,
            &["queued", "preparing", "streaming", "validating"],
            "failed",
            "failed",
            "conversation.failed",
            &serde_json::json!({"phase": "failed", "error_code": error_code}),
            Some(error_code),
            occurred_at,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn complete_conversation_operation(
        &self,
        operation_id: &str,
        assistant_message_id: &str,
        content: &str,
        context: &Value,
        data_class: &str,
        occurred_at: &str,
    ) -> Result<(ConversationOperationRecord, StoredSessionMessage), StorageError> {
        validate_identifier(operation_id)?;
        validate_identifier(assistant_message_id)?;
        validate_text(content, 1_000_000)?;
        validate_object(context, "message context must be a JSON object")?;
        validate_text(data_class, 32)?;
        validate_timestamp(occurred_at)?;
        let context_json = serde_json::to_string(context)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = operation_by_id(&transaction, operation_id)?
            .ok_or(StorageError::Invalid("operation does not exist"))?;
        if current.cancel_requested || current.state == "cancel_requested" {
            return Err(StorageError::Conflict(
                "operation cancellation won the completion race",
            ));
        }
        if !matches!(current.state.as_str(), "streaming" | "validating") {
            return Err(StorageError::Conflict("operation is not completable"));
        }
        transaction.execute(
            "UPDATE conversation_operations SET state = 'validating', phase = 'validating', \
             updated_at = ?2 WHERE operation_id = ?1",
            params![operation_id, occurred_at],
        )?;
        insert_event(
            &transaction,
            operation_id,
            occurred_at,
            "conversation.validating",
            &serde_json::json!({"phase": "validating"}),
        )?;
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_messages WHERE session_id = ?1",
            [&current.session_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO session_messages \
             (message_id, session_id, sequence, role, content, context_json, data_class, created_at) \
             VALUES (?1, ?2, ?3, 'assistant', ?4, ?5, ?6, ?7)",
            params![
                assistant_message_id,
                current.session_id,
                sequence,
                content,
                context_json,
                data_class,
                occurred_at,
            ],
        )?;
        insert_event(
            &transaction,
            operation_id,
            occurred_at,
            "conversation.delta",
            &serde_json::json!({"content": content}),
        )?;
        transaction.execute(
            "UPDATE conversation_operations SET state = 'completed', phase = 'completed', \
             assistant_message_id = ?2, updated_at = ?3, completed_at = ?3 \
             WHERE operation_id = ?1",
            params![operation_id, assistant_message_id, occurred_at],
        )?;
        insert_event(
            &transaction,
            operation_id,
            occurred_at,
            "conversation.completed",
            &serde_json::json!({"phase": "completed", "message_id": assistant_message_id}),
        )?;
        transaction.execute(
            "UPDATE sessions SET updated_at = MAX(updated_at, ?2) WHERE session_id = ?1",
            params![current.session_id, occurred_at],
        )?;
        transaction.commit()?;
        drop(connection);
        let operation = self
            .conversation_operation(operation_id)?
            .ok_or(StorageError::Invalid("operation does not exist"))?;
        Ok((
            operation,
            StoredSessionMessage {
                message_id: assistant_message_id.to_owned(),
                session_id: current.session_id,
                sequence,
                role: "assistant".to_owned(),
                content: content.to_owned(),
                context: context.clone(),
                data_class: data_class.to_owned(),
                created_at: occurred_at.to_owned(),
            },
        ))
    }

    pub fn save_context_preview(
        &self,
        input: NewContextPreview<'_>,
    ) -> Result<ContextPreviewRecord, StorageError> {
        validate_identifier(input.preview_id)?;
        validate_identifier(input.session_id)?;
        validate_hash(input.content_hash)?;
        validate_object(input.manifest, "context manifest must be a JSON object")?;
        validate_text(input.data_class, 32)?;
        if input.byte_count < 0 || input.estimated_tokens < 0 {
            return Err(StorageError::Invalid("context preview size is invalid"));
        }
        validate_timestamp(input.created_at)?;
        validate_timestamp(input.expires_at)?;
        if input.expires_at <= input.created_at {
            return Err(StorageError::Invalid("context preview expiry is invalid"));
        }
        let document = serde_json::to_string(input.manifest)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO context_previews \
             (preview_id, session_id, content_hash, manifest_json, data_class, byte_count, \
              estimated_tokens, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                input.preview_id,
                input.session_id,
                input.content_hash,
                document,
                input.data_class,
                input.byte_count,
                input.estimated_tokens,
                input.created_at,
                input.expires_at,
            ],
        )?;
        Ok(ContextPreviewRecord {
            preview_id: input.preview_id.to_owned(),
            session_id: input.session_id.to_owned(),
            content_hash: input.content_hash.to_owned(),
            manifest: input.manifest.clone(),
            data_class: input.data_class.to_owned(),
            byte_count: input.byte_count,
            estimated_tokens: input.estimated_tokens,
            created_at: input.created_at.to_owned(),
            expires_at: input.expires_at.to_owned(),
            used_operation_id: None,
        })
    }

    pub fn context_preview_by_hash(
        &self,
        content_hash: &str,
    ) -> Result<Option<ContextPreviewRecord>, StorageError> {
        validate_hash(content_hash)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT preview_id, session_id, content_hash, manifest_json, data_class, byte_count, \
                 estimated_tokens, created_at, expires_at, used_operation_id FROM context_previews \
                 WHERE content_hash = ?1",
                [content_hash],
                context_preview_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn fail_abandoned_operations(&self, occurred_at: &str) -> Result<usize, StorageError> {
        validate_timestamp(occurred_at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let ids = {
            let mut statement = transaction.prepare(
                "SELECT operation_id FROM conversation_operations WHERE state NOT IN \
                 ('completed', 'cancelled', 'failed') ORDER BY operation_id",
            )?;
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?
        };
        for operation_id in &ids {
            transaction.execute(
                "UPDATE conversation_operations SET state = 'failed', phase = 'failed', \
                 error_code = 'runtime_restarted', updated_at = ?2, completed_at = ?2 \
                 WHERE operation_id = ?1",
                params![operation_id, occurred_at],
            )?;
            insert_event(
                &transaction,
                operation_id,
                occurred_at,
                "conversation.failed",
                &serde_json::json!({"phase": "failed", "error_code": "runtime_restarted"}),
            )?;
        }
        transaction.commit()?;
        Ok(ids.len())
    }
}

#[allow(clippy::too_many_arguments)]
fn transition_operation(
    database: &Database,
    operation_id: &str,
    allowed_states: &[&str],
    next_state: &str,
    phase: &str,
    kind: &str,
    data: &Value,
    error_code: Option<&str>,
    occurred_at: &str,
) -> Result<ConversationOperationRecord, StorageError> {
    validate_identifier(operation_id)?;
    validate_timestamp(occurred_at)?;
    validate_object(data, "operation event must be a JSON object")?;
    let mut connection = database
        .connection
        .lock()
        .map_err(|_| StorageError::Poisoned)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = operation_by_id(&transaction, operation_id)?
        .ok_or(StorageError::Invalid("operation does not exist"))?;
    if current.state == next_state || TERMINAL_STATES.contains(&current.state.as_str()) {
        return Ok(current);
    }
    if !allowed_states.contains(&current.state.as_str()) {
        return Err(StorageError::Conflict("operation transition is stale"));
    }
    transaction.execute(
        "UPDATE conversation_operations SET state = ?2, phase = ?3, error_code = ?4, \
         updated_at = ?5, completed_at = CASE WHEN ?2 IN ('completed', 'cancelled', 'failed') \
         THEN ?5 ELSE completed_at END WHERE operation_id = ?1",
        params![operation_id, next_state, phase, error_code, occurred_at],
    )?;
    insert_event(&transaction, operation_id, occurred_at, kind, data)?;
    transaction.commit()?;
    drop(connection);
    database
        .conversation_operation(operation_id)?
        .ok_or(StorageError::Invalid("operation does not exist"))
}

fn insert_event(
    transaction: &Transaction<'_>,
    operation_id: &str,
    occurred_at: &str,
    kind: &str,
    data: &Value,
) -> Result<i64, StorageError> {
    validate_text(kind, 128)?;
    validate_object(data, "operation event must be a JSON object")?;
    let sequence: i64 = transaction.query_row(
        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM operation_events WHERE operation_id = ?1",
        [operation_id],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO operation_events (operation_id, sequence, occurred_at, kind, data_json) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            operation_id,
            sequence,
            occurred_at,
            kind,
            serde_json::to_string(data)?
        ],
    )?;
    Ok(sequence)
}

fn operation_by_id(
    connection: &rusqlite::Connection,
    operation_id: &str,
) -> Result<Option<ConversationOperationRecord>, StorageError> {
    connection
        .query_row(
            "SELECT operation_id, session_id, user_message_id, assistant_message_id, state, phase, \
             context_preview_hash, provider_binding_json, cancel_requested, error_code, created_at, \
             updated_at, completed_at FROM conversation_operations WHERE operation_id = ?1",
            [operation_id],
            operation_from_row,
        )
        .optional()
        .map_err(StorageError::from)
}

fn operation_by_idempotency(
    transaction: &Transaction<'_>,
    idempotency_key: &str,
) -> Result<Option<ConversationOperationRecord>, StorageError> {
    transaction
        .query_row(
            "SELECT operation_id, session_id, user_message_id, assistant_message_id, state, phase, \
             context_preview_hash, provider_binding_json, cancel_requested, error_code, created_at, \
             updated_at, completed_at FROM conversation_operations WHERE idempotency_key = ?1",
            [idempotency_key],
            operation_from_row,
        )
        .optional()
        .map_err(StorageError::from)
}

fn operation_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConversationOperationRecord> {
    let document: String = row.get(7)?;
    Ok(ConversationOperationRecord {
        operation_id: row.get(0)?,
        session_id: row.get(1)?,
        user_message_id: row.get(2)?,
        assistant_message_id: row.get(3)?,
        state: row.get(4)?,
        phase: row.get(5)?,
        context_preview_hash: row.get(6)?,
        provider_binding: json_from_sql(&document)?,
        cancel_requested: row.get::<_, i64>(8)? == 1,
        error_code: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        completed_at: row.get(12)?,
    })
}

fn event_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<OperationEventRecord> {
    let document: String = row.get(4)?;
    Ok(OperationEventRecord {
        operation_id: row.get(0)?,
        sequence: row.get(1)?,
        occurred_at: row.get(2)?,
        kind: row.get(3)?,
        data: json_from_sql(&document)?,
    })
}

fn context_preview_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextPreviewRecord> {
    let document: String = row.get(3)?;
    Ok(ContextPreviewRecord {
        preview_id: row.get(0)?,
        session_id: row.get(1)?,
        content_hash: row.get(2)?,
        manifest: json_from_sql(&document)?,
        data_class: row.get(4)?,
        byte_count: row.get(5)?,
        estimated_tokens: row.get(6)?,
        created_at: row.get(7)?,
        expires_at: row.get(8)?,
        used_operation_id: row.get(9)?,
    })
}

fn message_by_id(
    transaction: &Transaction<'_>,
    message_id: &str,
) -> Result<Option<StoredSessionMessage>, StorageError> {
    transaction
        .query_row(
            "SELECT message_id, session_id, sequence, role, content, context_json, data_class, \
             created_at FROM session_messages WHERE message_id = ?1",
            [message_id],
            |row| {
                let document: String = row.get(5)?;
                Ok(StoredSessionMessage {
                    message_id: row.get(0)?,
                    session_id: row.get(1)?,
                    sequence: row.get(2)?,
                    role: row.get(3)?,
                    content: row.get(4)?,
                    context: json_from_sql(&document)?,
                    data_class: row.get(6)?,
                    created_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(StorageError::from)
}

fn json_from_sql(document: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(document).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            document.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn validate_hash(value: &str) -> Result<(), StorageError> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Invalid("content hash is invalid"));
    }
    Ok(())
}

fn validate_idempotency(value: &str) -> Result<(), StorageError> {
    validate_text(value, 200)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(StorageError::Invalid("idempotency key is invalid"));
    }
    Ok(())
}
