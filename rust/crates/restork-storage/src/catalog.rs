use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CatalogCursor {
    pub updated_at: String,
    pub id: String,
    pub version: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ExtensionRecord {
    pub package_id: String,
    pub package_kind: String,
    pub manifest: Value,
    pub manifest_hash: String,
    pub state: String,
    pub installed_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ExtensionPage {
    pub items: Vec<ExtensionRecord>,
    pub next: Option<CatalogCursor>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DeliverableRecord {
    pub deliverable_id: String,
    pub kind: String,
    pub revision: i64,
    pub artifact: Value,
    pub artifact_hash: String,
    pub state: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DeliverablePage {
    pub items: Vec<DeliverableRecord>,
    pub next: Option<CatalogCursor>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub schedule: Value,
    pub revision: i64,
    pub state: String,
    pub next_run_at: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SchedulePage {
    pub items: Vec<ScheduleRecord>,
    pub next: Option<CatalogCursor>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScheduleRunRecord {
    pub schedule_id: String,
    pub period_key: String,
    pub run_id: Option<String>,
    pub result: Value,
    pub created_at: String,
    pub replayed: bool,
}

impl Database {
    pub fn install_extension(
        &self,
        package_id: &str,
        package_kind: &str,
        manifest: &Value,
        occurred_at: &str,
    ) -> Result<ExtensionRecord, StorageError> {
        validate_identifier(package_id)?;
        if !matches!(package_kind, "skill" | "mcp" | "plugin") {
            return Err(StorageError::Invalid("extension package kind is invalid"));
        }
        validate_object(manifest, "extension manifest must be a JSON object")?;
        validate_timestamp(occurred_at)?;
        let document = serde_json::to_string(manifest)?;
        let manifest_hash = json_hash(&document);
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO extension_packages \
             (package_id, package_kind, manifest_json, manifest_hash, state, installed_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'quarantined', ?5, ?5)",
            params![package_id, package_kind, document, manifest_hash, occurred_at],
        )?;
        Ok(ExtensionRecord {
            package_id: package_id.to_owned(),
            package_kind: package_kind.to_owned(),
            manifest: manifest.clone(),
            manifest_hash,
            state: "quarantined".to_owned(),
            installed_at: occurred_at.to_owned(),
            updated_at: occurred_at.to_owned(),
        })
    }

    pub fn set_extension_state(
        &self,
        package_id: &str,
        expected_hash: &str,
        state: &str,
        updated_at: &str,
    ) -> Result<ExtensionRecord, StorageError> {
        validate_identifier(package_id)?;
        validate_text(expected_hash, 64)?;
        if !matches!(state, "quarantined" | "enabled" | "disabled") {
            return Err(StorageError::Invalid("extension state is invalid"));
        }
        validate_timestamp(updated_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE extension_packages SET state = ?3, updated_at = ?4 \
             WHERE package_id = ?1 AND manifest_hash = ?2",
            params![package_id, expected_hash, state, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "extension changed since it was reviewed",
            ));
        }
        drop(connection);
        self.extension(package_id)?
            .ok_or(StorageError::Invalid("extension does not exist"))
    }

    pub fn extension(&self, package_id: &str) -> Result<Option<ExtensionRecord>, StorageError> {
        validate_identifier(package_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT package_id, package_kind, manifest_json, manifest_hash, state, \
                 installed_at, updated_at FROM extension_packages WHERE package_id = ?1",
                [package_id],
                extension_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn extensions_page(
        &self,
        cursor: Option<&CatalogCursor>,
        limit: usize,
    ) -> Result<ExtensionPage, StorageError> {
        validate_catalog_cursor(cursor, limit)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT package_id, package_kind, manifest_json, manifest_hash, state, installed_at, \
             updated_at FROM extension_packages \
             WHERE (?1 IS NULL OR updated_at < ?1 OR (updated_at = ?1 AND package_id < ?2)) \
             ORDER BY updated_at DESC, package_id DESC LIMIT ?3",
        )?;
        let (updated_at, id) = cursor_parts(cursor);
        let rows = statement.query_map(
            params![
                updated_at,
                id,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            extension_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more.then(|| {
            let last = items.last().expect("non-empty bounded page");
            CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.package_id.clone(),
                version: 1,
            }
        });
        Ok(ExtensionPage { items, next })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn save_deliverable(
        &self,
        deliverable_id: &str,
        kind: &str,
        revision: i64,
        artifact: &Value,
        state: &str,
        occurred_at: &str,
    ) -> Result<DeliverableRecord, StorageError> {
        validate_identifier(deliverable_id)?;
        if !matches!(kind, "daily_report" | "weekly_report" | "deck") || revision < 1 {
            return Err(StorageError::Invalid("deliverable identity is invalid"));
        }
        validate_object(artifact, "deliverable artifact must be a JSON object")?;
        validate_text(state, 64)?;
        validate_timestamp(occurred_at)?;
        let document = serde_json::to_string(artifact)?;
        let artifact_hash = json_hash(&document);
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO deliverables \
             (deliverable_id, kind, revision, artifact_json, artifact_hash, state, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            params![
                deliverable_id,
                kind,
                revision,
                document,
                artifact_hash,
                state,
                occurred_at
            ],
        )?;
        Ok(DeliverableRecord {
            deliverable_id: deliverable_id.to_owned(),
            kind: kind.to_owned(),
            revision,
            artifact: artifact.clone(),
            artifact_hash,
            state: state.to_owned(),
            created_at: occurred_at.to_owned(),
            updated_at: occurred_at.to_owned(),
        })
    }

    pub fn deliverables_page(
        &self,
        cursor: Option<&CatalogCursor>,
        limit: usize,
    ) -> Result<DeliverablePage, StorageError> {
        validate_catalog_cursor(cursor, limit)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT deliverable_id, kind, revision, artifact_json, artifact_hash, state, \
             created_at, updated_at FROM deliverables \
             WHERE (?1 IS NULL OR updated_at < ?1 \
                OR (updated_at = ?1 AND deliverable_id < ?2) \
                OR (updated_at = ?1 AND deliverable_id = ?2 AND revision < ?3)) \
             ORDER BY updated_at DESC, deliverable_id DESC, revision DESC LIMIT ?4",
        )?;
        let (updated_at, id) = cursor_parts(cursor);
        let version = cursor.map_or(i64::MAX, |cursor| cursor.version);
        let rows = statement.query_map(
            params![
                updated_at,
                id,
                version,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            deliverable_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more.then(|| {
            let last = items.last().expect("non-empty bounded page");
            CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.deliverable_id.clone(),
                version: last.revision,
            }
        });
        Ok(DeliverablePage { items, next })
    }

    pub fn deliverable(
        &self,
        deliverable_id: &str,
        revision: i64,
    ) -> Result<Option<DeliverableRecord>, StorageError> {
        validate_identifier(deliverable_id)?;
        if revision < 1 {
            return Err(StorageError::Invalid("deliverable revision is invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT deliverable_id, kind, revision, artifact_json, artifact_hash, state, \
                 created_at, updated_at FROM deliverables \
                 WHERE deliverable_id = ?1 AND revision = ?2",
                params![deliverable_id, revision],
                deliverable_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn put_schedule(
        &self,
        schedule_id: &str,
        schedule: &Value,
        expected_revision: Option<i64>,
        state: &str,
        next_run_at: Option<&str>,
        updated_at: &str,
    ) -> Result<ScheduleRecord, StorageError> {
        validate_identifier(schedule_id)?;
        validate_object(schedule, "schedule must be a JSON object")?;
        if !matches!(state, "active" | "paused") {
            return Err(StorageError::Invalid("schedule state is invalid"));
        }
        if let Some(value) = next_run_at {
            validate_timestamp(value)?;
        }
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(schedule)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM schedules WHERE schedule_id = ?1",
                [schedule_id],
                |row| row.get(0),
            )
            .optional()?;
        match (current, expected_revision) {
            (None, None) => {}
            (Some(current), Some(expected)) if current == expected => {}
            _ => return Err(StorageError::Conflict("schedule changed since it was read")),
        }
        let revision = current.unwrap_or_default() + 1;
        transaction.execute(
            "INSERT INTO schedules \
             (schedule_id, schedule_json, revision, state, next_run_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(schedule_id) DO UPDATE SET schedule_json = excluded.schedule_json, \
             revision = excluded.revision, state = excluded.state, \
             next_run_at = excluded.next_run_at, updated_at = excluded.updated_at",
            params![
                schedule_id,
                document,
                revision,
                state,
                next_run_at,
                updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(ScheduleRecord {
            schedule_id: schedule_id.to_owned(),
            schedule: schedule.clone(),
            revision,
            state: state.to_owned(),
            next_run_at: next_run_at.map(str::to_owned),
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn schedules_page(
        &self,
        cursor: Option<&CatalogCursor>,
        limit: usize,
    ) -> Result<SchedulePage, StorageError> {
        validate_catalog_cursor(cursor, limit)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at \
             FROM schedules WHERE (?1 IS NULL OR updated_at < ?1 \
                OR (updated_at = ?1 AND schedule_id < ?2)) \
             ORDER BY updated_at DESC, schedule_id DESC LIMIT ?3",
        )?;
        let (updated_at, id) = cursor_parts(cursor);
        let rows = statement.query_map(
            params![
                updated_at,
                id,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            schedule_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more.then(|| {
            let last = items.last().expect("non-empty bounded page");
            CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.schedule_id.clone(),
                version: last.revision,
            }
        });
        Ok(SchedulePage { items, next })
    }

    pub fn schedule(&self, schedule_id: &str) -> Result<Option<ScheduleRecord>, StorageError> {
        validate_identifier(schedule_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at \
                 FROM schedules WHERE schedule_id = ?1",
                [schedule_id],
                schedule_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn due_schedules(
        &self,
        through: &str,
        limit: usize,
    ) -> Result<Vec<ScheduleRecord>, StorageError> {
        validate_timestamp(through)?;
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("due schedule bounds are invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at \
             FROM schedules WHERE state = 'active' AND next_run_at IS NOT NULL \
             AND next_run_at <= ?1 ORDER BY next_run_at ASC, schedule_id ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![through, i64::try_from(limit).expect("bounded limit")],
            schedule_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn record_schedule_run(
        &self,
        schedule_id: &str,
        period_key: &str,
        run_id: Option<&str>,
        result: &Value,
        created_at: &str,
    ) -> Result<ScheduleRunRecord, StorageError> {
        validate_identifier(schedule_id)?;
        validate_text(period_key, 512)?;
        if let Some(run_id) = run_id {
            validate_identifier(run_id)?;
        }
        validate_object(result, "schedule result must be a JSON object")?;
        validate_timestamp(created_at)?;
        let document = serde_json::to_string(result)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "INSERT OR IGNORE INTO schedule_runs \
             (schedule_id, period_key, run_id, result_json, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![schedule_id, period_key, run_id, document, created_at],
        )?;
        let (stored_run_id, stored_result, stored_at): (Option<String>, String, String) =
            connection.query_row(
                "SELECT run_id, result_json, created_at FROM schedule_runs \
                 WHERE schedule_id = ?1 AND period_key = ?2",
                params![schedule_id, period_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        Ok(ScheduleRunRecord {
            schedule_id: schedule_id.to_owned(),
            period_key: period_key.to_owned(),
            run_id: stored_run_id,
            result: serde_json::from_str(&stored_result)?,
            created_at: stored_at,
            replayed: changed == 0,
        })
    }

    pub fn schedule_run(
        &self,
        schedule_id: &str,
        period_key: &str,
    ) -> Result<Option<ScheduleRunRecord>, StorageError> {
        validate_identifier(schedule_id)?;
        validate_text(period_key, 512)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT run_id, result_json, created_at FROM schedule_runs \
                 WHERE schedule_id = ?1 AND period_key = ?2",
                params![schedule_id, period_key],
                |row| {
                    let result: String = row.get(1)?;
                    Ok((row.get(0)?, result, row.get(2)?))
                },
            )
            .optional()?
            .map(|(run_id, result, created_at)| {
                Ok(ScheduleRunRecord {
                    schedule_id: schedule_id.to_owned(),
                    period_key: period_key.to_owned(),
                    run_id,
                    result: serde_json::from_str(&result)?,
                    created_at,
                    replayed: true,
                })
            })
            .transpose()
    }

    pub fn advance_schedule(
        &self,
        schedule_id: &str,
        next_run_at: Option<&str>,
        updated_at: &str,
    ) -> Result<ScheduleRecord, StorageError> {
        validate_identifier(schedule_id)?;
        if let Some(next_run_at) = next_run_at {
            validate_timestamp(next_run_at)?;
        }
        validate_timestamp(updated_at)?;
        let state = if next_run_at.is_some() {
            "active"
        } else {
            "paused"
        };
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE schedules SET state = ?2, next_run_at = ?3, updated_at = ?4 \
             WHERE schedule_id = ?1",
            params![schedule_id, state, next_run_at, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Invalid("schedule does not exist"));
        }
        drop(connection);
        self.schedule(schedule_id)?
            .ok_or(StorageError::Invalid("schedule does not exist"))
    }

    pub fn delete_schedule(
        &self,
        schedule_id: &str,
        expected_revision: i64,
    ) -> Result<(), StorageError> {
        validate_identifier(schedule_id)?;
        if expected_revision < 1 {
            return Err(StorageError::Invalid("schedule revision is invalid"));
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM schedules WHERE schedule_id = ?1",
                [schedule_id],
                |row| row.get(0),
            )
            .optional()?;
        if current != Some(expected_revision) {
            return Err(StorageError::Conflict("schedule changed since it was read"));
        }
        transaction.execute(
            "DELETE FROM schedule_runs WHERE schedule_id = ?1",
            [schedule_id],
        )?;
        transaction.execute(
            "DELETE FROM schedules WHERE schedule_id = ?1",
            [schedule_id],
        )?;
        transaction.commit()?;
        Ok(())
    }
}

fn json_hash(document: &str) -> String {
    Sha256::digest(document.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_catalog_cursor(
    cursor: Option<&CatalogCursor>,
    limit: usize,
) -> Result<(), StorageError> {
    if !(1..=100).contains(&limit) {
        return Err(StorageError::Invalid("catalog page bounds are invalid"));
    }
    if let Some(cursor) = cursor {
        validate_timestamp(&cursor.updated_at)?;
        validate_identifier(&cursor.id)?;
        if cursor.version < 1 {
            return Err(StorageError::Invalid("catalog cursor version is invalid"));
        }
    }
    Ok(())
}

fn cursor_parts(cursor: Option<&CatalogCursor>) -> (Option<&str>, Option<&str>) {
    cursor
        .map(|cursor| (Some(cursor.updated_at.as_str()), Some(cursor.id.as_str())))
        .unwrap_or((None, None))
}

fn extension_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExtensionRecord> {
    let document: String = row.get(2)?;
    Ok(ExtensionRecord {
        package_id: row.get(0)?,
        package_kind: row.get(1)?,
        manifest: json_from_sql(&document)?,
        manifest_hash: row.get(3)?,
        state: row.get(4)?,
        installed_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn deliverable_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DeliverableRecord> {
    let document: String = row.get(3)?;
    Ok(DeliverableRecord {
        deliverable_id: row.get(0)?,
        kind: row.get(1)?,
        revision: row.get(2)?,
        artifact: json_from_sql(&document)?,
        artifact_hash: row.get(4)?,
        state: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn schedule_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScheduleRecord> {
    let document: String = row.get(1)?;
    Ok(ScheduleRecord {
        schedule_id: row.get(0)?,
        schedule: json_from_sql(&document)?,
        revision: row.get(2)?,
        state: row.get(3)?,
        next_run_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
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
