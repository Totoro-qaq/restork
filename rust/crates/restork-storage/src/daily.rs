use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DailySourceRecord {
    pub source: String,
    pub enabled: bool,
    pub consent: Value,
    pub config: Value,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CalendarIntervalRecord {
    pub interval_id: String,
    pub starts_at: String,
    pub ends_at: String,
    pub availability: String,
    pub details: Value,
    pub source_kind: String,
    pub source_revision: String,
    pub observed_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MusicPreferenceRecord {
    pub preference_id: String,
    pub preference: Value,
    pub imported_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct DailyCacheRecord {
    pub cache_key: String,
    pub payload: Value,
    pub observed_at: String,
    pub expires_at: String,
    pub updated_at: String,
}

impl Database {
    pub fn daily_source(&self, source: &str) -> Result<Option<DailySourceRecord>, StorageError> {
        validate_daily_source(source)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT enabled, consent_json, config_json, updated_at FROM daily_source_settings \
                 WHERE source = ?1",
                [source],
                |row| {
                    let consent: String = row.get(1)?;
                    let config: String = row.get(2)?;
                    Ok((row.get::<_, i64>(0)? != 0, consent, config, row.get(3)?))
                },
            )
            .optional()?
            .map(|(enabled, consent, config, updated_at)| {
                Ok(DailySourceRecord {
                    source: source.to_owned(),
                    enabled,
                    consent: serde_json::from_str(&consent)?,
                    config: serde_json::from_str(&config)?,
                    updated_at,
                })
            })
            .transpose()
    }

    pub fn put_daily_source(
        &self,
        source: &str,
        enabled: bool,
        consent: &Value,
        config: &Value,
        updated_at: &str,
    ) -> Result<DailySourceRecord, StorageError> {
        validate_daily_source(source)?;
        validate_object(consent, "daily source consent must be a JSON object")?;
        validate_object(config, "daily source config must be a JSON object")?;
        validate_timestamp(updated_at)?;
        let consent_document = serde_json::to_string(consent)?;
        let config_document = serde_json::to_string(config)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO daily_source_settings \
             (source, enabled, consent_json, config_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled, \
             consent_json = excluded.consent_json, config_json = excluded.config_json, \
             updated_at = excluded.updated_at",
            params![
                source,
                i64::from(enabled),
                consent_document,
                config_document,
                updated_at
            ],
        )?;
        Ok(DailySourceRecord {
            source: source.to_owned(),
            enabled,
            consent: consent.clone(),
            config: config.clone(),
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn replace_calendar_intervals(
        &self,
        records: &[CalendarIntervalRecord],
    ) -> Result<(), StorageError> {
        if records.len() > 500 {
            return Err(StorageError::Invalid("calendar import is too large"));
        }
        for record in records {
            validate_identifier(&record.interval_id)?;
            validate_timestamp(&record.starts_at)?;
            validate_timestamp(&record.ends_at)?;
            validate_text(&record.availability, 32)?;
            validate_object(&record.details, "calendar details must be a JSON object")?;
            validate_text(&record.source_kind, 64)?;
            validate_text(&record.source_revision, 128)?;
            validate_timestamp(&record.observed_at)?;
            if record.starts_at >= record.ends_at {
                return Err(StorageError::Invalid("calendar interval is invalid"));
            }
        }
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM calendar_intervals", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO calendar_intervals \
                 (interval_id, starts_at, ends_at, availability, details_json, source_kind, \
                 source_revision, observed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for record in records {
                statement.execute(params![
                    record.interval_id,
                    record.starts_at,
                    record.ends_at,
                    record.availability,
                    serde_json::to_string(&record.details)?,
                    record.source_kind,
                    record.source_revision,
                    record.observed_at,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn calendar_intervals_after(
        &self,
        after: &str,
        limit: usize,
    ) -> Result<Vec<CalendarIntervalRecord>, StorageError> {
        validate_timestamp(after)?;
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("calendar page size is invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT interval_id, starts_at, ends_at, availability, details_json, source_kind, \
             source_revision, observed_at FROM calendar_intervals WHERE ends_at > ?1 \
             ORDER BY starts_at ASC, interval_id ASC LIMIT ?2",
        )?;
        let limit = i64::try_from(limit)
            .map_err(|_| StorageError::Invalid("calendar page size is invalid"))?;
        let rows = statement.query_map(params![after, limit], |row| {
            let details: String = row.get(4)?;
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                details,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })?;
        rows.map(|row| {
            let (
                interval_id,
                starts_at,
                ends_at,
                availability,
                details,
                source_kind,
                source_revision,
                observed_at,
            ) = row?;
            Ok(CalendarIntervalRecord {
                interval_id,
                starts_at,
                ends_at,
                availability,
                details: serde_json::from_str(&details)?,
                source_kind,
                source_revision,
                observed_at,
            })
        })
        .collect()
    }

    pub fn put_music_preferences(
        &self,
        preference_id: &str,
        preference: &Value,
        imported_at: &str,
    ) -> Result<MusicPreferenceRecord, StorageError> {
        validate_identifier(preference_id)?;
        validate_object(preference, "music preference must be a JSON object")?;
        validate_timestamp(imported_at)?;
        let document = serde_json::to_string(preference)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute("DELETE FROM music_preferences", [])?;
        transaction.execute(
            "INSERT INTO music_preferences (preference_id, preference_json, imported_at) \
             VALUES (?1, ?2, ?3)",
            params![preference_id, document, imported_at],
        )?;
        transaction.commit()?;
        Ok(MusicPreferenceRecord {
            preference_id: preference_id.to_owned(),
            preference: preference.clone(),
            imported_at: imported_at.to_owned(),
        })
    }

    pub fn music_preferences(&self) -> Result<Option<MusicPreferenceRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT preference_id, preference_json, imported_at FROM music_preferences \
                 ORDER BY imported_at DESC LIMIT 1",
                [],
                |row| {
                    let document: String = row.get(1)?;
                    Ok((row.get(0)?, document, row.get(2)?))
                },
            )
            .optional()?
            .map(|(preference_id, document, imported_at)| {
                Ok(MusicPreferenceRecord {
                    preference_id,
                    preference: serde_json::from_str(&document)?,
                    imported_at,
                })
            })
            .transpose()
    }

    pub fn clear_music_preferences(&self) -> Result<(), StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute("DELETE FROM music_preferences", [])?;
        Ok(())
    }

    pub fn daily_cache(&self, cache_key: &str) -> Result<Option<DailyCacheRecord>, StorageError> {
        validate_identifier(cache_key)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT payload_json, observed_at, expires_at, updated_at FROM daily_cache \
                 WHERE cache_key = ?1",
                [cache_key],
                |row| {
                    let document: String = row.get(0)?;
                    Ok((document, row.get(1)?, row.get(2)?, row.get(3)?))
                },
            )
            .optional()?
            .map(|(document, observed_at, expires_at, updated_at)| {
                Ok(DailyCacheRecord {
                    cache_key: cache_key.to_owned(),
                    payload: serde_json::from_str(&document)?,
                    observed_at,
                    expires_at,
                    updated_at,
                })
            })
            .transpose()
    }

    pub fn put_daily_cache(
        &self,
        cache_key: &str,
        payload: &Value,
        observed_at: &str,
        expires_at: &str,
        updated_at: &str,
    ) -> Result<DailyCacheRecord, StorageError> {
        validate_identifier(cache_key)?;
        validate_object(payload, "daily cache must be a JSON object")?;
        validate_timestamp(observed_at)?;
        validate_timestamp(expires_at)?;
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(payload)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO daily_cache (cache_key, payload_json, observed_at, expires_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(cache_key) DO UPDATE SET \
             payload_json = excluded.payload_json, observed_at = excluded.observed_at, \
             expires_at = excluded.expires_at, updated_at = excluded.updated_at",
            params![cache_key, document, observed_at, expires_at, updated_at],
        )?;
        Ok(DailyCacheRecord {
            cache_key: cache_key.to_owned(),
            payload: payload.clone(),
            observed_at: observed_at.to_owned(),
            expires_at: expires_at.to_owned(),
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn clear_daily_cache(&self, cache_key: &str) -> Result<(), StorageError> {
        validate_identifier(cache_key)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute("DELETE FROM daily_cache WHERE cache_key = ?1", [cache_key])?;
        Ok(())
    }
}

fn validate_daily_source(source: &str) -> Result<(), StorageError> {
    if matches!(source, "weather" | "calendar" | "music") {
        Ok(())
    } else {
        Err(StorageError::Invalid("daily source is invalid"))
    }
}
