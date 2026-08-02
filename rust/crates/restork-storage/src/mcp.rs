use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct McpExecutionRecord {
    pub execution_id: String,
    pub session_id: String,
    pub idempotency_key: String,
    pub tool_id: String,
    pub package_id: String,
    pub package_hash: String,
    pub catalog_fingerprint: String,
    pub call_digest: String,
    pub resolved_call: Value,
    pub state: String,
    pub result: Option<Value>,
    pub error_code: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

pub struct NewMcpExecution<'a> {
    pub execution_id: &'a str,
    pub session_id: &'a str,
    pub idempotency_key: &'a str,
    pub tool_id: &'a str,
    pub package_id: &'a str,
    pub package_hash: &'a str,
    pub catalog_fingerprint: &'a str,
    pub call_digest: &'a str,
    pub resolved_call: &'a Value,
    pub started_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct McpExecutionCreateResult {
    pub execution: McpExecutionRecord,
    pub replayed: bool,
}

impl Database {
    pub fn create_mcp_execution(
        &self,
        new: &NewMcpExecution<'_>,
    ) -> Result<McpExecutionCreateResult, StorageError> {
        validate_identifier(new.execution_id)?;
        validate_identifier(new.session_id)?;
        validate_text(new.idempotency_key, 256)?;
        validate_identifier(new.tool_id)?;
        validate_identifier(new.package_id)?;
        validate_digest(new.package_hash)?;
        validate_digest(new.catalog_fingerprint)?;
        validate_digest(new.call_digest)?;
        validate_object(new.resolved_call, "resolved MCP call must be a JSON object")?;
        validate_timestamp(new.started_at)?;
        let document = serde_json::to_string(new.resolved_call)?;

        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT execution_id, session_id, idempotency_key, tool_id, package_id, \
                 package_hash, catalog_fingerprint, call_digest, resolved_call_json, state, \
                 result_json, error_code, started_at, completed_at FROM mcp_executions \
                 WHERE session_id = ?1 AND idempotency_key = ?2",
                params![new.session_id, new.idempotency_key],
                execution_from_row,
            )
            .optional()?;
        if let Some(current) = current {
            if current.call_digest != new.call_digest {
                return Err(StorageError::Conflict(
                    "idempotency key is bound to a different MCP call",
                ));
            }
            return Ok(McpExecutionCreateResult {
                execution: current,
                replayed: true,
            });
        }
        transaction.execute(
            "INSERT INTO mcp_executions \
             (execution_id, session_id, idempotency_key, tool_id, package_id, package_hash, \
              catalog_fingerprint, call_digest, resolved_call_json, state, started_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10)",
            params![
                new.execution_id,
                new.session_id,
                new.idempotency_key,
                new.tool_id,
                new.package_id,
                new.package_hash,
                new.catalog_fingerprint,
                new.call_digest,
                document,
                new.started_at,
            ],
        )?;
        transaction.commit()?;
        drop(connection);
        Ok(McpExecutionCreateResult {
            execution: self
                .mcp_execution(new.execution_id)?
                .ok_or(StorageError::Invalid("MCP execution was not persisted"))?,
            replayed: false,
        })
    }

    pub fn complete_mcp_execution(
        &self,
        execution_id: &str,
        state: &str,
        result: Option<&Value>,
        error_code: Option<&str>,
        completed_at: &str,
    ) -> Result<McpExecutionRecord, StorageError> {
        validate_identifier(execution_id)?;
        if !matches!(state, "succeeded" | "failed" | "cancelled") {
            return Err(StorageError::Invalid("MCP execution state is invalid"));
        }
        if let Some(value) = result {
            validate_object(value, "MCP result must be a JSON object")?;
        }
        if let Some(value) = error_code {
            validate_identifier(value)?;
        }
        validate_timestamp(completed_at)?;
        let result_json = result.map(serde_json::to_string).transpose()?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE mcp_executions SET state = ?2, result_json = ?3, error_code = ?4, \
             completed_at = ?5 WHERE execution_id = ?1 AND state = 'running'",
            params![execution_id, state, result_json, error_code, completed_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("MCP execution is already terminal"));
        }
        drop(connection);
        self.mcp_execution(execution_id)?
            .ok_or(StorageError::Invalid("MCP execution does not exist"))
    }

    pub fn mcp_execution(
        &self,
        execution_id: &str,
    ) -> Result<Option<McpExecutionRecord>, StorageError> {
        validate_identifier(execution_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT execution_id, session_id, idempotency_key, tool_id, package_id, \
                 package_hash, catalog_fingerprint, call_digest, resolved_call_json, state, \
                 result_json, error_code, started_at, completed_at FROM mcp_executions \
                 WHERE execution_id = ?1",
                [execution_id],
                execution_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }
}

fn execution_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<McpExecutionRecord> {
    let call: String = row.get(8)?;
    let result: Option<String> = row.get(10)?;
    Ok(McpExecutionRecord {
        execution_id: row.get(0)?,
        session_id: row.get(1)?,
        idempotency_key: row.get(2)?,
        tool_id: row.get(3)?,
        package_id: row.get(4)?,
        package_hash: row.get(5)?,
        catalog_fingerprint: row.get(6)?,
        call_digest: row.get(7)?,
        resolved_call: json_from_sql(&call)?,
        state: row.get(9)?,
        result: result.map(|value| json_from_sql(&value)).transpose()?,
        error_code: row.get(11)?,
        started_at: row.get(12)?,
        completed_at: row.get(13)?,
    })
}

fn json_from_sql(value: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn validate_digest(value: &str) -> Result<(), StorageError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(StorageError::Invalid("digest is invalid"))
    }
}
