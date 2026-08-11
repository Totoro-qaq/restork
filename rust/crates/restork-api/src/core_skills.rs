use std::sync::OnceLock;

use serde::Deserialize;

const REPORTS_MANIFEST: &str = include_str!("../resources/core-skills/core.reports.json");
const PRESENTATION_MANIFEST: &str = include_str!("../resources/core-skills/core.presentation.json");

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct CoreSkillManifest {
    pub(crate) schema_version: u64,
    pub(crate) skill_id: String,
    pub(crate) version: u64,
    pub(crate) prompt_version: String,
    pub(crate) bundled: bool,
    pub(crate) user_runtime_dependencies: Vec<String>,
    pub(crate) capabilities: Vec<String>,
    pub(crate) output_formats: Vec<String>,
    #[serde(default)]
    pub(crate) themes: Vec<String>,
}

fn manifests() -> &'static [CoreSkillManifest; 2] {
    static MANIFESTS: OnceLock<[CoreSkillManifest; 2]> = OnceLock::new();
    MANIFESTS.get_or_init(|| {
        [
            serde_json::from_str(REPORTS_MANIFEST)
                .expect("bundled report Core Skill manifest must be valid"),
            serde_json::from_str(PRESENTATION_MANIFEST)
                .expect("bundled presentation Core Skill manifest must be valid"),
        ]
    })
}

pub(crate) fn core_skill(skill_id: &str) -> Option<&'static CoreSkillManifest> {
    manifests()
        .iter()
        .find(|manifest| manifest.skill_id == skill_id)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn built_in_report_and_presentation_skills_require_no_user_runtime() {
        let manifests = manifests();
        assert_eq!(manifests.len(), 2);
        for manifest in manifests {
            assert_eq!(manifest.schema_version, 1);
            assert_eq!(manifest.version, 1);
            assert!(manifest.bundled);
            assert!(manifest.user_runtime_dependencies.is_empty());
            assert!(!manifest.capabilities.is_empty());
            assert!(!manifest.output_formats.is_empty());
        }
    }

    #[test]
    fn presentation_skill_pins_all_six_built_in_themes() {
        let presentation = core_skill("core.presentation").expect("presentation manifest");
        let themes = presentation.themes.iter().collect::<BTreeSet<_>>();
        assert_eq!(themes.len(), 6);
        assert_eq!(presentation.output_formats, ["pptx", "pdf"]);
        assert_eq!(presentation.prompt_version, "presentation-v1");
    }
}
