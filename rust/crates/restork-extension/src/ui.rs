use serde::{Deserialize, Serialize};

use crate::{ExtensionError, validation::validate_identifier};

/// Restork-owned placement slots; extensions cannot supply render code.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UiLocation {
    ExtensionStatus,
    SettingsPanel,
    ArtifactBadge,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiAction {
    pub id: String,
    pub label_key: String,
    pub tool_id: Option<String>,
}

impl UiAction {
    fn validate(&self) -> Result<(), ExtensionError> {
        validate_identifier(&self.id).map_err(|_| ExtensionError::UnsafeUiContribution)?;
        validate_identifier(&self.label_key).map_err(|_| ExtensionError::UnsafeUiContribution)?;
        if let Some(tool_id) = &self.tool_id {
            validate_identifier(tool_id).map_err(|_| ExtensionError::UnsafeUiContribution)?;
        }
        Ok(())
    }
}

/// A code-free UI contribution expressed only through identifiers and Core actions.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UiContribution {
    pub id: String,
    pub location: UiLocation,
    pub title_key: String,
    pub description_key: String,
    #[serde(default)]
    pub actions: Vec<UiAction>,
}

impl UiContribution {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        for value in [&self.id, &self.title_key, &self.description_key] {
            validate_identifier(value).map_err(|_| ExtensionError::UnsafeUiContribution)?;
        }
        let mut action_ids = std::collections::BTreeSet::new();
        for action in &self.actions {
            action.validate()?;
            if !action_ids.insert(&action.id) {
                return Err(ExtensionError::DuplicateIdentifier(action.id.clone()));
            }
        }
        Ok(())
    }
}
