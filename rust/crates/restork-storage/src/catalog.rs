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
pub struct ExtensionRevisionRecord {
    pub package_id: String,
    pub package_kind: String,
    pub manifest: Value,
    pub manifest_hash: String,
    pub state: String,
    pub installed_at: String,
    pub updated_at: String,
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
pub struct DeliverableExportRecord {
    pub export_id: String,
    pub deliverable_id: String,
    pub revision: i64,
    pub format: String,
    pub manifest: Value,
    pub output_hash: String,
    pub approved_at: String,
    pub created_at: String,
    pub idempotency_key: String,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub schedule: Value,
    pub revision: i64,
    pub state: String,
    pub next_run_at: Option<String>,
    pub updated_at: String,
    pub deleted_at: Option<String>,
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

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScheduleRunCursor {
    pub created_at: String,
    pub period_key: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ScheduleRunPage {
    pub items: Vec<ScheduleRunRecord>,
    pub next: Option<ScheduleRunCursor>,
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
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(String, String, String)> = transaction
            .query_row(
                "SELECT package_kind, manifest_hash, installed_at FROM extension_packages \
                 WHERE package_id = ?1",
                [package_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((current_kind, current_hash, _)) = &current {
            if current_kind != package_kind {
                return Err(StorageError::Conflict(
                    "extension package kind cannot change across revisions",
                ));
            }
            if current_hash == &manifest_hash {
                drop(transaction);
                drop(connection);
                return self
                    .extension(package_id)?
                    .ok_or(StorageError::Invalid("extension does not exist"));
            }
            transaction.execute(
                "UPDATE extension_package_revisions SET state = 'superseded', updated_at = ?2 \
                 WHERE package_id = ?1 AND state = 'enabled'",
                params![package_id, occurred_at],
            )?;
        }
        transaction.execute(
            "INSERT INTO extension_package_revisions \
             (package_id, manifest_hash, package_kind, manifest_json, state, installed_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'quarantined', ?5, ?5) \
             ON CONFLICT(package_id, manifest_hash) DO UPDATE SET \
             state = 'quarantined', updated_at = excluded.updated_at",
            params![package_id, manifest_hash, package_kind, document, occurred_at],
        )?;
        let installed_at = current
            .as_ref()
            .map_or(occurred_at, |(_, _, installed_at)| installed_at.as_str());
        transaction.execute(
            "INSERT INTO extension_packages \
             (package_id, package_kind, manifest_json, manifest_hash, state, installed_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, 'quarantined', ?5, ?6) \
             ON CONFLICT(package_id) DO UPDATE SET manifest_json = excluded.manifest_json, \
             manifest_hash = excluded.manifest_hash, state = 'quarantined', \
             updated_at = excluded.updated_at",
            params![
                package_id,
                package_kind,
                document,
                manifest_hash,
                installed_at,
                occurred_at
            ],
        )?;
        let event_kind = if current.is_some() {
            "update_staged"
        } else {
            "installed"
        };
        transaction.execute(
            "INSERT INTO extension_audit_events (package_id, event_kind, detail_json, occurred_at) \
             VALUES (?1, ?2, json_object('manifest_hash', ?3), ?4)",
            params![package_id, event_kind, manifest_hash, occurred_at],
        )?;
        transaction.commit()?;
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
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let changed = transaction.execute(
            "UPDATE extension_packages SET state = ?3, updated_at = ?4 \
             WHERE package_id = ?1 AND manifest_hash = ?2",
            params![package_id, expected_hash, state, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "extension changed since it was reviewed",
            ));
        }
        transaction.execute(
            "UPDATE extension_package_revisions SET state = ?3, updated_at = ?4 \
             WHERE package_id = ?1 AND manifest_hash = ?2",
            params![package_id, expected_hash, state, updated_at],
        )?;
        transaction.execute(
            "INSERT INTO extension_audit_events (package_id, event_kind, detail_json, occurred_at) \
             VALUES (?1, ?2, json_object('manifest_hash', ?3), ?4)",
            params![package_id, state, expected_hash, updated_at],
        )?;
        transaction.commit()?;
        drop(connection);
        self.extension(package_id)?
            .ok_or(StorageError::Invalid("extension does not exist"))
    }

    pub fn extension_revisions(
        &self,
        package_id: &str,
        limit: usize,
    ) -> Result<Vec<ExtensionRevisionRecord>, StorageError> {
        validate_identifier(package_id)?;
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid(
                "extension revision bounds are invalid",
            ));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT package_id, package_kind, manifest_json, manifest_hash, state, installed_at, \
             updated_at FROM extension_package_revisions WHERE package_id = ?1 \
             ORDER BY installed_at DESC, manifest_hash DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![package_id, limit as i64],
            extension_revision_from_row,
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn rollback_extension(
        &self,
        package_id: &str,
        expected_hash: &str,
        target_hash: &str,
        occurred_at: &str,
    ) -> Result<ExtensionRecord, StorageError> {
        validate_identifier(package_id)?;
        validate_digest(expected_hash)?;
        validate_digest(target_hash)?;
        validate_timestamp(occurred_at)?;
        if expected_hash == target_hash {
            return Err(StorageError::Invalid("rollback target is already current"));
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let target: Option<(String, String)> = transaction
            .query_row(
                "SELECT package_kind, manifest_json FROM extension_package_revisions \
                 WHERE package_id = ?1 AND manifest_hash = ?2",
                params![package_id, target_hash],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((package_kind, manifest_json)) = target else {
            return Err(StorageError::Invalid("rollback revision does not exist"));
        };
        let changed = transaction.execute(
            "UPDATE extension_packages SET package_kind = ?3, manifest_json = ?4, \
             manifest_hash = ?2, state = 'quarantined', updated_at = ?5 \
             WHERE package_id = ?1 AND manifest_hash = ?6",
            params![
                package_id,
                target_hash,
                package_kind,
                manifest_json,
                occurred_at,
                expected_hash
            ],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict(
                "extension changed since rollback was reviewed",
            ));
        }
        transaction.execute(
            "UPDATE extension_package_revisions SET state = 'quarantined', updated_at = ?3 \
             WHERE package_id = ?1 AND manifest_hash = ?2",
            params![package_id, target_hash, occurred_at],
        )?;
        transaction.execute(
            "INSERT INTO extension_audit_events (package_id, event_kind, detail_json, occurred_at) \
             VALUES (?1, 'rollback_staged', json_object('from_hash', ?2, 'to_hash', ?3), ?4)",
            params![package_id, expected_hash, target_hash, occurred_at],
        )?;
        transaction.commit()?;
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
            params![updated_at, id, (limit + 1) as i64],
            extension_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.package_id.clone(),
                version: 1,
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
            params![updated_at, id, version, (limit + 1) as i64],
            deliverable_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.deliverable_id.clone(),
                version: last.revision,
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

    #[allow(clippy::too_many_arguments)]
    pub fn record_deliverable_export(
        &self,
        export_id: &str,
        deliverable_id: &str,
        revision: i64,
        format: &str,
        manifest: &Value,
        output_hash: &str,
        idempotency_key: &str,
        occurred_at: &str,
    ) -> Result<DeliverableExportRecord, StorageError> {
        validate_identifier(export_id)?;
        validate_identifier(deliverable_id)?;
        if revision < 1 || !matches!(format, "pptx" | "pdf") {
            return Err(StorageError::Invalid(
                "deliverable export identity is invalid",
            ));
        }
        validate_object(
            manifest,
            "deliverable export manifest must be a JSON object",
        )?;
        validate_digest(output_hash)?;
        validate_text(idempotency_key, 256)?;
        validate_timestamp(occurred_at)?;
        let document = serde_json::to_string(manifest)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = transaction
            .query_row(
                "SELECT export_id, deliverable_id, revision, format, manifest_json, output_hash, \
                 approved_at, created_at, idempotency_key FROM deliverable_exports \
                 WHERE idempotency_key = ?1",
                [idempotency_key],
                deliverable_export_from_row,
            )
            .optional()?;
        if let Some(mut existing) = existing {
            if existing.deliverable_id != deliverable_id
                || existing.revision != revision
                || existing.format != format
                || existing.output_hash != output_hash
                || existing.manifest != *manifest
            {
                return Err(StorageError::Conflict(
                    "idempotency key is bound to another deliverable export",
                ));
            }
            existing.replayed = true;
            return Ok(existing);
        }
        transaction.execute(
            "INSERT INTO deliverable_exports \
             (export_id, deliverable_id, revision, format, manifest_json, output_hash, approved_at, \
              created_at, idempotency_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8)",
            params![
                export_id,
                deliverable_id,
                revision,
                format,
                document,
                output_hash,
                occurred_at,
                idempotency_key
            ],
        )?;
        transaction.commit()?;
        Ok(DeliverableExportRecord {
            export_id: export_id.to_owned(),
            deliverable_id: deliverable_id.to_owned(),
            revision,
            format: format.to_owned(),
            manifest: manifest.clone(),
            output_hash: output_hash.to_owned(),
            approved_at: occurred_at.to_owned(),
            created_at: occurred_at.to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            replayed: false,
        })
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
        let current: Option<(i64, Option<String>)> = transaction
            .query_row(
                "SELECT revision, deleted_at FROM schedules WHERE schedule_id = ?1",
                [schedule_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match (current.as_ref(), expected_revision) {
            (None, None) => {}
            (Some((current, None)), Some(expected)) if *current == expected => {}
            _ => return Err(StorageError::Conflict("schedule changed since it was read")),
        }
        let revision = current
            .as_ref()
            .map(|(revision, _)| *revision)
            .unwrap_or_default()
            + 1;
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
            deleted_at: None,
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
            "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at, deleted_at \
             FROM schedules WHERE deleted_at IS NULL AND (?1 IS NULL OR updated_at < ?1 \
                OR (updated_at = ?1 AND schedule_id < ?2)) \
             ORDER BY updated_at DESC, schedule_id DESC LIMIT ?3",
        )?;
        let (updated_at, id) = cursor_parts(cursor);
        let rows = statement.query_map(
            params![updated_at, id, (limit + 1) as i64],
            schedule_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.schedule_id.clone(),
                version: last.revision,
            });
        Ok(SchedulePage { items, next })
    }

    pub fn deleted_schedules_page(
        &self,
        cursor: Option<&CatalogCursor>,
        limit: usize,
    ) -> Result<SchedulePage, StorageError> {
        validate_catalog_cursor(cursor, limit)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at, deleted_at \
             FROM schedules WHERE deleted_at IS NOT NULL AND (?1 IS NULL OR updated_at < ?1 \
                OR (updated_at = ?1 AND schedule_id < ?2)) \
             ORDER BY updated_at DESC, schedule_id DESC LIMIT ?3",
        )?;
        let (updated_at, id) = cursor_parts(cursor);
        let rows = statement.query_map(
            params![updated_at, id, (limit + 1) as i64],
            schedule_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| CatalogCursor {
                updated_at: last.updated_at.clone(),
                id: last.schedule_id.clone(),
                version: last.revision,
            });
        Ok(SchedulePage { items, next })
    }

    pub fn schedule(&self, schedule_id: &str) -> Result<Option<ScheduleRecord>, StorageError> {
        validate_identifier(schedule_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at, deleted_at \
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
            "SELECT schedule_id, schedule_json, revision, state, next_run_at, updated_at, deleted_at \
             FROM schedules WHERE deleted_at IS NULL AND state = 'active' AND next_run_at IS NOT NULL \
             AND next_run_at <= ?1 ORDER BY next_run_at ASC, schedule_id ASC LIMIT ?2",
        )?;
        let rows = statement.query_map(params![through, limit as i64], schedule_from_row)?;
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
        let available: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schedules WHERE schedule_id = ?1 AND deleted_at IS NULL)",
            [schedule_id],
            |row| row.get(0),
        )?;
        if !available {
            return Err(StorageError::Invalid("schedule is not available"));
        }
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

    /// Atomically reserve a schedule occurrence before any paid provider call.
    /// An existing row is returned as a replay and must never be executed again
    /// automatically, including when its state is still `running` after a crash.
    pub fn claim_schedule_run(
        &self,
        schedule_id: &str,
        period_key: &str,
        claim: &Value,
        created_at: &str,
    ) -> Result<ScheduleRunRecord, StorageError> {
        validate_identifier(schedule_id)?;
        validate_text(period_key, 512)?;
        validate_object(claim, "schedule claim must be a JSON object")?;
        validate_timestamp(created_at)?;
        let document = serde_json::to_string(claim)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let available: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM schedules WHERE schedule_id = ?1 AND deleted_at IS NULL)",
            [schedule_id],
            |row| row.get(0),
        )?;
        if !available {
            return Err(StorageError::Invalid("schedule is not available"));
        }
        let changed = connection.execute(
            "INSERT OR IGNORE INTO schedule_runs \
             (schedule_id, period_key, run_id, result_json, created_at) \
             VALUES (?1, ?2, NULL, ?3, ?4)",
            params![schedule_id, period_key, document, created_at],
        )?;
        let (run_id, result, stored_at): (Option<String>, String, String) = connection.query_row(
            "SELECT run_id, result_json, created_at FROM schedule_runs \
             WHERE schedule_id = ?1 AND period_key = ?2",
            params![schedule_id, period_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        Ok(ScheduleRunRecord {
            schedule_id: schedule_id.to_owned(),
            period_key: period_key.to_owned(),
            run_id,
            result: serde_json::from_str(&result)?,
            created_at: stored_at,
            replayed: changed == 0,
        })
    }

    /// Finalize only the exact claim created by the caller. A stale worker can
    /// therefore never overwrite another process's completed or ambiguous row.
    pub fn complete_schedule_run(
        &self,
        schedule_id: &str,
        period_key: &str,
        expected_claim: &Value,
        result: &Value,
    ) -> Result<ScheduleRunRecord, StorageError> {
        validate_identifier(schedule_id)?;
        validate_text(period_key, 512)?;
        validate_object(expected_claim, "schedule claim must be a JSON object")?;
        validate_object(result, "schedule result must be a JSON object")?;
        let expected = serde_json::to_string(expected_claim)?;
        let document = serde_json::to_string(result)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE schedule_runs SET result_json = ?3 \
             WHERE schedule_id = ?1 AND period_key = ?2 AND result_json = ?4",
            params![schedule_id, period_key, document, expected],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("schedule run claim changed"));
        }
        let (run_id, stored_result, created_at): (Option<String>, String, String) = connection
            .query_row(
                "SELECT run_id, result_json, created_at FROM schedule_runs \
                 WHERE schedule_id = ?1 AND period_key = ?2",
                params![schedule_id, period_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?;
        Ok(ScheduleRunRecord {
            schedule_id: schedule_id.to_owned(),
            period_key: period_key.to_owned(),
            run_id,
            result: serde_json::from_str(&stored_result)?,
            created_at,
            replayed: false,
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

    pub fn schedule_runs_page(
        &self,
        schedule_id: &str,
        cursor: Option<&ScheduleRunCursor>,
        limit: usize,
    ) -> Result<ScheduleRunPage, StorageError> {
        validate_identifier(schedule_id)?;
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid(
                "schedule run page bounds are invalid",
            ));
        }
        if let Some(cursor) = cursor {
            validate_timestamp(&cursor.created_at)?;
            validate_text(&cursor.period_key, 512)?;
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT period_key, run_id, result_json, created_at FROM schedule_runs \
             WHERE schedule_id = ?1 AND (?2 IS NULL OR created_at < ?2 \
                OR (created_at = ?2 AND period_key < ?3)) \
             ORDER BY created_at DESC, period_key DESC LIMIT ?4",
        )?;
        let (created_at, period_key) = cursor
            .map(|cursor| {
                (
                    Some(cursor.created_at.as_str()),
                    Some(cursor.period_key.as_str()),
                )
            })
            .unwrap_or((None, None));
        let rows = statement.query_map(
            params![schedule_id, created_at, period_key, (limit + 1) as i64],
            |row| schedule_run_from_row(schedule_id, row),
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more
            .then(|| items.last())
            .flatten()
            .map(|last| ScheduleRunCursor {
                created_at: last.created_at.clone(),
                period_key: last.period_key.clone(),
            });
        Ok(ScheduleRunPage { items, next })
    }

    pub fn advance_schedule(
        &self,
        schedule_id: &str,
        expected_revision: i64,
        expected_next_run_at: Option<&str>,
        next_run_at: Option<&str>,
        updated_at: &str,
    ) -> Result<bool, StorageError> {
        validate_identifier(schedule_id)?;
        if expected_revision < 1 {
            return Err(StorageError::Invalid("schedule revision is invalid"));
        }
        if let Some(expected_next_run_at) = expected_next_run_at {
            validate_timestamp(expected_next_run_at)?;
        }
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
            "UPDATE schedules SET state = ?2, next_run_at = ?3, updated_at = ?4, \
             revision = revision + 1 WHERE schedule_id = ?1 AND deleted_at IS NULL \
             AND state = 'active' AND revision = ?5 AND next_run_at IS ?6",
            params![
                schedule_id,
                state,
                next_run_at,
                updated_at,
                expected_revision,
                expected_next_run_at,
            ],
        )?;
        Ok(changed == 1)
    }

    pub fn soft_delete_schedule(
        &self,
        schedule_id: &str,
        expected_revision: i64,
        deleted_at: &str,
    ) -> Result<ScheduleRecord, StorageError> {
        validate_identifier(schedule_id)?;
        if expected_revision < 1 {
            return Err(StorageError::Invalid("schedule revision is invalid"));
        }
        validate_timestamp(deleted_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE schedules SET revision = revision + 1, next_run_at = NULL, \
             updated_at = ?3, deleted_at = ?3 WHERE schedule_id = ?1 \
             AND revision = ?2 AND deleted_at IS NULL",
            params![schedule_id, expected_revision, deleted_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("schedule changed since it was read"));
        }
        drop(connection);
        self.schedule(schedule_id)?
            .ok_or(StorageError::Invalid("schedule does not exist"))
    }

    pub fn restore_schedule(
        &self,
        schedule_id: &str,
        expected_revision: i64,
        next_run_at: Option<&str>,
        updated_at: &str,
    ) -> Result<ScheduleRecord, StorageError> {
        validate_identifier(schedule_id)?;
        if expected_revision < 1 {
            return Err(StorageError::Invalid("schedule revision is invalid"));
        }
        if let Some(next_run_at) = next_run_at {
            validate_timestamp(next_run_at)?;
        }
        validate_timestamp(updated_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE schedules SET revision = revision + 1, \
             state = CASE WHEN state = 'active' AND ?3 IS NULL THEN 'paused' ELSE state END, \
             next_run_at = CASE WHEN state = 'active' THEN ?3 ELSE NULL END, \
             updated_at = ?4, deleted_at = NULL WHERE schedule_id = ?1 \
             AND revision = ?2 AND deleted_at IS NOT NULL",
            params![schedule_id, expected_revision, next_run_at, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("schedule changed since it was read"));
        }
        drop(connection);
        self.schedule(schedule_id)?
            .ok_or(StorageError::Invalid("schedule does not exist"))
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

fn extension_revision_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ExtensionRevisionRecord> {
    let document: String = row.get(2)?;
    Ok(ExtensionRevisionRecord {
        package_id: row.get(0)?,
        package_kind: row.get(1)?,
        manifest: json_from_sql(&document)?,
        manifest_hash: row.get(3)?,
        state: row.get(4)?,
        installed_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn validate_digest(value: &str) -> Result<(), StorageError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(StorageError::Invalid("digest is invalid"))
    }
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

fn deliverable_export_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<DeliverableExportRecord> {
    let manifest: String = row.get(4)?;
    Ok(DeliverableExportRecord {
        export_id: row.get(0)?,
        deliverable_id: row.get(1)?,
        revision: row.get(2)?,
        format: row.get(3)?,
        manifest: json_from_sql(&manifest)?,
        output_hash: row.get(5)?,
        approved_at: row.get(6)?,
        created_at: row.get(7)?,
        idempotency_key: row.get(8)?,
        replayed: false,
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
        deleted_at: row.get(6)?,
    })
}

fn schedule_run_from_row(
    schedule_id: &str,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ScheduleRunRecord> {
    let result: String = row.get(2)?;
    Ok(ScheduleRunRecord {
        schedule_id: schedule_id.to_owned(),
        period_key: row.get(0)?,
        run_id: row.get(1)?,
        result: json_from_sql(&result)?,
        created_at: row.get(3)?,
        replayed: false,
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
