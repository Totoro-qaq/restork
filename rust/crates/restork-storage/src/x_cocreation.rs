//! Durable, local-only records for the X co-creation draft workflow.

use std::collections::BTreeMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

const DIFFERENCE_KINDS: [&str; 6] = [
    "opening",
    "length",
    "tone",
    "remove_numbers",
    "cta",
    "image",
];

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct XCocreationDraftRecord {
    pub draft_id: String,
    pub artifact: Value,
    pub artifact_hash: String,
    pub state: String,
    pub final_body: Option<String>,
    pub final_reply: Option<String>,
    pub final_url: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Copy)]
pub struct NewXCocreationDraft<'a> {
    pub draft_id: &'a str,
    pub artifact: &'a Value,
    pub state: &'a str,
    pub occurred_at: &'a str,
}

impl Database {
    pub fn save_x_cocreation_draft(
        &self,
        draft: NewXCocreationDraft<'_>,
    ) -> Result<XCocreationDraftRecord, StorageError> {
        validate_identifier(draft.draft_id)?;
        validate_object(draft.artifact, "X draft artifact must be a JSON object")?;
        if !matches!(draft.state, "draft" | "published" | "discarded") {
            return Err(StorageError::Invalid("invalid X draft state"));
        }
        validate_x_artifact(draft.artifact)?;
        validate_timestamp(draft.occurred_at)?;
        let document = serde_json::to_string(draft.artifact)?;
        let artifact_hash = sha256_hex(document.as_bytes());
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO x_cocreation_drafts
             (draft_id, artifact_json, artifact_hash, state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                draft.draft_id,
                document,
                artifact_hash,
                draft.state,
                draft.occurred_at,
            ],
        )?;
        x_draft_by_id(&connection, draft.draft_id)?
            .ok_or(StorageError::Invalid("X draft did not persist"))
    }

    pub fn x_cocreation_drafts(
        &self,
        limit: usize,
    ) -> Result<Vec<XCocreationDraftRecord>, StorageError> {
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("invalid X draft page"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT draft_id, artifact_json, artifact_hash, state, final_body, final_reply,
                    final_url, created_at, updated_at
             FROM x_cocreation_drafts ORDER BY updated_at DESC, draft_id DESC LIMIT ?1",
        )?;
        statement
            .query_map([limit as i64], x_draft_from_row)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_x_cocreation_publication(
        &self,
        draft_id: &str,
        final_body: &str,
        final_reply: &str,
        final_url: Option<&str>,
        difference_kinds: &[String],
        expected_updated_at: &str,
        occurred_at: &str,
    ) -> Result<XCocreationDraftRecord, StorageError> {
        validate_identifier(draft_id)?;
        validate_text(final_body, 4_000)?;
        validate_text(final_reply, 2_000)?;
        validate_timestamp(expected_updated_at)?;
        validate_timestamp(occurred_at)?;
        if !contains_canonical_x_status_url(final_reply) {
            return Err(StorageError::Invalid(
                "X draft reply must retain a canonical source URL",
            ));
        }
        if let Some(url) = final_url {
            validate_text(url, 512)?;
            if !canonical_x_status_url(url) {
                return Err(StorageError::Invalid("final X URL is invalid"));
            }
        }
        let mut kinds = difference_kinds.to_vec();
        kinds.sort();
        kinds.dedup();
        if kinds.len() > DIFFERENCE_KINDS.len()
            || kinds
                .iter()
                .any(|kind| !DIFFERENCE_KINDS.contains(&kind.as_str()))
        {
            return Err(StorageError::Invalid("invalid X draft difference kind"));
        }
        let difference_document = serde_json::to_string(&kinds)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction()?;
        let original_body = transaction
            .query_row(
                "SELECT artifact_json FROM x_cocreation_drafts
                 WHERE draft_id = ?1 AND updated_at = ?2",
                params![draft_id, expected_updated_at],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .and_then(|document| serde_json::from_str::<Value>(&document).ok())
            .and_then(|artifact| {
                artifact["variants"]
                    .as_array()
                    .and_then(|variants| variants.first())
                    .and_then(|variant| variant["body"].as_str())
                    .map(ToOwned::to_owned)
            })
            .ok_or(StorageError::Conflict("X draft changed since it was read"))?;
        if transaction.execute(
            "UPDATE x_cocreation_drafts
             SET state = 'published', final_body = ?1, final_reply = ?2, final_url = ?3,
                 updated_at = ?4
             WHERE draft_id = ?5 AND updated_at = ?6",
            params![
                final_body,
                final_reply,
                final_url,
                occurred_at,
                draft_id,
                expected_updated_at,
            ],
        )? != 1
        {
            return Err(StorageError::Conflict("X draft changed since it was read"));
        }
        let edit_id = format!(
            "x-edit-{}",
            &sha256_hex(format!("{draft_id}\0{occurred_at}").as_bytes())[..24]
        );
        transaction.execute(
            "INSERT INTO x_cocreation_edits
             (edit_id, draft_id, original_body, final_body, final_reply, final_url,
              difference_kinds_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                edit_id,
                draft_id,
                original_body,
                final_body,
                final_reply,
                final_url,
                difference_document,
                occurred_at,
            ],
        )?;
        let record = x_draft_by_id(&transaction, draft_id)?
            .ok_or(StorageError::Invalid("X draft disappeared"))?;
        transaction.commit()?;
        Ok(record)
    }

    pub fn x_voice_observation_counts(&self) -> Result<BTreeMap<String, usize>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT value, COUNT(*) FROM x_cocreation_edits, json_each(difference_kinds_json)
             GROUP BY value ORDER BY value",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as usize))
        })?;
        rows.collect::<Result<BTreeMap<_, _>, _>>()
            .map_err(Into::into)
    }

    pub fn delete_expired_x_evidence(&self, cutoff: &str) -> Result<usize, StorageError> {
        validate_timestamp(cutoff)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .execute(
                "DELETE FROM radar_items WHERE lane = 'x' AND updated_at < ?1",
                [cutoff],
            )
            .map_err(Into::into)
    }
}

fn validate_x_artifact(artifact: &Value) -> Result<(), StorageError> {
    let category = artifact["category"]
        .as_str()
        .ok_or(StorageError::Invalid("X draft category is missing"))?;
    if !matches!(category, "开发判断" | "一手动态" | "失败复盘") {
        return Err(StorageError::Invalid("X draft category is invalid"));
    }
    validate_text(
        artifact["title"]
            .as_str()
            .ok_or(StorageError::Invalid("X draft title is missing"))?,
        300,
    )?;
    let evidence = artifact["evidence_ids"]
        .as_array()
        .ok_or(StorageError::Invalid("X draft evidence is invalid"))?;
    if evidence.is_empty() || evidence.len() > 6 || evidence.iter().any(|id| id.as_str().is_none())
    {
        return Err(StorageError::Invalid("X draft evidence is invalid"));
    }
    let variants = artifact["variants"]
        .as_array()
        .ok_or(StorageError::Invalid("X draft variants are invalid"))?;
    if variants.len() != 3 {
        return Err(StorageError::Invalid("X draft must contain three variants"));
    }
    for variant in variants {
        let body = variant["body"]
            .as_str()
            .ok_or(StorageError::Invalid("X draft body is missing"))?;
        let reply = variant["first_reply"]
            .as_str()
            .ok_or(StorageError::Invalid("X draft reply is missing"))?;
        validate_text(body, 4_000)?;
        validate_text(reply, 2_000)?;
        if contains_url(body) || !contains_canonical_x_status_url(reply) {
            return Err(StorageError::Invalid("X draft link placement is invalid"));
        }
    }
    let images = artifact["image_directions"]
        .as_array()
        .ok_or(StorageError::Invalid(
            "X draft image directions are invalid",
        ))?;
    if images.len() != 2 || images.iter().any(|value| value.as_str().is_none()) {
        return Err(StorageError::Invalid(
            "X draft must contain two image directions",
        ));
    }
    Ok(())
}

fn contains_url(value: &str) -> bool {
    value.contains("http://")
        || value.contains("https://")
        || value.contains("x.com/")
        || value.contains("twitter.com/")
}

fn contains_canonical_x_status_url(value: &str) -> bool {
    value.split_whitespace().any(|part| {
        canonical_x_status_url(part.trim_matches(|character: char| {
            matches!(character, ',' | '.' | ')' | ']' | '>' | '，' | '。')
        }))
    })
}

fn canonical_x_status_url(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("https://x.com/") else {
        return false;
    };
    let mut segments = rest.split('/');
    let Some(handle) = segments.next() else {
        return false;
    };
    let Some("status") = segments.next() else {
        return false;
    };
    let Some(status_id) = segments.next() else {
        return false;
    };
    segments.next().is_none()
        && !handle.is_empty()
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && status_id.bytes().all(|byte| byte.is_ascii_digit())
}

fn x_draft_by_id(
    connection: &rusqlite::Connection,
    draft_id: &str,
) -> Result<Option<XCocreationDraftRecord>, StorageError> {
    connection
        .query_row(
            "SELECT draft_id, artifact_json, artifact_hash, state, final_body, final_reply,
                    final_url, created_at, updated_at
             FROM x_cocreation_drafts WHERE draft_id = ?1",
            [draft_id],
            x_draft_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn x_draft_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<XCocreationDraftRecord> {
    let document: String = row.get(1)?;
    let artifact = serde_json::from_str(&document).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            document.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(XCocreationDraftRecord {
        draft_id: row.get(0)?,
        artifact,
        artifact_hash: row.get(2)?,
        state: row.get(3)?,
        final_body: row.get(4)?,
        final_reply: row.get(5)?,
        final_url: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
