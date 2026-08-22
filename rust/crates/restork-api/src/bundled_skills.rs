//! First-party skills shipped with Core.
//!
//! They appear in the same Dashboard catalog as imported skills, but remain
//! immutable and require no installation write. Runs still freeze their exact
//! manifest hash so a completed task stays auditable after an app update.

use std::sync::OnceLock;

use restork_extension::SkillManifest;
use restork_storage::ExtensionRecord;
use serde_json::Value;
use sha2::{Digest, Sha256};

const LAST_30_DAYS_MANIFEST: &str = include_str!("../resources/bundled-skills/last-30-days.json");
const LAST_30_DAYS_INSTRUCTIONS: &str = include_str!("../resources/bundled-skills/last-30-days.md");
const LAST_30_DAYS_ID: &str = "skill.last-30-days";

fn last_30_days() -> &'static SkillManifest {
    static MANIFEST: OnceLock<SkillManifest> = OnceLock::new();
    MANIFEST.get_or_init(|| {
        let mut value = serde_json::from_str::<Value>(LAST_30_DAYS_MANIFEST)
            .expect("bundled Last 30 Days manifest must be JSON");
        value["instructions"] = Value::String(LAST_30_DAYS_INSTRUCTIONS.to_owned());
        let manifest = serde_json::from_value::<SkillManifest>(value)
            .expect("bundled Last 30 Days manifest must match the skill schema");
        manifest
            .validate()
            .expect("bundled Last 30 Days manifest must be valid");
        manifest
    })
}

pub(crate) fn skill(skill_id: &str) -> Option<&'static SkillManifest> {
    (skill_id == LAST_30_DAYS_ID).then(last_30_days)
}

pub(crate) fn manifest_hash() -> String {
    let bytes =
        serde_json::to_vec(last_30_days()).expect("bundled Last 30 Days manifest must serialize");
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn catalog_record() -> ExtensionRecord {
    ExtensionRecord {
        package_id: LAST_30_DAYS_ID.to_owned(),
        package_kind: "skill".to_owned(),
        manifest: serde_json::to_value(last_30_days())
            .expect("bundled Last 30 Days manifest must serialize"),
        manifest_hash: manifest_hash(),
        state: "enabled".to_owned(),
        installed_at: "2026-08-21T00:00:00Z".to_owned(),
        updated_at: "2026-08-21T00:00:00Z".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_last_30_days_is_valid_and_has_a_stable_fingerprint() {
        let manifest = last_30_days();
        assert_eq!(manifest.id, LAST_30_DAYS_ID);
        assert_eq!(manifest.default_mode.as_deref(), Some("research"));
        assert!(
            manifest
                .instructions
                .as_deref()
                .is_some_and(|text| text.contains("rolling window"))
        );
        assert_eq!(manifest_hash().len(), 64);
    }
}
