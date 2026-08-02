use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{
    conversation::RunProposal,
    error::{ContractError, ContractResult},
    profile::{ConfigurationProfile, DataClass, Mode},
    prompt::PromptManifest,
    provider::ProviderProfile,
    validation::{hash_parts, normalize_id, normalize_many, normalize_text, validate_hash},
};

/// Immutable version and digest reference used by frozen manifests.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
pub struct VersionedHashRef {
    id: String,
    version: String,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct VersionedHashRefWire {
    id: String,
    version: String,
    content_hash: String,
}

impl VersionedHashRef {
    pub fn try_new(id: &str, version: &str, content_hash: &str) -> ContractResult<Self> {
        Ok(Self {
            id: normalize_id(id, "manifest_ref.id")?,
            version: normalize_id(version, "manifest_ref.version")?,
            content_hash: validate_hash(content_hash, "manifest_ref.content_hash")?,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }

    fn fragment(&self) -> String {
        format!("{}:{}:{}", self.id, self.version, self.content_hash)
    }
}

impl<'de> Deserialize<'de> for VersionedHashRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = VersionedHashRefWire::deserialize(deserializer)?;
        Self::try_new(&wire.id, &wire.version, &wire.content_hash).map_err(serde::de::Error::custom)
    }
}

/// Policy identity recorded independently of editable prompt layers.
pub type PolicyRef = VersionedHashRef;

/// Exact selected source identity and content digest.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SourceBinding {
    reference: String,
    content_hash: String,
    data_class: DataClass,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceBindingWire {
    reference: String,
    content_hash: String,
    data_class: DataClass,
}

impl SourceBinding {
    pub fn try_new(
        reference: &str,
        content_hash: &str,
        data_class: DataClass,
    ) -> ContractResult<Self> {
        Ok(Self {
            reference: normalize_id(reference, "source.reference")?,
            content_hash: validate_hash(content_hash, "source.content_hash")?,
            data_class,
        })
    }

    #[must_use]
    pub fn reference(&self) -> &str {
        &self.reference
    }

    #[must_use]
    pub const fn data_class(&self) -> DataClass {
        self.data_class
    }

    fn fragment(&self) -> String {
        format!(
            "{}:{}:{:?}",
            self.reference, self.content_hash, self.data_class
        )
    }
}

impl<'de> Deserialize<'de> for SourceBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = SourceBindingWire::deserialize(deserializer)?;
        Self::try_new(&wire.reference, &wire.content_hash, wire.data_class)
            .map_err(serde::de::Error::custom)
    }
}

/// Hard limits included in the immutable run manifest.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct BudgetLimits {
    max_model_turns: u32,
    max_tool_calls: u32,
    max_retries: u32,
    max_tokens: u64,
    max_wall_time_ms: u64,
    max_output_bytes: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BudgetLimitsWire {
    max_model_turns: u32,
    max_tool_calls: u32,
    max_retries: u32,
    max_tokens: u64,
    max_wall_time_ms: u64,
    max_output_bytes: u64,
}

impl BudgetLimits {
    pub fn try_new(
        max_model_turns: u32,
        max_tool_calls: u32,
        max_retries: u32,
        max_tokens: u64,
        max_wall_time_ms: u64,
        max_output_bytes: u64,
    ) -> ContractResult<Self> {
        if max_model_turns == 0 || max_tokens == 0 || max_wall_time_ms == 0 || max_output_bytes == 0
        {
            return Err(ContractError::new(
                "budget",
                "model, token, wall-time, and output limits must be positive",
            ));
        }
        Ok(Self {
            max_model_turns,
            max_tool_calls,
            max_retries,
            max_tokens,
            max_wall_time_ms,
            max_output_bytes,
        })
    }

    #[must_use]
    pub fn content_hash(self) -> String {
        let values = [
            self.max_model_turns.to_string(),
            self.max_tool_calls.to_string(),
            self.max_retries.to_string(),
            self.max_tokens.to_string(),
            self.max_wall_time_ms.to_string(),
            self.max_output_bytes.to_string(),
        ];
        hash_parts(values.iter().map(String::as_str))
    }
}

impl<'de> Deserialize<'de> for BudgetLimits {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = BudgetLimitsWire::deserialize(deserializer)?;
        Self::try_new(
            wire.max_model_turns,
            wire.max_tool_calls,
            wire.max_retries,
            wire.max_tokens,
            wire.max_wall_time_ms,
            wire.max_output_bytes,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// Complete immutable authority and provenance envelope for a confirmed Run.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct FrozenRunManifestV2 {
    schema_version: u32,
    run_id: String,
    proposal_id: String,
    session_id: String,
    mode: Mode,
    data_class: DataClass,
    profile: VersionedHashRef,
    provider: VersionedHashRef,
    model: String,
    prompt_manifest: VersionedHashRef,
    skills: Vec<VersionedHashRef>,
    skill_manifest_hash: String,
    allowed_tools: BTreeSet<String>,
    tool_manifest_hash: String,
    sources: Vec<SourceBinding>,
    source_manifest_hash: String,
    budget: BudgetLimits,
    budget_manifest_hash: String,
    policy: PolicyRef,
    memory_namespace: String,
    #[serde(with = "time::serde::rfc3339")]
    frozen_at: OffsetDateTime,
    content_hash: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrozenRunManifestV2Wire {
    schema_version: u32,
    run_id: String,
    proposal_id: String,
    session_id: String,
    mode: Mode,
    data_class: DataClass,
    profile: VersionedHashRef,
    provider: VersionedHashRef,
    model: String,
    prompt_manifest: VersionedHashRef,
    skills: Vec<VersionedHashRef>,
    skill_manifest_hash: String,
    allowed_tools: Vec<String>,
    tool_manifest_hash: String,
    sources: Vec<SourceBinding>,
    source_manifest_hash: String,
    budget: BudgetLimits,
    budget_manifest_hash: String,
    policy: PolicyRef,
    memory_namespace: String,
    #[serde(with = "time::serde::rfc3339")]
    frozen_at: OffsetDateTime,
    content_hash: String,
}

impl FrozenRunManifestV2 {
    #[allow(clippy::too_many_arguments)]
    pub fn freeze<I, S, J, T, K>(
        run_id: &str,
        proposal: &RunProposal,
        profile: &ConfigurationProfile,
        provider: &ProviderProfile,
        prompt_manifest: &PromptManifest,
        skills: I,
        core_allowed_tools: J,
        skill_requested_tools: K,
        budget: BudgetLimits,
        policy: PolicyRef,
        frozen_at: OffsetDateTime,
    ) -> ContractResult<Self>
    where
        I: IntoIterator<Item = VersionedHashRef>,
        J: IntoIterator<Item = S>,
        S: AsRef<str>,
        K: IntoIterator<Item = T>,
        T: AsRef<str>,
    {
        let run_id = normalize_id(run_id, "run_manifest.run_id")?;
        if proposal.profile_id() != profile.profile_id() {
            return Err(ContractError::new(
                "run_manifest.profile",
                "proposal and profile identities differ",
            ));
        }
        if provider.profile_id() != profile.provider_profile_id() {
            return Err(ContractError::new(
                "run_manifest.provider",
                "provider does not match the selected profile",
            ));
        }
        if prompt_manifest.content_hash() != profile.prompt_manifest_hash() {
            return Err(ContractError::new(
                "run_manifest.prompt_manifest",
                "prompt manifest does not match the selected profile",
            ));
        }
        profile.permits_data_class(proposal.requested_data_class())?;
        if proposal
            .sources()
            .iter()
            .any(|source| source.data_class() > proposal.requested_data_class())
        {
            return Err(ContractError::new(
                "run_manifest.sources",
                "a source exceeds the proposed data class",
            ));
        }

        let mut skills = skills.into_iter().collect::<Vec<_>>();
        skills.sort();
        if skills.windows(2).any(|pair| pair[0].id() == pair[1].id())
            || skills
                .iter()
                .any(|skill| !profile.enabled_skill_ids().contains(skill.id()))
        {
            return Err(ContractError::new(
                "run_manifest.skills",
                "skills must be unique and enabled by the profile",
            ));
        }
        let core_allowed_tools =
            normalize_many(core_allowed_tools, "run_manifest.core_allowed_tools", 256)?;
        let skill_requested_tools = normalize_many(
            skill_requested_tools,
            "run_manifest.skill_requested_tools",
            256,
        )?;
        let allowed_tools = proposal
            .requested_tools()
            .intersection(profile.allowed_tools())
            .filter(|tool| core_allowed_tools.contains(*tool))
            .filter(|tool| skill_requested_tools.contains(*tool))
            .cloned()
            .collect::<BTreeSet<_>>();

        let profile_ref = VersionedHashRef::try_new(
            profile.profile_id(),
            &profile.version().to_string(),
            &profile.content_hash(),
        )?;
        let provider_ref = VersionedHashRef::try_new(
            provider.profile_id(),
            &provider.version().to_string(),
            &provider.content_hash(),
        )?;
        let prompt_ref = VersionedHashRef::try_new(
            prompt_manifest.manifest_id(),
            &prompt_manifest.version().to_string(),
            prompt_manifest.content_hash(),
        )?;
        let skill_manifest_hash = hash_parts(skills.iter().map(VersionedHashRef::fragment));
        let tool_manifest_hash = hash_parts(allowed_tools.iter().map(String::as_str));
        let sources = proposal.sources().to_vec();
        let source_manifest_hash = hash_parts(sources.iter().map(SourceBinding::fragment));
        let budget_manifest_hash = budget.content_hash();
        let mut manifest = Self {
            schema_version: 2,
            run_id,
            proposal_id: proposal.proposal_id().to_owned(),
            session_id: proposal.session_id().to_owned(),
            mode: proposal.mode(),
            data_class: proposal.requested_data_class(),
            profile: profile_ref,
            provider: provider_ref,
            model: provider.model().to_owned(),
            prompt_manifest: prompt_ref,
            skills,
            skill_manifest_hash,
            allowed_tools,
            tool_manifest_hash,
            sources,
            source_manifest_hash,
            budget,
            budget_manifest_hash,
            policy,
            memory_namespace: profile.memory_namespace().to_owned(),
            frozen_at,
            content_hash: String::new(),
        };
        manifest.content_hash = manifest.recompute_content_hash();
        Ok(manifest)
    }

    fn from_wire(wire: FrozenRunManifestV2Wire) -> ContractResult<Self> {
        let FrozenRunManifestV2Wire {
            schema_version,
            run_id,
            proposal_id,
            session_id,
            mode,
            data_class,
            profile,
            provider,
            model,
            prompt_manifest,
            skills,
            skill_manifest_hash,
            allowed_tools: serialized_allowed_tools,
            tool_manifest_hash,
            sources,
            source_manifest_hash,
            budget,
            budget_manifest_hash,
            policy,
            memory_namespace,
            frozen_at,
            content_hash,
        } = wire;

        if schema_version != 2 {
            return Err(ContractError::new(
                "run_manifest.schema_version",
                "must be version 2",
            ));
        }
        if skills.len() > 128
            || skills.windows(2).any(|pair| pair[0] >= pair[1])
            || skills.windows(2).any(|pair| pair[0].id() == pair[1].id())
        {
            return Err(ContractError::new(
                "run_manifest.skills",
                "must be a sorted unique bounded skill list",
            ));
        }

        let allowed_tools = normalize_many(
            serialized_allowed_tools.iter(),
            "run_manifest.allowed_tools",
            256,
        )?;
        if serialized_allowed_tools != allowed_tools.iter().cloned().collect::<Vec<_>>() {
            return Err(ContractError::new(
                "run_manifest.allowed_tools",
                "must be sorted and canonical",
            ));
        }
        if sources.len() > 128
            || sources
                .windows(2)
                .any(|pair| pair[0].reference() >= pair[1].reference())
            || sources
                .iter()
                .any(|source| source.data_class() > data_class)
        {
            return Err(ContractError::new(
                "run_manifest.sources",
                "must be sorted, unique, bounded, and within the run data class",
            ));
        }

        let calculated_skill_hash = hash_parts(skills.iter().map(VersionedHashRef::fragment));
        verify_component_hash(
            &skill_manifest_hash,
            &calculated_skill_hash,
            "run_manifest.skill_manifest_hash",
        )?;
        let calculated_tool_hash = hash_parts(allowed_tools.iter().map(String::as_str));
        verify_component_hash(
            &tool_manifest_hash,
            &calculated_tool_hash,
            "run_manifest.tool_manifest_hash",
        )?;
        let calculated_source_hash = hash_parts(sources.iter().map(SourceBinding::fragment));
        verify_component_hash(
            &source_manifest_hash,
            &calculated_source_hash,
            "run_manifest.source_manifest_hash",
        )?;
        let calculated_budget_hash = budget.content_hash();
        verify_component_hash(
            &budget_manifest_hash,
            &calculated_budget_hash,
            "run_manifest.budget_manifest_hash",
        )?;

        let mut manifest = Self {
            schema_version,
            run_id: normalize_id(&run_id, "run_manifest.run_id")?,
            proposal_id: normalize_id(&proposal_id, "run_manifest.proposal_id")?,
            session_id: normalize_id(&session_id, "run_manifest.session_id")?,
            mode,
            data_class,
            profile,
            provider,
            model: normalize_text(&model, "run_manifest.model", 256)?,
            prompt_manifest,
            skills,
            skill_manifest_hash: calculated_skill_hash,
            allowed_tools,
            tool_manifest_hash: calculated_tool_hash,
            sources,
            source_manifest_hash: calculated_source_hash,
            budget,
            budget_manifest_hash: calculated_budget_hash,
            policy,
            memory_namespace: normalize_id(&memory_namespace, "run_manifest.memory_namespace")?,
            frozen_at,
            content_hash: String::new(),
        };
        let calculated_content_hash = manifest.recompute_content_hash();
        verify_component_hash(
            &content_hash,
            &calculated_content_hash,
            "run_manifest.content_hash",
        )?;
        manifest.content_hash = calculated_content_hash;
        Ok(manifest)
    }

    fn recompute_content_hash(&self) -> String {
        let schema_version = self.schema_version.to_string();
        let mode = format!("{:?}", self.mode);
        let data_class = format!("{:?}", self.data_class);
        let profile = self.profile.fragment();
        let provider = self.provider.fragment();
        let prompt_manifest = self.prompt_manifest.fragment();
        let policy = self.policy.fragment();
        let frozen_at = self.frozen_at.to_string();
        hash_parts([
            schema_version.as_str(),
            self.run_id.as_str(),
            self.proposal_id.as_str(),
            self.session_id.as_str(),
            mode.as_str(),
            data_class.as_str(),
            profile.as_str(),
            provider.as_str(),
            self.model.as_str(),
            prompt_manifest.as_str(),
            self.skill_manifest_hash.as_str(),
            self.tool_manifest_hash.as_str(),
            self.source_manifest_hash.as_str(),
            self.budget_manifest_hash.as_str(),
            policy.as_str(),
            self.memory_namespace.as_str(),
            frozen_at.as_str(),
        ])
    }

    #[must_use]
    pub const fn profile(&self) -> &VersionedHashRef {
        &self.profile
    }

    #[must_use]
    pub const fn provider(&self) -> &VersionedHashRef {
        &self.provider
    }

    #[must_use]
    pub const fn prompt_manifest(&self) -> &VersionedHashRef {
        &self.prompt_manifest
    }

    #[must_use]
    pub fn skill_manifest_hash(&self) -> &str {
        &self.skill_manifest_hash
    }

    #[must_use]
    pub fn allowed_tools(&self) -> &BTreeSet<String> {
        &self.allowed_tools
    }

    #[must_use]
    pub fn tool_manifest_hash(&self) -> &str {
        &self.tool_manifest_hash
    }

    #[must_use]
    pub fn source_manifest_hash(&self) -> &str {
        &self.source_manifest_hash
    }

    #[must_use]
    pub fn budget_manifest_hash(&self) -> &str {
        &self.budget_manifest_hash
    }

    #[must_use]
    pub const fn policy(&self) -> &PolicyRef {
        &self.policy
    }

    #[must_use]
    pub fn content_hash(&self) -> &str {
        &self.content_hash
    }
}

impl<'de> Deserialize<'de> for FrozenRunManifestV2 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::from_wire(FrozenRunManifestV2Wire::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

fn verify_component_hash(
    supplied: &str,
    calculated: &str,
    field: &'static str,
) -> ContractResult<()> {
    validate_hash(supplied, field)?;
    if supplied != calculated {
        return Err(ContractError::new(
            field,
            "does not match the frozen manifest contents",
        ));
    }
    Ok(())
}
