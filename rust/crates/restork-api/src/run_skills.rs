//! Bind imported skills to a run without inventing a new prompt layer.

use std::collections::BTreeSet;

use axum::{http::StatusCode, response::Response};
use restork_extension::SkillManifest;
use restork_storage::{Database, ExtensionRecord, StorageError};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    error::{error_response, error_response_owned},
    storage_error_response,
};

pub(crate) const MAX_SKILL_IDS_PER_RUN: usize = 8;
const MAX_SYSTEM_PROMPT_BYTES: usize = 64_000;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct FrozenSkill {
    pub skill_id: String,
    pub manifest_hash: String,
    pub name: String,
    #[serde(skip)]
    pub instructions: Option<String>,
}

pub(crate) struct PreparedRunSkills {
    pub skills: Vec<FrozenSkill>,
    pub prompt_hash: String,
}

pub(crate) fn prepare_run(
    storage: &Database,
    mode: &str,
    skill_ids: &[String],
) -> Result<PreparedRunSkills, Response> {
    let skills = resolve(storage, skill_ids)?;
    let prompt = compose_prompt(mode, &skills)?;
    Ok(PreparedRunSkills {
        prompt_hash: hex_sha256(prompt.as_bytes()),
        skills,
    })
}

pub(crate) fn prepare_deliverable_guidance(
    storage: &Database,
    skill_id: Option<&str>,
) -> Result<Option<FrozenSkill>, Response> {
    let Some(skill_id) = skill_id.filter(|value| !value.trim().is_empty()) else {
        return Ok(None);
    };
    let mut skills = resolve(storage, &[skill_id.to_owned()])?;
    Ok(skills.pop())
}

pub(crate) fn audit_value(skills: &[FrozenSkill]) -> Value {
    json!(
        skills
            .iter()
            .map(|skill| json!({
                "skill_id": skill.skill_id,
                "manifest_hash": skill.manifest_hash,
                "name": skill.name,
            }))
            .collect::<Vec<_>>()
    )
}

pub(crate) fn prompt_for_stored_run(
    storage: &Database,
    run: &restork_storage::RunRecord,
) -> Result<String, Response> {
    let skill_ids = run
        .task_spec
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("skill_id")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect::<Vec<_>>();
    let hashes = run
        .task_spec
        .get("skills")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            Some((
                item.get("skill_id")?.as_str()?.to_owned(),
                item.get("manifest_hash")?.as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    if hashes.is_empty() && skill_ids.is_empty() {
        return Ok(crate::agent_system_prompt(&run.mode).to_owned());
    }
    let mut skills = Vec::new();
    for (skill_id, manifest_hash) in hashes {
        match load_revision(storage, &skill_id, &manifest_hash) {
            Ok(Some(skill)) => skills.push(skill),
            Ok(None) => {
                return Err(error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "frozen skill revision is missing",
                ));
            }
            Err(error) => return Err(storage_error_response(error)),
        }
    }
    compose_prompt(&run.mode, &skills)
}

fn resolve(storage: &Database, skill_ids: &[String]) -> Result<Vec<FrozenSkill>, Response> {
    if skill_ids.len() > MAX_SKILL_IDS_PER_RUN {
        return Err(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "a run can attach at most 8 skills",
        ));
    }
    let unique = skill_ids.iter().cloned().collect::<BTreeSet<_>>();
    if unique.len() != skill_ids.len() {
        return Err(error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "skill_ids must be unique",
        ));
    }
    let mut frozen = Vec::new();
    for skill_id in skill_ids {
        if skill_id.is_empty() || skill_id.len() > 160 {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "skill id is invalid",
            ));
        }
        if let Some(manifest) = crate::bundled_skills::skill(skill_id) {
            frozen.push(FrozenSkill {
                skill_id: manifest.id.clone(),
                manifest_hash: crate::bundled_skills::manifest_hash(),
                name: manifest
                    .display_name
                    .clone()
                    .unwrap_or_else(|| manifest.id.clone()),
                instructions: manifest.instructions.clone(),
            });
            continue;
        }
        let record = match storage.extension(skill_id) {
            Ok(Some(record)) => record,
            Ok(None) => {
                return Err(error_response(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "unknown skill id",
                ));
            }
            Err(error) => return Err(storage_error_response(error)),
        };
        if record.package_kind != "skill" {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "skill id does not refer to a skill package",
            ));
        }
        if record.state != "enabled" {
            return Err(error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "skill is not enabled",
            ));
        }
        frozen.push(frozen_from_record(&record)?);
    }
    Ok(frozen)
}

fn frozen_from_record(record: &ExtensionRecord) -> Result<FrozenSkill, Response> {
    let manifest = serde_json::from_value::<SkillManifest>(record.manifest.clone()).ok();
    let name = manifest
        .as_ref()
        .and_then(|item| item.display_name.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| record.package_id.clone());
    Ok(FrozenSkill {
        skill_id: record.package_id.clone(),
        manifest_hash: record.manifest_hash.clone(),
        name,
        instructions: manifest.and_then(|item| item.instructions),
    })
}

fn load_revision(
    storage: &Database,
    skill_id: &str,
    manifest_hash: &str,
) -> Result<Option<FrozenSkill>, StorageError> {
    if let Some(manifest) = crate::bundled_skills::skill(skill_id) {
        if crate::bundled_skills::manifest_hash() != manifest_hash {
            return Ok(None);
        }
        return Ok(Some(FrozenSkill {
            skill_id: manifest.id.clone(),
            manifest_hash: manifest_hash.to_owned(),
            name: manifest
                .display_name
                .clone()
                .unwrap_or_else(|| manifest.id.clone()),
            instructions: manifest.instructions.clone(),
        }));
    }
    if let Some(current) = storage.extension(skill_id)?
        && current.manifest_hash == manifest_hash
    {
        return Ok(frozen_from_record(&current).ok());
    }
    Ok(storage
        .extension_revisions(skill_id, 100)?
        .into_iter()
        .find(|revision| revision.manifest_hash == manifest_hash)
        .and_then(|revision| {
            frozen_from_record(&ExtensionRecord {
                package_id: revision.package_id,
                package_kind: revision.package_kind,
                manifest: revision.manifest,
                manifest_hash: revision.manifest_hash,
                state: revision.state,
                installed_at: revision.installed_at,
                updated_at: revision.updated_at,
            })
            .ok()
        }))
}

fn compose_prompt(mode: &str, skills: &[FrozenSkill]) -> Result<String, Response> {
    let mut prompt = crate::agent_system_prompt(mode).to_owned();
    for skill in skills {
        let Some(instructions) = skill.instructions.as_deref().map(str::trim) else {
            continue;
        };
        if instructions.is_empty() {
            continue;
        }
        let header = format!("\n\n## Imported skill: {}\n", skill.name);
        if prompt.len() + header.len() + instructions.len() > MAX_SYSTEM_PROMPT_BYTES {
            return Err(error_response_owned(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!(
                    "imported skill {} exceeds the run prompt budget",
                    skill.skill_id
                ),
            ));
        }
        prompt.push_str(&header);
        prompt.push_str(instructions);
    }
    Ok(prompt)
}

fn hex_sha256(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(64);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}
