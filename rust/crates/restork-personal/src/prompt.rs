use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{
    error::{ContractError, ContractResult},
    validation::{content_hash, hash_parts, normalize_id, validate_hash, validate_version},
};

/// Immutable prompt layers in their authority order.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptLayer {
    Policy,
    Skill,
    Personal,
    RunContext,
}

/// One versioned prompt revision. Prompt text carries no capabilities.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PromptRevision {
    prompt_id: String,
    revision: u64,
    layer: PromptLayer,
    content: String,
    content_hash: String,
    parent_hash: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptRevisionWire {
    prompt_id: String,
    revision: u64,
    layer: PromptLayer,
    content: String,
    content_hash: String,
    parent_hash: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

impl PromptRevision {
    pub fn try_new(
        prompt_id: &str,
        revision: u64,
        layer: PromptLayer,
        content: &str,
        parent_hash: Option<&str>,
        created_at: OffsetDateTime,
    ) -> ContractResult<Self> {
        if content.len() > 64_000 || content.contains('\0') {
            return Err(ContractError::new(
                "prompt.content",
                "is outside the prompt size boundary",
            ));
        }
        if matches!(layer, PromptLayer::Policy | PromptLayer::Skill) && content.trim().is_empty() {
            return Err(ContractError::new(
                "prompt.content",
                "policy and Skill prompt layers cannot be empty",
            ));
        }
        Ok(Self {
            prompt_id: normalize_id(prompt_id, "prompt_id")?,
            revision: validate_version(revision, "prompt.revision")?,
            layer,
            content: content.to_owned(),
            content_hash: content_hash(content.as_bytes()),
            parent_hash: parent_hash
                .map(|value| validate_hash(value, "prompt.parent_hash"))
                .transpose()?,
            created_at,
        })
    }

    #[must_use]
    pub fn prompt_id(&self) -> &str {
        &self.prompt_id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub const fn layer(&self) -> PromptLayer {
        self.layer
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    #[must_use]
    pub fn content(&self) -> &str {
        &self.content
    }
}

impl<'de> Deserialize<'de> for PromptRevision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = PromptRevisionWire::deserialize(deserializer)?;
        let revision = Self::try_new(
            &wire.prompt_id,
            wire.revision,
            wire.layer,
            &wire.content,
            wire.parent_hash.as_deref(),
            wire.created_at,
        )
        .map_err(serde::de::Error::custom)?;
        if revision.content_hash != wire.content_hash {
            return Err(serde::de::Error::custom(ContractError::new(
                "prompt.content_hash",
                "does not match the prompt content",
            )));
        }
        Ok(revision)
    }
}

/// Content-free reference stored in a frozen prompt manifest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PromptRef {
    prompt_id: String,
    revision: u64,
    layer: PromptLayer,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptRefWire {
    prompt_id: String,
    revision: u64,
    layer: PromptLayer,
    content_hash: String,
}

impl PromptRef {
    fn from_revision(revision: &PromptRevision) -> Self {
        Self {
            prompt_id: revision.prompt_id.clone(),
            revision: revision.revision,
            layer: revision.layer,
            content_hash: revision.content_hash.clone(),
        }
    }

    fn try_from_wire(wire: PromptRefWire) -> ContractResult<Self> {
        Ok(Self {
            prompt_id: normalize_id(&wire.prompt_id, "prompt_ref.prompt_id")?,
            revision: validate_version(wire.revision, "prompt_ref.revision")?,
            layer: wire.layer,
            content_hash: validate_hash(&wire.content_hash, "prompt_ref.content_hash")?,
        })
    }

    #[must_use]
    pub const fn layer(&self) -> PromptLayer {
        self.layer
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    fn hash_fragment(&self) -> String {
        format!(
            "{}:{}:{:?}:{}",
            self.prompt_id, self.revision, self.layer, self.content_hash
        )
    }
}

impl<'de> Deserialize<'de> for PromptRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::try_from_wire(PromptRefWire::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

/// Exactly four frozen prompt references, with no prompt bodies or authority.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PromptManifest {
    manifest_id: String,
    version: u64,
    policy: PromptRef,
    skill: PromptRef,
    personal: PromptRef,
    run_context: PromptRef,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PromptManifestWire {
    manifest_id: String,
    version: u64,
    policy: PromptRef,
    skill: PromptRef,
    personal: PromptRef,
    run_context: PromptRef,
    content_hash: String,
}

impl PromptManifest {
    pub fn freeze(
        manifest_id: &str,
        version: u64,
        policy: &PromptRevision,
        skill: &PromptRevision,
        personal: &PromptRevision,
        run_context: &PromptRevision,
    ) -> ContractResult<Self> {
        Self::from_refs(
            manifest_id,
            version,
            PromptRef::from_revision(policy),
            PromptRef::from_revision(skill),
            PromptRef::from_revision(personal),
            PromptRef::from_revision(run_context),
            None,
        )
    }

    fn from_refs(
        manifest_id: &str,
        version: u64,
        policy: PromptRef,
        skill: PromptRef,
        personal: PromptRef,
        run_context: PromptRef,
        expected_hash: Option<&str>,
    ) -> ContractResult<Self> {
        let manifest_id = normalize_id(manifest_id, "prompt_manifest.manifest_id")?;
        let version = validate_version(version, "prompt_manifest.version")?;
        if policy.layer != PromptLayer::Policy
            || skill.layer != PromptLayer::Skill
            || personal.layer != PromptLayer::Personal
            || run_context.layer != PromptLayer::RunContext
        {
            return Err(ContractError::new(
                "prompt_manifest.layers",
                "must contain policy, Skill, personal, and run-context layers in order",
            ));
        }
        let identities = [
            policy.prompt_id.as_str(),
            skill.prompt_id.as_str(),
            personal.prompt_id.as_str(),
            run_context.prompt_id.as_str(),
        ]
        .into_iter()
        .collect::<BTreeSet<_>>();
        if identities.len() != 4 {
            return Err(ContractError::new(
                "prompt_manifest.layers",
                "each layer must reference a distinct prompt identity",
            ));
        }
        let version_text = version.to_string();
        let fragments = [
            policy.hash_fragment(),
            skill.hash_fragment(),
            personal.hash_fragment(),
            run_context.hash_fragment(),
        ];
        let digest = hash_parts(
            [manifest_id.as_str(), version_text.as_str()]
                .into_iter()
                .chain(fragments.iter().map(String::as_str)),
        );
        if expected_hash.is_some_and(|expected| expected != digest) {
            return Err(ContractError::new(
                "prompt_manifest.content_hash",
                "does not match the four frozen layers",
            ));
        }
        Ok(Self {
            manifest_id,
            version,
            policy,
            skill,
            personal,
            run_context,
            content_hash: digest,
        })
    }

    #[must_use]
    pub fn manifest_id(&self) -> &str {
        &self.manifest_id
    }

    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    #[must_use]
    pub const fn policy(&self) -> &PromptRef {
        &self.policy
    }

    #[must_use]
    pub const fn skill(&self) -> &PromptRef {
        &self.skill
    }

    #[must_use]
    pub const fn personal(&self) -> &PromptRef {
        &self.personal
    }

    #[must_use]
    pub const fn run_context(&self) -> &PromptRef {
        &self.run_context
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }
}

impl<'de> Deserialize<'de> for PromptManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = PromptManifestWire::deserialize(deserializer)?;
        Self::from_refs(
            &wire.manifest_id,
            wire.version,
            wire.policy,
            wire.skill,
            wire.personal,
            wire.run_context,
            Some(&wire.content_hash),
        )
        .map_err(serde::de::Error::custom)
    }
}
