use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    error::{ContractError, ContractResult},
    validation::{
        hash_parts, normalize_id, normalize_many, normalize_text, validate_hash, validate_version,
    },
};

/// Maximum information classification permitted by a configuration profile.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DataClass {
    Public,
    Personal,
    Confidential,
}

/// Product mode selected for a proposed Run.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Research,
    Study,
    Work,
}

/// A named configuration boundary, not a separately autonomous employee.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ConfigurationProfile {
    profile_id: String,
    version: u64,
    name: String,
    provider_profile_id: String,
    prompt_manifest_hash: String,
    enabled_skill_ids: BTreeSet<String>,
    allowed_tools: BTreeSet<String>,
    memory_namespace: String,
    maximum_data_class: DataClass,
    include_display_name_in_prompt: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfigurationProfileWire {
    profile_id: String,
    version: u64,
    name: String,
    provider_profile_id: String,
    prompt_manifest_hash: String,
    enabled_skill_ids: BTreeSet<String>,
    allowed_tools: BTreeSet<String>,
    memory_namespace: String,
    maximum_data_class: DataClass,
    include_display_name_in_prompt: bool,
}

impl ConfigurationProfile {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new<I, S, J, T>(
        profile_id: &str,
        version: u64,
        name: &str,
        provider_profile_id: &str,
        prompt_manifest_hash: &str,
        enabled_skill_ids: I,
        allowed_tools: J,
        memory_namespace: &str,
        maximum_data_class: DataClass,
        include_display_name_in_prompt: bool,
    ) -> ContractResult<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
        J: IntoIterator<Item = T>,
        T: AsRef<str>,
    {
        Ok(Self {
            profile_id: normalize_id(profile_id, "profile_id")?,
            version: validate_version(version, "profile.version")?,
            name: normalize_text(name, "profile.name", 120)?,
            provider_profile_id: normalize_id(provider_profile_id, "provider_profile_id")?,
            prompt_manifest_hash: validate_hash(prompt_manifest_hash, "prompt_manifest_hash")?,
            enabled_skill_ids: normalize_many(enabled_skill_ids, "enabled_skill_ids", 128)?,
            allowed_tools: normalize_many(allowed_tools, "allowed_tools", 256)?,
            memory_namespace: normalize_id(memory_namespace, "memory_namespace")?,
            maximum_data_class,
            include_display_name_in_prompt,
        })
    }

    #[must_use]
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    #[must_use]
    pub fn provider_profile_id(&self) -> &str {
        &self.provider_profile_id
    }

    #[must_use]
    pub fn prompt_manifest_hash(&self) -> &str {
        &self.prompt_manifest_hash
    }

    #[must_use]
    pub const fn maximum_data_class(&self) -> DataClass {
        self.maximum_data_class
    }

    #[must_use]
    pub const fn include_display_name_in_prompt(&self) -> bool {
        self.include_display_name_in_prompt
    }

    #[must_use]
    pub fn enabled_skill_ids(&self) -> &BTreeSet<String> {
        &self.enabled_skill_ids
    }

    #[must_use]
    pub fn allowed_tools(&self) -> &BTreeSet<String> {
        &self.allowed_tools
    }

    #[must_use]
    pub fn memory_namespace(&self) -> &str {
        &self.memory_namespace
    }

    #[must_use]
    pub fn content_hash(&self) -> String {
        let version = self.version.to_string();
        let maximum_data_class = format!("{:?}", self.maximum_data_class);
        let include_name = self.include_display_name_in_prompt.to_string();
        hash_parts(
            [
                self.profile_id.as_str(),
                version.as_str(),
                self.name.as_str(),
                self.provider_profile_id.as_str(),
                self.prompt_manifest_hash.as_str(),
                self.memory_namespace.as_str(),
                maximum_data_class.as_str(),
                include_name.as_str(),
            ]
            .into_iter()
            .chain(self.enabled_skill_ids.iter().map(String::as_str))
            .chain(self.allowed_tools.iter().map(String::as_str)),
        )
    }

    pub fn permits_data_class(&self, requested: DataClass) -> ContractResult<()> {
        if requested > self.maximum_data_class {
            return Err(ContractError::new(
                "data_class",
                "exceeds the configuration profile",
            ));
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for ConfigurationProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ConfigurationProfileWire::deserialize(deserializer)?;
        Self::try_new(
            &wire.profile_id,
            wire.version,
            &wire.name,
            &wire.provider_profile_id,
            &wire.prompt_manifest_hash,
            wire.enabled_skill_ids,
            wire.allowed_tools,
            &wire.memory_namespace,
            wire.maximum_data_class,
            wire.include_display_name_in_prompt,
        )
        .map_err(serde::de::Error::custom)
    }
}
