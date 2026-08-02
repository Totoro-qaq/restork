use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::{
    DeliverableError, Result,
    hash::{canonical_hash, domain_hash},
    safety::{validate_hash, validate_id, validate_nonempty_text},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Period {
    start: OffsetDateTime,
    end_exclusive: OffsetDateTime,
    timezone: String,
}

impl Period {
    pub fn new(
        start: OffsetDateTime,
        end_exclusive: OffsetDateTime,
        timezone: impl Into<String>,
    ) -> Result<Self> {
        if start >= end_exclusive {
            return Err(DeliverableError::InvalidPeriod);
        }
        let timezone = timezone.into();
        validate_timezone(&timezone)?;
        Ok(Self {
            start,
            end_exclusive,
            timezone,
        })
    }

    #[must_use]
    pub const fn start(&self) -> OffsetDateTime {
        self.start
    }

    #[must_use]
    pub const fn end_exclusive(&self) -> OffsetDateTime {
        self.end_exclusive
    }

    #[must_use]
    pub fn timezone(&self) -> &str {
        &self.timezone
    }

    #[must_use]
    pub fn duration(&self) -> Duration {
        self.end_exclusive - self.start
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceSourceKind {
    RunEvent,
    ValidatedArtifact,
    TaskObservation,
    VaultNote,
    CalendarInterval,
    GitSummary,
    UserAssertion,
    Conversation,
    Memory,
}

impl EvidenceSourceKind {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RunEvent => "run_event",
            Self::ValidatedArtifact => "validated_artifact",
            Self::TaskObservation => "task_observation",
            Self::VaultNote => "vault_note",
            Self::CalendarInterval => "calendar_interval",
            Self::GitSummary => "git_summary",
            Self::UserAssertion => "user_assertion",
            Self::Conversation => "conversation",
            Self::Memory => "memory",
        }
    }

    #[must_use]
    pub const fn can_ground(self) -> bool {
        !matches!(self, Self::Conversation | Self::Memory)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    Verified,
    Observed,
    SelfAsserted,
    Unverified,
    Stale,
    Contradicted,
}

impl VerificationState {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Verified => "verified",
            Self::Observed => "observed",
            Self::SelfAsserted => "self-asserted",
            Self::Unverified => "unverified",
            Self::Stale => "stale",
            Self::Contradicted => "contradicted",
        }
    }

    #[must_use]
    pub const fn is_publishable(self) -> bool {
        !matches!(self, Self::Stale | Self::Contradicted)
    }

    const fn risk_rank(self) -> u8 {
        match self {
            Self::Verified => 0,
            Self::Observed => 1,
            Self::SelfAsserted => 2,
            Self::Unverified => 3,
            Self::Stale => 4,
            Self::Contradicted => 5,
        }
    }

    pub(crate) fn weakest(states: impl IntoIterator<Item = Self>) -> Option<Self> {
        states.into_iter().max_by_key(|state| state.risk_rank())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceSource {
    source_id: String,
    kind: EvidenceSourceKind,
    locator: String,
    content_hash: String,
    observed_at: Option<OffsetDateTime>,
    verification: VerificationState,
}

impl EvidenceSource {
    pub fn verified(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        if !matches!(
            kind,
            EvidenceSourceKind::RunEvent
                | EvidenceSourceKind::ValidatedArtifact
                | EvidenceSourceKind::TaskObservation
        ) {
            return Err(DeliverableError::InvalidSourceVerification {
                source_kind: kind.as_str(),
                requested: VerificationState::Verified.as_str(),
            });
        }
        Self::new(
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            VerificationState::Verified,
        )
    }

    pub fn observed(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        if !matches!(
            kind,
            EvidenceSourceKind::TaskObservation
                | EvidenceSourceKind::VaultNote
                | EvidenceSourceKind::CalendarInterval
                | EvidenceSourceKind::GitSummary
        ) {
            return Err(DeliverableError::InvalidSourceVerification {
                source_kind: kind.as_str(),
                requested: VerificationState::Observed.as_str(),
            });
        }
        Self::new(
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            VerificationState::Observed,
        )
    }

    pub fn self_asserted(
        source_id: impl Into<String>,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        Self::new(
            source_id,
            EvidenceSourceKind::UserAssertion,
            locator,
            content_hash,
            observed_at,
            VerificationState::SelfAsserted,
        )
    }

    pub fn unverified(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        Self::new(
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            VerificationState::Unverified,
        )
    }

    pub fn stale(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        Self::new(
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            VerificationState::Stale,
        )
    }

    pub fn contradicted(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
    ) -> Result<Self> {
        Self::new(
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            VerificationState::Contradicted,
        )
    }

    fn new(
        source_id: impl Into<String>,
        kind: EvidenceSourceKind,
        locator: impl Into<String>,
        content_hash: impl Into<String>,
        observed_at: Option<OffsetDateTime>,
        verification: VerificationState,
    ) -> Result<Self> {
        let source_id = source_id.into();
        validate_id("source_id", &source_id)?;
        let locator = locator.into();
        validate_nonempty_text("locator", &locator)?;
        let content_hash = content_hash.into();
        validate_hash("content_hash", &content_hash)?;
        Ok(Self {
            source_id,
            kind,
            locator,
            content_hash,
            observed_at,
            verification,
        })
    }

    #[must_use]
    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    #[must_use]
    pub const fn kind(&self) -> EvidenceSourceKind {
        self.kind
    }

    #[must_use]
    pub const fn verification(&self) -> VerificationState {
        self.verification
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FactKind {
    Completion,
    Progress,
    Decision,
    Blocker,
    Metric,
    Plan,
    Meeting,
    Note,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FactDraft {
    fact_id: String,
    kind: FactKind,
    statement: String,
    source_refs: Vec<String>,
}

impl FactDraft {
    pub fn new<I, S>(
        fact_id: impl Into<String>,
        kind: FactKind,
        statement: impl Into<String>,
        source_refs: I,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let fact_id = fact_id.into();
        validate_id("fact_id", &fact_id)?;
        let statement = statement.into();
        validate_nonempty_text("statement", &statement)?;
        let source_refs = collect_unique_ids("source_ref", source_refs)?;
        if source_refs.is_empty() {
            return Err(DeliverableError::EmptyField("source_refs"));
        }
        Ok(Self {
            fact_id,
            kind,
            statement,
            source_refs,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct FactCard {
    fact_id: String,
    kind: FactKind,
    statement: String,
    source_refs: Vec<String>,
    verification: VerificationState,
}

impl FactCard {
    #[must_use]
    pub fn fact_id(&self) -> &str {
        &self.fact_id
    }

    #[must_use]
    pub fn statement(&self) -> &str {
        &self.statement
    }

    #[must_use]
    pub fn source_refs(&self) -> &[String] {
        &self.source_refs
    }

    #[must_use]
    pub const fn verification(&self) -> VerificationState {
        self.verification
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EvidenceLedger {
    period: Period,
    sources: BTreeMap<String, EvidenceSource>,
    facts: BTreeMap<String, FactCard>,
    ledger_hash: String,
}

impl EvidenceLedger {
    pub fn build<S, F>(period: Period, sources: S, facts: F) -> Result<Self>
    where
        S: IntoIterator<Item = EvidenceSource>,
        F: IntoIterator<Item = FactDraft>,
    {
        let mut source_map = BTreeMap::new();
        for source in sources {
            let id = source.source_id.clone();
            if source_map.insert(id.clone(), source).is_some() {
                return Err(DeliverableError::DuplicateId { kind: "source", id });
            }
        }

        let mut fact_map = BTreeMap::new();
        for draft in facts {
            validate_id("fact_id", &draft.fact_id)?;
            validate_nonempty_text("statement", &draft.statement)?;
            validate_id_slice("source_ref", &draft.source_refs, true)?;
            if fact_map.contains_key(&draft.fact_id) {
                return Err(DeliverableError::DuplicateId {
                    kind: "fact",
                    id: draft.fact_id,
                });
            }

            let mut states = Vec::with_capacity(draft.source_refs.len());
            for source_id in &draft.source_refs {
                let source = source_map
                    .get(source_id)
                    .ok_or_else(|| DeliverableError::UnknownSource(source_id.clone()))?;
                if !source.kind.can_ground() {
                    return Err(DeliverableError::ForbiddenGroundingSource {
                        fact_id: draft.fact_id.clone(),
                        source_id: source_id.clone(),
                        source_kind: source.kind.as_str(),
                    });
                }
                states.push(source.verification);
            }
            let verification = VerificationState::weakest(states)
                .ok_or(DeliverableError::EmptyField("source_refs"))?;
            let fact_id = draft.fact_id.clone();
            fact_map.insert(
                fact_id,
                FactCard {
                    fact_id: draft.fact_id,
                    kind: draft.kind,
                    statement: draft.statement,
                    source_refs: draft.source_refs,
                    verification,
                },
            );
        }

        let canonical = canonical_hash(&(&period, &source_map, &fact_map))?;
        let ledger_hash = domain_hash("restork.evidence-ledger.v1", &[&canonical]);
        Ok(Self {
            period,
            sources: source_map,
            facts: fact_map,
            ledger_hash,
        })
    }

    #[must_use]
    pub const fn period(&self) -> &Period {
        &self.period
    }

    #[must_use]
    pub fn source(&self, source_id: &str) -> Option<&EvidenceSource> {
        self.sources.get(source_id)
    }

    #[must_use]
    pub fn fact(&self, fact_id: &str) -> Option<&FactCard> {
        self.facts.get(fact_id)
    }

    #[must_use]
    pub fn facts(&self) -> &BTreeMap<String, FactCard> {
        &self.facts
    }

    #[must_use]
    pub fn ledger_hash(&self) -> &str {
        &self.ledger_hash
    }

    pub(crate) fn resolve_fact_refs(
        &self,
        fact_refs: &[String],
    ) -> Result<(VerificationState, Vec<String>)> {
        if fact_refs.is_empty() {
            return Err(DeliverableError::EmptyField("fact_refs"));
        }
        let mut states = Vec::with_capacity(fact_refs.len());
        let mut citations = BTreeSet::new();
        for fact_id in fact_refs {
            let fact = self
                .facts
                .get(fact_id)
                .ok_or_else(|| DeliverableError::UnknownFact(fact_id.clone()))?;
            states.push(fact.verification);
            citations.extend(fact.source_refs.iter().cloned());
        }
        let state =
            VerificationState::weakest(states).ok_or(DeliverableError::EmptyField("fact_refs"))?;
        Ok((state, citations.into_iter().collect()))
    }
}

fn validate_timezone(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'-' | b'+'))
    {
        return Err(DeliverableError::InvalidIdentifier {
            field: "timezone",
            value: value.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn collect_unique_ids<I, S>(field: &'static str, values: I) -> Result<Vec<String>>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut unique = BTreeSet::new();
    for value in values {
        let value = value.into();
        validate_id(field, &value)?;
        if !unique.insert(value.clone()) {
            return Err(DeliverableError::DuplicateId {
                kind: field,
                id: value,
            });
        }
    }
    Ok(unique.into_iter().collect())
}

pub(crate) fn validate_id_slice(
    field: &'static str,
    values: &[String],
    required: bool,
) -> Result<()> {
    if required && values.is_empty() {
        return Err(DeliverableError::EmptyField(field));
    }
    let mut unique = BTreeSet::new();
    for value in values {
        validate_id(field, value)?;
        if !unique.insert(value) {
            return Err(DeliverableError::DuplicateId {
                kind: field,
                id: value.clone(),
            });
        }
    }
    Ok(())
}
