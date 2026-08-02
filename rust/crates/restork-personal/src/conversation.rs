use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{
    error::{ContractError, ContractResult},
    manifest::SourceBinding,
    profile::{DataClass, Mode},
    validation::{normalize_id, normalize_many, normalize_text, validate_version},
};

/// User-visible lifecycle of a global conversation session.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    Active,
    Archived,
}

/// A global conversation container that does not require a pre-existing Run.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ConversationSession {
    session_id: String,
    title: String,
    profile_id: String,
    status: ConversationStatus,
    version: u64,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConversationSessionWire {
    session_id: String,
    title: String,
    profile_id: String,
    status: ConversationStatus,
    version: u64,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    updated_at: OffsetDateTime,
}

impl ConversationSession {
    pub fn try_new(
        session_id: &str,
        title: &str,
        profile_id: &str,
        created_at: OffsetDateTime,
    ) -> ContractResult<Self> {
        Ok(Self {
            session_id: normalize_id(session_id, "conversation.session_id")?,
            title: normalize_text(title, "conversation.title", 240)?,
            profile_id: normalize_id(profile_id, "conversation.profile_id")?,
            status: ConversationStatus::Active,
            version: 1,
            created_at,
            updated_at: created_at,
        })
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    #[must_use]
    pub const fn status(&self) -> ConversationStatus {
        self.status
    }

    pub fn archive(&self, updated_at: OffsetDateTime) -> ContractResult<Self> {
        if updated_at < self.updated_at {
            return Err(ContractError::new(
                "conversation.updated_at",
                "cannot move backwards",
            ));
        }
        let mut archived = self.clone();
        archived.status = ConversationStatus::Archived;
        archived.version = archived
            .version
            .checked_add(1)
            .ok_or_else(|| ContractError::new("conversation.version", "overflowed"))?;
        archived.updated_at = updated_at;
        Ok(archived)
    }

    fn from_wire(wire: ConversationSessionWire) -> ContractResult<Self> {
        validate_version(wire.version, "conversation.version")?;
        if wire.updated_at < wire.created_at {
            return Err(ContractError::new(
                "conversation.updated_at",
                "cannot precede creation",
            ));
        }
        Ok(Self {
            session_id: normalize_id(&wire.session_id, "conversation.session_id")?,
            title: normalize_text(&wire.title, "conversation.title", 240)?,
            profile_id: normalize_id(&wire.profile_id, "conversation.profile_id")?,
            status: wire.status,
            version: wire.version,
            created_at: wire.created_at,
            updated_at: wire.updated_at,
        })
    }
}

impl<'de> Deserialize<'de> for ConversationSession {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::from_wire(ConversationSessionWire::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

/// Immutable proof that intake performed no provider, network, file, or tool access.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct LocalIntakeBoundary {
    network_access: bool,
    file_access: bool,
    provider_access: bool,
    tool_access: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocalIntakeBoundaryWire {
    network_access: bool,
    file_access: bool,
    provider_access: bool,
    tool_access: bool,
}

impl LocalIntakeBoundary {
    const TOOL_FREE: Self = Self {
        network_access: false,
        file_access: false,
        provider_access: false,
        tool_access: false,
    };

    #[must_use]
    pub const fn network_access(self) -> bool {
        self.network_access
    }

    #[must_use]
    pub const fn file_access(self) -> bool {
        self.file_access
    }

    #[must_use]
    pub const fn provider_access(self) -> bool {
        self.provider_access
    }

    #[must_use]
    pub const fn tool_access(self) -> bool {
        self.tool_access
    }

    fn validate(self) -> ContractResult<()> {
        if self.network_access || self.file_access || self.provider_access || self.tool_access {
            return Err(ContractError::new(
                "proposal.intake_boundary",
                "local intake cannot claim ambient authority",
            ));
        }
        Ok(())
    }
}

impl<'de> Deserialize<'de> for LocalIntakeBoundary {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = LocalIntakeBoundaryWire::deserialize(deserializer)?;
        let boundary = Self {
            network_access: wire.network_access,
            file_access: wire.file_access,
            provider_access: wire.provider_access,
            tool_access: wire.tool_access,
        };
        boundary.validate().map_err(serde::de::Error::custom)?;
        Ok(boundary)
    }
}

/// A proposal remains inert until the user confirms it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    ReviewRequired,
}

/// A local, tool-free, reviewable precursor to a frozen Run.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RunProposal {
    proposal_id: String,
    session_id: String,
    profile_id: String,
    mode: Mode,
    goal: String,
    completion_criteria: Vec<String>,
    requested_data_class: DataClass,
    requested_tools: BTreeSet<String>,
    sources: Vec<SourceBinding>,
    intake_boundary: LocalIntakeBoundary,
    status: ProposalStatus,
    version: u64,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunProposalWire {
    proposal_id: String,
    session_id: String,
    profile_id: String,
    mode: Mode,
    goal: String,
    completion_criteria: Vec<String>,
    requested_data_class: DataClass,
    requested_tools: BTreeSet<String>,
    sources: Vec<SourceBinding>,
    intake_boundary: LocalIntakeBoundary,
    status: ProposalStatus,
    version: u64,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

impl RunProposal {
    pub fn from_local_intake(
        session: &ConversationSession,
        mode: Mode,
        goal: &str,
        requested_data_class: DataClass,
        created_at: OffsetDateTime,
    ) -> ContractResult<Self> {
        if session.status != ConversationStatus::Active {
            return Err(ContractError::new(
                "proposal.session_id",
                "cannot use an archived conversation",
            ));
        }
        Ok(Self {
            proposal_id: random_id("proposal")?,
            session_id: session.session_id.clone(),
            profile_id: session.profile_id.clone(),
            mode,
            goal: normalize_text(goal, "proposal.goal", 4_000)?,
            completion_criteria: vec!["produce a reviewable verified artifact".to_owned()],
            requested_data_class,
            requested_tools: BTreeSet::new(),
            sources: Vec::new(),
            intake_boundary: LocalIntakeBoundary::TOOL_FREE,
            status: ProposalStatus::ReviewRequired,
            version: 1,
            created_at,
        })
    }

    pub fn with_reviewed_tools<I, S>(mut self, tools: I) -> ContractResult<Self>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        self.requested_tools = normalize_many(tools, "proposal.requested_tools", 256)?;
        self.bump_version()?;
        Ok(self)
    }

    pub fn with_reviewed_sources<I>(mut self, sources: I) -> ContractResult<Self>
    where
        I: IntoIterator<Item = SourceBinding>,
    {
        let mut sources = sources.into_iter().collect::<Vec<_>>();
        if sources.len() > 128 {
            return Err(ContractError::new(
                "proposal.sources",
                "contains too many sources",
            ));
        }
        sources.sort_by(|left, right| left.reference().cmp(right.reference()));
        if sources
            .windows(2)
            .any(|pair| pair[0].reference() == pair[1].reference())
        {
            return Err(ContractError::new(
                "proposal.sources",
                "contains duplicate source references",
            ));
        }
        self.sources = sources;
        self.bump_version()?;
        Ok(self)
    }

    fn bump_version(&mut self) -> ContractResult<()> {
        self.version = self
            .version
            .checked_add(1)
            .ok_or_else(|| ContractError::new("proposal.version", "overflowed"))?;
        Ok(())
    }

    #[must_use]
    pub fn proposal_id(&self) -> &str {
        &self.proposal_id
    }

    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    #[must_use]
    pub const fn mode(&self) -> Mode {
        self.mode
    }

    #[must_use]
    pub const fn requested_data_class(&self) -> DataClass {
        self.requested_data_class
    }

    #[must_use]
    pub fn requested_tools(&self) -> &BTreeSet<String> {
        &self.requested_tools
    }

    #[must_use]
    pub fn sources(&self) -> &[SourceBinding] {
        &self.sources
    }

    #[must_use]
    pub const fn intake_boundary(&self) -> LocalIntakeBoundary {
        self.intake_boundary
    }

    fn from_wire(wire: RunProposalWire) -> ContractResult<Self> {
        wire.intake_boundary.validate()?;
        validate_version(wire.version, "proposal.version")?;
        let completion_criteria = wire
            .completion_criteria
            .into_iter()
            .map(|criterion| normalize_text(&criterion, "proposal.completion_criteria", 1_000))
            .collect::<ContractResult<Vec<_>>>()?;
        if completion_criteria.is_empty() || completion_criteria.len() > 32 {
            return Err(ContractError::new(
                "proposal.completion_criteria",
                "must contain between one and 32 criteria",
            ));
        }
        let proposal = Self {
            proposal_id: normalize_id(&wire.proposal_id, "proposal.proposal_id")?,
            session_id: normalize_id(&wire.session_id, "proposal.session_id")?,
            profile_id: normalize_id(&wire.profile_id, "proposal.profile_id")?,
            mode: wire.mode,
            goal: normalize_text(&wire.goal, "proposal.goal", 4_000)?,
            completion_criteria,
            requested_data_class: wire.requested_data_class,
            requested_tools: normalize_many(wire.requested_tools, "proposal.requested_tools", 256)?,
            sources: wire.sources,
            intake_boundary: wire.intake_boundary,
            status: wire.status,
            version: wire.version,
            created_at: wire.created_at,
        };
        if proposal.sources.len() > 128
            || proposal
                .sources
                .windows(2)
                .any(|pair| pair[0].reference() >= pair[1].reference())
        {
            return Err(ContractError::new(
                "proposal.sources",
                "must be a sorted unique bounded source list",
            ));
        }
        Ok(proposal)
    }
}

impl<'de> Deserialize<'de> for RunProposal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::from_wire(RunProposalWire::deserialize(deserializer)?)
            .map_err(serde::de::Error::custom)
    }
}

fn random_id(prefix: &str) -> ContractResult<String> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| ContractError::new("proposal.proposal_id", "secure entropy is unavailable"))?;
    let suffix = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}-{suffix}"))
}
