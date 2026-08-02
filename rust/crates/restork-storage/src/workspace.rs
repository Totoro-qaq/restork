use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    Database, StorageError, validate_identifier, validate_object, validate_text, validate_timestamp,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PersonalSettingsRecord {
    pub settings: Value,
    pub version: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ProviderProfileRecord {
    pub provider: Value,
    pub revision: i64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ConfigurationProfileRecord {
    pub profile: Value,
    pub revision: i64,
    pub builtin: bool,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PromptRevisionRecord {
    pub prompt: Value,
    pub content_hash: String,
    pub active: bool,
    pub created_at: String,
}

#[derive(Clone, Copy)]
pub struct NewSession<'a> {
    pub session_id: &'a str,
    pub title: &'a str,
    pub profile_id: &'a str,
    pub locale: Option<&'a str>,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionRecord {
    pub session_id: String,
    pub title: String,
    pub profile_id: String,
    pub status: String,
    pub version: i64,
    pub locale: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub archived_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionCursor {
    pub updated_at: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionPage {
    pub items: Vec<SessionRecord>,
    pub next: Option<SessionCursor>,
}

#[derive(Clone, Copy)]
pub struct NewSessionMessage<'a> {
    pub message_id: &'a str,
    pub session_id: &'a str,
    pub role: &'a str,
    pub content: &'a str,
    pub context: &'a Value,
    pub data_class: &'a str,
    pub occurred_at: &'a str,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct StoredSessionMessage {
    pub message_id: String,
    pub session_id: String,
    pub sequence: i64,
    pub role: String,
    pub content: String,
    pub context: Value,
    pub data_class: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct MessagePage {
    pub items: Vec<StoredSessionMessage>,
    pub next_after: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SessionSearchHit {
    pub session_id: String,
    pub message_id: String,
    pub sequence: i64,
    pub excerpt: String,
}

impl Database {
    pub fn personal_settings(&self) -> Result<Option<PersonalSettingsRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT settings_json, version, updated_at FROM personal_settings WHERE singleton = 1",
                [],
                |row| {
                    let document: String = row.get(0)?;
                    Ok((document, row.get(1)?, row.get(2)?))
                },
            )
            .optional()?
            .map(|(document, version, updated_at)| {
                Ok(PersonalSettingsRecord {
                    settings: serde_json::from_str(&document)?,
                    version,
                    updated_at,
                })
            })
            .transpose()
    }

    pub fn put_personal_settings(
        &self,
        settings: &Value,
        expected_version: Option<i64>,
        updated_at: &str,
    ) -> Result<PersonalSettingsRecord, StorageError> {
        validate_object(settings, "personal settings must be a JSON object")?;
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(settings)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT version FROM personal_settings WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match (current, expected_version) {
            (None, None) => {}
            (Some(current), Some(expected)) if current == expected => {}
            _ => {
                return Err(StorageError::Conflict(
                    "personal settings changed since they were read",
                ));
            }
        }
        let version = current.unwrap_or_default() + 1;
        transaction.execute(
            "INSERT INTO personal_settings (singleton, settings_json, version, updated_at) \
             VALUES (1, ?1, ?2, ?3) \
             ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json, \
             version = excluded.version, updated_at = excluded.updated_at",
            params![document, version, updated_at],
        )?;
        transaction.commit()?;
        Ok(PersonalSettingsRecord {
            settings: settings.clone(),
            version,
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn clear_personal_settings(
        &self,
        expected_version: Option<i64>,
    ) -> Result<(), StorageError> {
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT version FROM personal_settings WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match (current, expected_version) {
            (None, _) => return Ok(()),
            (Some(current), Some(expected)) if current == expected => {}
            _ => {
                return Err(StorageError::Conflict(
                    "personal settings changed since they were read",
                ));
            }
        }
        transaction.execute("DELETE FROM personal_settings WHERE singleton = 1", [])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn provider_profiles(&self) -> Result<Vec<ProviderProfileRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT provider_json, revision, updated_at FROM provider_profiles \
             ORDER BY provider_id ASC LIMIT 100",
        )?;
        let rows = statement.query_map([], |row| {
            let document: String = row.get(0)?;
            Ok((document, row.get(1)?, row.get(2)?))
        })?;
        rows.map(|row| {
            let (document, revision, updated_at) = row?;
            Ok(ProviderProfileRecord {
                provider: serde_json::from_str(&document)?,
                revision,
                updated_at,
            })
        })
        .collect()
    }

    pub fn provider_profile(
        &self,
        provider_id: &str,
    ) -> Result<Option<ProviderProfileRecord>, StorageError> {
        validate_identifier(provider_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT provider_json, revision, updated_at FROM provider_profiles \
                 WHERE provider_id = ?1",
                [provider_id],
                |row| {
                    let document: String = row.get(0)?;
                    Ok((document, row.get(1)?, row.get(2)?))
                },
            )
            .optional()?
            .map(|(document, revision, updated_at)| {
                Ok(ProviderProfileRecord {
                    provider: serde_json::from_str(&document)?,
                    revision,
                    updated_at,
                })
            })
            .transpose()
    }

    pub fn put_provider_profile(
        &self,
        provider_id: &str,
        provider: &Value,
        expected_revision: Option<i64>,
        updated_at: &str,
    ) -> Result<ProviderProfileRecord, StorageError> {
        validate_identifier(provider_id)?;
        validate_object(provider, "provider profile must be a JSON object")?;
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(provider)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT revision FROM provider_profiles WHERE provider_id = ?1",
                [provider_id],
                |row| row.get(0),
            )
            .optional()?;
        require_expected_revision(current, expected_revision, "provider profile")?;
        let revision = current.unwrap_or_default() + 1;
        transaction.execute(
            "INSERT INTO provider_profiles (provider_id, provider_json, revision, updated_at) \
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(provider_id) DO UPDATE SET \
             provider_json = excluded.provider_json, revision = excluded.revision, \
             updated_at = excluded.updated_at",
            params![provider_id, document, revision, updated_at],
        )?;
        transaction.commit()?;
        Ok(ProviderProfileRecord {
            provider: provider.clone(),
            revision,
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn configuration_profiles(&self) -> Result<Vec<ConfigurationProfileRecord>, StorageError> {
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT profile_json, revision, builtin, updated_at FROM configuration_profiles \
             ORDER BY builtin DESC, profile_id ASC LIMIT 100",
        )?;
        let rows = statement.query_map([], |row| {
            let document: String = row.get(0)?;
            Ok((
                document,
                row.get(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get(3)?,
            ))
        })?;
        rows.map(|row| {
            let (document, revision, builtin, updated_at) = row?;
            Ok(ConfigurationProfileRecord {
                profile: serde_json::from_str(&document)?,
                revision,
                builtin,
                updated_at,
            })
        })
        .collect()
    }

    pub fn configuration_profile(
        &self,
        profile_id: &str,
    ) -> Result<Option<ConfigurationProfileRecord>, StorageError> {
        validate_identifier(profile_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT profile_json, revision, builtin, updated_at FROM configuration_profiles \
                 WHERE profile_id = ?1",
                [profile_id],
                |row| {
                    let document: String = row.get(0)?;
                    Ok((
                        document,
                        row.get(1)?,
                        row.get::<_, i64>(2)? != 0,
                        row.get(3)?,
                    ))
                },
            )
            .optional()?
            .map(|(document, revision, builtin, updated_at)| {
                Ok(ConfigurationProfileRecord {
                    profile: serde_json::from_str(&document)?,
                    revision,
                    builtin,
                    updated_at,
                })
            })
            .transpose()
    }

    pub fn put_configuration_profile(
        &self,
        profile_id: &str,
        profile: &Value,
        expected_revision: Option<i64>,
        builtin: bool,
        updated_at: &str,
    ) -> Result<ConfigurationProfileRecord, StorageError> {
        validate_identifier(profile_id)?;
        validate_object(profile, "configuration profile must be a JSON object")?;
        validate_timestamp(updated_at)?;
        let document = serde_json::to_string(profile)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<(i64, bool)> = transaction
            .query_row(
                "SELECT revision, builtin FROM configuration_profiles WHERE profile_id = ?1",
                [profile_id],
                |row| Ok((row.get(0)?, row.get::<_, i64>(1)? != 0)),
            )
            .optional()?;
        require_expected_revision(
            current.map(|(revision, _)| revision),
            expected_revision,
            "configuration profile",
        )?;
        if current.is_some_and(|(_, existing_builtin)| existing_builtin) && !builtin {
            return Err(StorageError::Conflict("builtin profile cannot be demoted"));
        }
        let revision = current.map_or(1, |(revision, _)| revision + 1);
        transaction.execute(
            "INSERT INTO configuration_profiles \
             (profile_id, profile_json, revision, builtin, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(profile_id) DO UPDATE SET profile_json = excluded.profile_json, \
             revision = excluded.revision, builtin = excluded.builtin, updated_at = excluded.updated_at",
            params![profile_id, document, revision, i64::from(builtin), updated_at],
        )?;
        transaction.commit()?;
        Ok(ConfigurationProfileRecord {
            profile: profile.clone(),
            revision,
            builtin,
            updated_at: updated_at.to_owned(),
        })
    }

    pub fn prompt_revisions(
        &self,
        prompt_id: &str,
    ) -> Result<Vec<PromptRevisionRecord>, StorageError> {
        validate_identifier(prompt_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT revision.prompt_json, revision.content_hash, \
             CASE WHEN active.version = revision.version THEN 1 ELSE 0 END, revision.created_at \
             FROM prompt_revisions AS revision LEFT JOIN active_prompts AS active \
             ON active.prompt_id = revision.prompt_id WHERE revision.prompt_id = ?1 \
             ORDER BY revision.version DESC LIMIT 100",
        )?;
        let rows = statement.query_map([prompt_id], |row| {
            let document: String = row.get(0)?;
            Ok((
                document,
                row.get(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get(3)?,
            ))
        })?;
        rows.map(|row| {
            let (document, content_hash, active, created_at) = row?;
            Ok(PromptRevisionRecord {
                prompt: serde_json::from_str(&document)?,
                content_hash,
                active,
                created_at,
            })
        })
        .collect()
    }

    pub fn append_prompt_revision(
        &self,
        prompt_id: &str,
        version: i64,
        prompt: &Value,
        content_hash: &str,
        expected_revision: Option<i64>,
        created_at: &str,
    ) -> Result<PromptRevisionRecord, StorageError> {
        validate_identifier(prompt_id)?;
        if version < 1
            || content_hash.len() != 64
            || !content_hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(StorageError::Invalid("prompt revision metadata is invalid"));
        }
        validate_object(prompt, "prompt revision must be a JSON object")?;
        validate_timestamp(created_at)?;
        let document = serde_json::to_string(prompt)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction.query_row(
            "SELECT MAX(version) FROM prompt_revisions WHERE prompt_id = ?1",
            [prompt_id],
            |row| row.get(0),
        )?;
        require_expected_revision(current, expected_revision, "prompt")?;
        if version != current.unwrap_or_default() + 1 {
            return Err(StorageError::Conflict(
                "prompt revision is not the next version",
            ));
        }
        transaction.execute(
            "INSERT INTO prompt_revisions \
             (prompt_id, version, prompt_json, content_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![prompt_id, version, document, content_hash, created_at],
        )?;
        transaction.commit()?;
        Ok(PromptRevisionRecord {
            prompt: prompt.clone(),
            content_hash: content_hash.to_owned(),
            active: false,
            created_at: created_at.to_owned(),
        })
    }

    pub fn activate_prompt(
        &self,
        prompt_id: &str,
        version: i64,
        expected_active: Option<i64>,
        activated_at: &str,
    ) -> Result<PromptRevisionRecord, StorageError> {
        validate_identifier(prompt_id)?;
        if version < 1 {
            return Err(StorageError::Invalid("prompt revision is invalid"));
        }
        validate_timestamp(activated_at)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current: Option<i64> = transaction
            .query_row(
                "SELECT version FROM active_prompts WHERE prompt_id = ?1",
                [prompt_id],
                |row| row.get(0),
            )
            .optional()?;
        require_expected_revision(current, expected_active, "active prompt")?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM prompt_revisions WHERE prompt_id = ?1 AND version = ?2)",
            params![prompt_id, version],
            |row| row.get(0),
        )?;
        if !exists {
            return Err(StorageError::Invalid("prompt revision does not exist"));
        }
        transaction.execute(
            "INSERT INTO active_prompts (prompt_id, version, activated_at) VALUES (?1, ?2, ?3) \
             ON CONFLICT(prompt_id) DO UPDATE SET version = excluded.version, \
             activated_at = excluded.activated_at",
            params![prompt_id, version, activated_at],
        )?;
        transaction.commit()?;
        drop(connection);
        self.prompt_revisions(prompt_id)?
            .into_iter()
            .find(|record| record.active)
            .ok_or(StorageError::Invalid("active prompt is unavailable"))
    }

    pub fn create_session(&self, session: NewSession<'_>) -> Result<SessionRecord, StorageError> {
        validate_identifier(session.session_id)?;
        validate_text(session.title, 240)?;
        validate_identifier(session.profile_id)?;
        if let Some(locale) = session.locale {
            validate_text(locale, 32)?;
        }
        validate_timestamp(session.occurred_at)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection.execute(
            "INSERT INTO sessions \
             (session_id, title, profile_id, status, version, locale, created_at, updated_at, archived_at) \
             VALUES (?1, ?2, ?3, 'active', 1, ?4, ?5, ?5, NULL)",
            params![
                session.session_id,
                session.title,
                session.profile_id,
                session.locale,
                session.occurred_at
            ],
        )?;
        Ok(SessionRecord {
            session_id: session.session_id.to_owned(),
            title: session.title.to_owned(),
            profile_id: session.profile_id.to_owned(),
            status: "active".to_owned(),
            version: 1,
            locale: session.locale.map(str::to_owned),
            created_at: session.occurred_at.to_owned(),
            updated_at: session.occurred_at.to_owned(),
            archived_at: None,
        })
    }

    pub fn session(&self, session_id: &str) -> Result<Option<SessionRecord>, StorageError> {
        validate_identifier(session_id)?;
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        connection
            .query_row(
                "SELECT session_id, title, profile_id, status, version, locale, created_at, \
                 updated_at, archived_at FROM sessions WHERE session_id = ?1",
                [session_id],
                session_from_row,
            )
            .optional()
            .map_err(StorageError::from)
    }

    pub fn sessions_page(
        &self,
        cursor: Option<&SessionCursor>,
        limit: usize,
        include_archived: bool,
    ) -> Result<SessionPage, StorageError> {
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("session page bounds are invalid"));
        }
        if let Some(cursor) = cursor {
            validate_timestamp(&cursor.updated_at)?;
            validate_identifier(&cursor.session_id)?;
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT session_id, title, profile_id, status, version, locale, created_at, \
             updated_at, archived_at FROM sessions \
             WHERE (?1 = 1 OR status = 'active') \
               AND (?2 IS NULL OR updated_at < ?2 OR (updated_at = ?2 AND session_id < ?3)) \
             ORDER BY updated_at DESC, session_id DESC LIMIT ?4",
        )?;
        let (cursor_time, cursor_id) = cursor
            .map(|cursor| {
                (
                    Some(cursor.updated_at.as_str()),
                    Some(cursor.session_id.as_str()),
                )
            })
            .unwrap_or((None, None));
        let rows = statement.query_map(
            params![
                i64::from(include_archived),
                cursor_time,
                cursor_id,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            session_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next = has_more.then(|| {
            let last = items.last().expect("non-empty bounded page");
            SessionCursor {
                updated_at: last.updated_at.clone(),
                session_id: last.session_id.clone(),
            }
        });
        Ok(SessionPage { items, next })
    }

    pub fn archive_session(
        &self,
        session_id: &str,
        expected_version: i64,
        updated_at: &str,
    ) -> Result<SessionRecord, StorageError> {
        validate_identifier(session_id)?;
        validate_timestamp(updated_at)?;
        if expected_version < 1 {
            return Err(StorageError::Invalid("session version is invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let changed = connection.execute(
            "UPDATE sessions SET status = 'archived', version = version + 1, \
             updated_at = ?3, archived_at = ?3 WHERE session_id = ?1 AND version = ?2",
            params![session_id, expected_version, updated_at],
        )?;
        if changed != 1 {
            return Err(StorageError::Conflict("session changed since it was read"));
        }
        drop(connection);
        self.session(session_id)?
            .ok_or(StorageError::Invalid("session does not exist"))
    }

    pub fn delete_session(
        &self,
        session_id: &str,
        expected_version: i64,
    ) -> Result<(), StorageError> {
        validate_identifier(session_id)?;
        if expected_version < 1 {
            return Err(StorageError::Invalid("session version is invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let deleted = connection.execute(
            "DELETE FROM sessions WHERE session_id = ?1 AND version = ?2",
            params![session_id, expected_version],
        )?;
        if deleted != 1 {
            return Err(StorageError::Conflict("session changed since it was read"));
        }
        Ok(())
    }

    pub fn append_session_message(
        &self,
        message: NewSessionMessage<'_>,
    ) -> Result<StoredSessionMessage, StorageError> {
        validate_identifier(message.message_id)?;
        validate_identifier(message.session_id)?;
        if !matches!(message.role, "user" | "assistant" | "system") {
            return Err(StorageError::Invalid("session message role is invalid"));
        }
        validate_text(message.content, 1_000_000)?;
        validate_object(message.context, "message context must be a JSON object")?;
        validate_text(message.data_class, 32)?;
        validate_timestamp(message.occurred_at)?;
        let context = serde_json::to_string(message.context)?;
        let mut connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let status: Option<String> = transaction
            .query_row(
                "SELECT status FROM sessions WHERE session_id = ?1",
                [message.session_id],
                |row| row.get(0),
            )
            .optional()?;
        match status.as_deref() {
            Some("active") => {}
            Some(_) => return Err(StorageError::Conflict("session is archived")),
            None => return Err(StorageError::Invalid("session does not exist")),
        }
        let sequence: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM session_messages WHERE session_id = ?1",
            [message.session_id],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO session_messages \
             (message_id, session_id, sequence, role, content, context_json, data_class, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                message.message_id,
                message.session_id,
                sequence,
                message.role,
                message.content,
                context,
                message.data_class,
                message.occurred_at,
            ],
        )?;
        transaction.execute(
            "UPDATE sessions SET updated_at = MAX(updated_at, ?2) WHERE session_id = ?1",
            params![message.session_id, message.occurred_at],
        )?;
        transaction.commit()?;
        Ok(StoredSessionMessage {
            message_id: message.message_id.to_owned(),
            session_id: message.session_id.to_owned(),
            sequence,
            role: message.role.to_owned(),
            content: message.content.to_owned(),
            context: message.context.clone(),
            data_class: message.data_class.to_owned(),
            created_at: message.occurred_at.to_owned(),
        })
    }

    pub fn session_messages_page(
        &self,
        session_id: &str,
        after: i64,
        limit: usize,
    ) -> Result<MessagePage, StorageError> {
        validate_identifier(session_id)?;
        if after < 0 || !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("message page bounds are invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT message_id, session_id, sequence, role, content, context_json, data_class, \
             created_at FROM session_messages WHERE session_id = ?1 AND sequence > ?2 \
             ORDER BY sequence ASC LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                after,
                i64::try_from(limit + 1).expect("bounded limit")
            ],
            message_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        let has_more = items.len() > limit;
        items.truncate(limit);
        let next_after = has_more.then(|| items.last().expect("non-empty bounded page").sequence);
        Ok(MessagePage { items, next_after })
    }

    pub fn recent_session_messages(
        &self,
        session_id: &str,
        limit: usize,
    ) -> Result<Vec<StoredSessionMessage>, StorageError> {
        validate_identifier(session_id)?;
        if !(1..=64).contains(&limit) {
            return Err(StorageError::Invalid("message context bounds are invalid"));
        }
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT message_id, session_id, sequence, role, content, context_json, data_class, \
             created_at FROM session_messages WHERE session_id = ?1 \
             ORDER BY sequence DESC LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![session_id, i64::try_from(limit).expect("bounded limit")],
            message_from_row,
        )?;
        let mut items = rows.collect::<Result<Vec<_>, _>>()?;
        items.reverse();
        Ok(items)
    }

    pub fn search_session_messages(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<SessionSearchHit>, StorageError> {
        validate_text(query, 256)?;
        if !(1..=100).contains(&limit) {
            return Err(StorageError::Invalid("search page bounds are invalid"));
        }
        let literal = format!("\"{}\"", query.replace('"', "\"\""));
        let connection = self.connection.lock().map_err(|_| StorageError::Poisoned)?;
        let mut statement = connection.prepare(
            "SELECT message.session_id, message.message_id, message.sequence, \
             snippet(session_messages_fts, 0, '', '', ' … ', 24) \
             FROM session_messages_fts \
             JOIN session_messages AS message ON message.rowid = session_messages_fts.rowid \
             WHERE session_messages_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?;
        let rows = statement.query_map(
            params![literal, i64::try_from(limit).expect("bounded limit")],
            |row| {
                Ok(SessionSearchHit {
                    session_id: row.get(0)?,
                    message_id: row.get(1)?,
                    sequence: row.get(2)?,
                    excerpt: row.get(3)?,
                })
            },
        )?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }
}

fn require_expected_revision(
    current: Option<i64>,
    expected: Option<i64>,
    subject: &'static str,
) -> Result<(), StorageError> {
    match (current, expected) {
        (None, None) => Ok(()),
        (Some(current), Some(expected)) if current == expected => Ok(()),
        _ => Err(StorageError::Conflict(match subject {
            "provider profile" => "provider profile changed since it was read",
            "configuration profile" => "configuration profile changed since it was read",
            "prompt" => "prompt changed since it was read",
            "active prompt" => "active prompt changed since it was read",
            _ => "record changed since it was read",
        })),
    }
}

fn session_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        session_id: row.get(0)?,
        title: row.get(1)?,
        profile_id: row.get(2)?,
        status: row.get(3)?,
        version: row.get(4)?,
        locale: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        archived_at: row.get(8)?,
    })
}

fn message_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredSessionMessage> {
    let document: String = row.get(5)?;
    let context = serde_json::from_str(&document).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            document.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(StoredSessionMessage {
        message_id: row.get(0)?,
        session_id: row.get(1)?,
        sequence: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        context,
        data_class: row.get(6)?,
        created_at: row.get(7)?,
    })
}
