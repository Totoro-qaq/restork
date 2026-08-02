use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
