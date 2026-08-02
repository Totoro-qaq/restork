use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CheckpointRecord {
    pub checkpoint_id: String,
    pub run_id: Option<String>,
    pub manifest: Value,
    pub manifest_hash: String,
    pub total_bytes: i64,
    pub created_at: String,
    pub expires_at: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointFileBlob {
    pub relative_path: String,
    pub content_hash: String,
    pub content: Vec<u8>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct EvaluationRecord {
    pub evaluation_id: String,
    pub manifest: Value,
    pub manifest_hash: String,
    pub result: Value,
    pub contains_private_trajectories: bool,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SubtaskRecord {
    pub subtask_id: String,
    pub parent_run_id: String,
    pub spec: Value,
    pub spec_hash: String,
    pub state: String,
    pub result: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl Database {
    #[allow(clippy::too_many_arguments)]
    pub fn save_checkpoint(
        &self,
        checkpoint_id: &str,
        run_id: Option<&str>,
        manifest: &Value,
        manifest_hash: &str,
        total_bytes: i64,
        created_at: &str,
        expires_at: Option<&str>,
    ) -> Result<CheckpointRecord, StorageError> {
        validate_identifier(checkpoint_id)?;
        if let Some(run_id) = run_id {
            validate_identifier(run_id)?;
        }
        validate_object(manifest, "checkpoint manifest must be a JSON object")?;
        validate_text(manifest_hash, 64)?;
        if total_bytes < 0 {
            return Err(StorageError::Invalid("checkpoint size is invalid"));
        }
        validate_timestamp(created_at)?;
        if let Some(expires_at) = expires_at {
            validate_timestamp(expires_at)?;
        }
        let document = serde_json::to_string(manifest)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO recovery_checkpoints \
             (checkpoint_id, run_id, manifest_json, manifest_hash, total_bytes, created_at, expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                checkpoint_id,
                run_id,
                document,
                manifest_hash,
                total_bytes,
                created_at,
                expires_at
            ],
        )?;
        Ok(CheckpointRecord {
            checkpoint_id: checkpoint_id.to_owned(),
            run_id: run_id.map(str::to_owned),
            manifest: manifest.clone(),
            manifest_hash: manifest_hash.to_owned(),
            total_bytes,
            created_at: created_at.to_owned(),
            expires_at: expires_at.map(str::to_owned),
        })
    }

    pub fn checkpoint(
        &self,
        checkpoint_id: &str,
    ) -> Result<Option<CheckpointRecord>, StorageError> {
        validate_identifier(checkpoint_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT checkpoint_id, run_id, manifest_json, manifest_hash, total_bytes, \
                 created_at, expires_at FROM recovery_checkpoints WHERE checkpoint_id = ?1",
                [checkpoint_id],
                |row| {
                    let document: String = row.get(2)?;
                    Ok(CheckpointRecord {
                        checkpoint_id: row.get(0)?,
                        run_id: row.get(1)?,
                        manifest: json_from_sql(&document)?,
                        manifest_hash: row.get(3)?,
                        total_bytes: row.get(4)?,
                        created_at: row.get(5)?,
                        expires_at: row.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(StorageError::from)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_checkpoint_with_files(
        &self,
        checkpoint_id: &str,
        run_id: Option<&str>,
        manifest: &Value,
        manifest_hash: &str,
        files: &[CheckpointFileBlob],
        created_at: &str,
        expires_at: Option<&str>,
    ) -> Result<CheckpointRecord, StorageError> {
        validate_identifier(checkpoint_id)?;
        if let Some(run_id) = run_id {
            validate_identifier(run_id)?;
        }
        validate_object(manifest, "checkpoint manifest must be a JSON object")?;
        validate_text(manifest_hash, 64)?;
        if files.is_empty() || files.len() > 1_000 {
            return Err(StorageError::Invalid("checkpoint files are invalid"));
        }
        validate_timestamp(created_at)?;
        if let Some(expires_at) = expires_at {
            validate_timestamp(expires_at)?;
        }
        let mut total_bytes = 0_i64;
        for file in files {
            validate_checkpoint_path(&file.relative_path)?;
            validate_digest(&file.content_hash)?;
            if digest(&file.content) != file.content_hash {
                return Err(StorageError::Invalid("checkpoint file hash does not match"));
            }
            total_bytes = total_bytes
                .checked_add(
                    i64::try_from(file.content.len())
                        .map_err(|_| StorageError::Invalid("checkpoint size is invalid"))?,
                )
                .ok_or(StorageError::Invalid("checkpoint size is invalid"))?;
        }
        let document = serde_json::to_string(manifest)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT INTO recovery_checkpoints \
             (checkpoint_id, run_id, manifest_json, manifest_hash, total_bytes, created_at, expires_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                checkpoint_id,
                run_id,
                document,
                manifest_hash,
                total_bytes,
                created_at,
                expires_at
            ],
        )?;
        for file in files {
            transaction.execute(
                "INSERT INTO checkpoint_file_blobs \
                 (checkpoint_id, relative_path, content_hash, byte_count, content) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    checkpoint_id,
                    file.relative_path,
                    file.content_hash,
                    i64::try_from(file.content.len())
                        .map_err(|_| StorageError::Invalid("checkpoint size is invalid"))?,
                    file.content,
                ],
            )?;
        }
        transaction.commit()?;
        Ok(CheckpointRecord {
            checkpoint_id: checkpoint_id.to_owned(),
            run_id: run_id.map(str::to_owned),
            manifest: manifest.clone(),
            manifest_hash: manifest_hash.to_owned(),
            total_bytes,
            created_at: created_at.to_owned(),
            expires_at: expires_at.map(str::to_owned),
        })
    }

    pub fn checkpoint_file_blobs(
        &self,
        checkpoint_id: &str,
        paths: Option<&[String]>,
    ) -> Result<Vec<CheckpointFileBlob>, StorageError> {
        validate_identifier(checkpoint_id)?;
        if let Some(paths) = paths {
            if paths.is_empty() || paths.len() > 1_000 {
                return Err(StorageError::Invalid("checkpoint selection is invalid"));
            }
            for path in paths {
                validate_checkpoint_path(path)?;
            }
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT relative_path, content_hash, content FROM checkpoint_file_blobs \
             WHERE checkpoint_id = ?1 ORDER BY relative_path",
        )?;
        let rows = statement.query_map([checkpoint_id], |row| {
            Ok(CheckpointFileBlob {
                relative_path: row.get(0)?,
                content_hash: row.get(1)?,
                content: row.get(2)?,
            })
        })?;
        let mut files = rows.collect::<Result<Vec<_>, _>>()?;
        if let Some(paths) = paths {
            files.retain(|file| paths.contains(&file.relative_path));
            if files.len() != paths.len() {
                return Err(StorageError::Invalid("checkpoint selection is invalid"));
            }
        }
        if files.is_empty() {
            return Err(StorageError::Invalid(
                "checkpoint has no recoverable file content",
            ));
        }
        for file in &files {
            if digest(&file.content) != file.content_hash {
                return Err(StorageError::Invalid("checkpoint file integrity failed"));
            }
        }
        Ok(files)
    }

    pub fn save_evaluation(
        &self,
        evaluation_id: &str,
        manifest: &Value,
        manifest_hash: &str,
        result: &Value,
        contains_private_trajectories: bool,
        created_at: &str,
    ) -> Result<EvaluationRecord, StorageError> {
        validate_identifier(evaluation_id)?;
        validate_object(manifest, "evaluation manifest must be a JSON object")?;
        validate_text(manifest_hash, 64)?;
        validate_object(result, "evaluation result must be a JSON object")?;
        validate_timestamp(created_at)?;
        let manifest_json = serde_json::to_string(manifest)?;
        let result_json = serde_json::to_string(result)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO evaluation_batches \
             (evaluation_id, manifest_json, manifest_hash, result_json, \
              contains_private_trajectories, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                evaluation_id,
                manifest_json,
                manifest_hash,
                result_json,
                i64::from(contains_private_trajectories),
                created_at
            ],
        )?;
        Ok(EvaluationRecord {
            evaluation_id: evaluation_id.to_owned(),
            manifest: manifest.clone(),
            manifest_hash: manifest_hash.to_owned(),
            result: result.clone(),
            contains_private_trajectories,
            created_at: created_at.to_owned(),
        })
    }

    pub fn save_subtask(
        &self,
        subtask_id: &str,
        parent_run_id: &str,
        spec: &Value,
        spec_hash: &str,
        created_at: &str,
    ) -> Result<SubtaskRecord, StorageError> {
        validate_identifier(subtask_id)?;
        validate_identifier(parent_run_id)?;
        validate_object(spec, "subtask specification must be a JSON object")?;
        validate_text(spec_hash, 64)?;
        validate_timestamp(created_at)?;
        let document = serde_json::to_string(spec)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO subtasks \
             (subtask_id, parent_run_id, spec_json, spec_hash, state, result_json, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'pending', NULL, ?5, ?5)",
            params![subtask_id, parent_run_id, document, spec_hash, created_at],
        )?;
        Ok(SubtaskRecord {
            subtask_id: subtask_id.to_owned(),
            parent_run_id: parent_run_id.to_owned(),
            spec: spec.clone(),
            spec_hash: spec_hash.to_owned(),
            state: "pending".to_owned(),
            result: None,
            created_at: created_at.to_owned(),
            updated_at: created_at.to_owned(),
        })
    }

    pub fn subtask(&self, subtask_id: &str) -> Result<Option<SubtaskRecord>, StorageError> {
        validate_identifier(subtask_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT subtask_id, parent_run_id, spec_json, spec_hash, state, result_json, \
                 created_at, updated_at FROM subtasks WHERE subtask_id = ?1",
                [subtask_id],
                subtask_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn claim_subtask(
        &self,
        subtask_id: &str,
        updated_at: &str,
    ) -> Result<SubtaskRecord, StorageError> {
        validate_identifier(subtask_id)?;
        validate_timestamp(updated_at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let parent_run_id: Option<String> = transaction
            .query_row(
                "SELECT parent_run_id FROM subtasks WHERE subtask_id = ?1 AND state = 'pending'",
                [subtask_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(parent_run_id) = parent_run_id else {
            return Err(StorageError::Conflict("subtask is not pending"));
        };
        let running: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM subtasks WHERE parent_run_id = ?1 AND state = 'running'",
            [&parent_run_id],
            |row| row.get(0),
        )?;
        if running >= 2 {
            return Err(StorageError::Conflict(
                "subtask parent concurrency limit is reached",
            ));
        }
        let changed = transaction.execute(
            "UPDATE subtasks SET state = 'running', updated_at = ?2 \
             WHERE subtask_id = ?1 AND state = 'pending'",
            params![subtask_id, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("subtask is not pending"));
        }
        transaction.commit()?;
        drop(connection);
        self.subtask(subtask_id)?
            .ok_or(StorageError::Invalid("subtask does not exist"))
    }

    pub fn complete_subtask(
        &self,
        subtask_id: &str,
        state: &str,
        result: &Value,
        updated_at: &str,
    ) -> Result<SubtaskRecord, StorageError> {
        validate_identifier(subtask_id)?;
        if !matches!(
            state,
            "succeeded" | "failed" | "cancelled" | "timed_out" | "rejected"
        ) {
            return Err(StorageError::Invalid("subtask state is invalid"));
        }
        validate_object(result, "subtask result must be a JSON object")?;
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(result)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE subtasks SET state = ?2, result_json = ?3, updated_at = ?4 \
             WHERE subtask_id = ?1 AND state = 'running'",
            params![subtask_id, state, document, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("subtask is not running"));
        }
        drop(connection);
        self.subtask(subtask_id)?
            .ok_or(StorageError::Invalid("subtask does not exist"))
    }

    pub fn cancel_subtask(
        &self,
        subtask_id: &str,
        updated_at: &str,
    ) -> Result<SubtaskRecord, StorageError> {
        validate_identifier(subtask_id)?;
        validate_timestamp(updated_at)?;
        let result = serde_json::json!({
            "error_code": "cancelled_by_user",
            "effects_applied": false,
            "memory_written": false,
            "delegated": false
        });
        let document = serde_json::to_string(&result)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE subtasks SET state = 'cancelled', result_json = ?2, updated_at = ?3 \
             WHERE subtask_id = ?1 AND state IN ('pending', 'running')",
            params![subtask_id, document, updated_at],
        )?;
        drop(connection);
        let record = self
            .subtask(subtask_id)?
            .ok_or(StorageError::Invalid("subtask does not exist"))?;
        if changed == 0
            && !matches!(
                record.state.as_str(),
                "succeeded" | "failed" | "cancelled" | "timed_out" | "rejected"
            )
        {
            return Err(StorageError::Conflict("subtask cannot be cancelled"));
        }
        Ok(record)
    }
}

fn subtask_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SubtaskRecord> {
    let spec: String = row.get(2)?;
    let result: Option<String> = row.get(5)?;
    Ok(SubtaskRecord {
        subtask_id: row.get(0)?,
        parent_run_id: row.get(1)?,
        spec: json_from_sql(&spec)?,
        spec_hash: row.get(3)?,
        state: row.get(4)?,
        result: result.map(|value| json_from_sql(&value)).transpose()?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn validate_checkpoint_path(path: &str) -> Result<(), StorageError> {
    if path.is_empty()
        || path.len() > 4_096
        || path.starts_with(['/', '\\'])
        || path.contains(['\\', '\0', '\n', '\r'])
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        Err(StorageError::Invalid("checkpoint path is invalid"))
    } else {
        Ok(())
    }
}

fn validate_digest(value: &str) -> Result<(), StorageError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(StorageError::Invalid("checkpoint digest is invalid"))
    }
}

fn digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
