use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;

use crate::{Sha256Digest, validation::validate_plain_text};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EvidenceError {
    SourceRequired,
    InvalidSourceGrant,
    DuplicateSource,
    EvidenceRequired,
    InvalidEvidence,
    DuplicateEvidence,
    InvalidTimestamp,
    OutsideWindow,
    FuturePublication,
    FutureRetrieval,
    RetrievalBeforePublication,
    SourceNotGranted,
    SourceUrlNotGranted,
}

impl std::fmt::Display for EvidenceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::SourceRequired => "at least one source grant is required",
            Self::InvalidSourceGrant => "source grant must identify an HTTPS origin and path",
            Self::DuplicateSource => "source grant identifier is duplicated",
            Self::EvidenceRequired => "at least one evidence record is required",
            Self::InvalidEvidence => "evidence metadata is invalid",
            Self::DuplicateEvidence => "evidence identifier is duplicated",
            Self::InvalidTimestamp => "evidence timestamp is invalid",
            Self::OutsideWindow => "evidence was published outside the last 30 days",
            Self::FuturePublication => "evidence publication time is in the future",
            Self::FutureRetrieval => "evidence retrieval time is in the future",
            Self::RetrievalBeforePublication => "evidence was retrieved before publication",
            Self::SourceNotGranted => "evidence source is not granted",
            Self::SourceUrlNotGranted => "evidence URL is outside the granted source",
        })
    }
}

impl std::error::Error for EvidenceError {}

/// One reviewed source-specific network boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceGrant {
    source_id: String,
    base_url: Url,
}

impl SourceGrant {
    pub fn new(source_id: impl Into<String>, base_url: &str) -> Result<Self, EvidenceError> {
        let source_id = source_id.into();
        crate::validation::validate_identifier(&source_id)
            .map_err(|_| EvidenceError::InvalidSourceGrant)?;
        let parsed = Url::parse(base_url).map_err(|_| EvidenceError::InvalidSourceGrant)?;
        if parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(EvidenceError::InvalidSourceGrant);
        }
        Ok(Self {
            source_id,
            base_url: parsed,
        })
    }

    #[must_use]
    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        self.base_url.as_str()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Last30DaysEvidence {
    pub evidence_id: String,
    pub source_id: String,
    pub source_url: String,
    pub title: String,
    pub published_at: String,
    pub retrieved_at: String,
    pub content_hash: Sha256Digest,
}

pub struct Last30DaysValidator {
    now: OffsetDateTime,
    grants: BTreeMap<String, SourceGrant>,
}

impl Last30DaysValidator {
    pub fn new(now: OffsetDateTime, grants: Vec<SourceGrant>) -> Result<Self, EvidenceError> {
        if grants.is_empty() {
            return Err(EvidenceError::SourceRequired);
        }
        let mut selected = BTreeMap::new();
        for grant in grants {
            if selected.insert(grant.source_id.clone(), grant).is_some() {
                return Err(EvidenceError::DuplicateSource);
            }
        }
        Ok(Self {
            now,
            grants: selected,
        })
    }

    pub fn validate(
        &self,
        evidence: &[Last30DaysEvidence],
    ) -> Result<ValidatedEvidenceSet, EvidenceError> {
        if evidence.is_empty() {
            return Err(EvidenceError::EvidenceRequired);
        }
        let mut evidence_ids = BTreeSet::new();
        let earliest = self.now - Duration::days(30);
        for item in evidence {
            crate::validation::validate_identifier(&item.evidence_id)
                .map_err(|_| EvidenceError::InvalidEvidence)?;
            if !evidence_ids.insert(item.evidence_id.clone()) {
                return Err(EvidenceError::DuplicateEvidence);
            }
            if !validate_plain_text(&item.title, 1024) {
                return Err(EvidenceError::InvalidEvidence);
            }
            let published = OffsetDateTime::parse(&item.published_at, &Rfc3339)
                .map_err(|_| EvidenceError::InvalidTimestamp)?;
            let retrieved = OffsetDateTime::parse(&item.retrieved_at, &Rfc3339)
                .map_err(|_| EvidenceError::InvalidTimestamp)?;
            if published > self.now {
                return Err(EvidenceError::FuturePublication);
            }
            if published < earliest {
                return Err(EvidenceError::OutsideWindow);
            }
            if retrieved > self.now {
                return Err(EvidenceError::FutureRetrieval);
            }
            if retrieved < published {
                return Err(EvidenceError::RetrievalBeforePublication);
            }
            let grant = self
                .grants
                .get(&item.source_id)
                .ok_or(EvidenceError::SourceNotGranted)?;
            if !url_is_within_grant(&item.source_url, grant) {
                return Err(EvidenceError::SourceUrlNotGranted);
            }
        }
        Ok(ValidatedEvidenceSet {
            evidence: evidence.to_vec(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedEvidenceSet {
    evidence: Vec<Last30DaysEvidence>,
}

impl ValidatedEvidenceSet {
    #[must_use]
    pub fn len(&self) -> usize {
        self.evidence.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.evidence.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Last30DaysEvidence> {
        self.evidence.iter()
    }
}

fn url_is_within_grant(value: &str, grant: &SourceGrant) -> bool {
    let Ok(candidate) = Url::parse(value) else {
        return false;
    };
    if candidate.scheme() != "https"
        || candidate.scheme() != grant.base_url.scheme()
        || candidate.host_str() != grant.base_url.host_str()
        || candidate.port_or_known_default() != grant.base_url.port_or_known_default()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
        || candidate.fragment().is_some()
    {
        return false;
    }
    let base = grant.base_url.path();
    candidate.path() == base
        || candidate.path().strip_prefix(base).is_some_and(|suffix| {
            base.ends_with('/') || suffix.is_empty() || suffix.starts_with('/')
        })
}
