use std::{error::Error, fmt};

pub type Result<T> = std::result::Result<T, DeliverableError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DeliverableError {
    EmptyField(&'static str),
    InvalidIdentifier {
        field: &'static str,
        value: String,
    },
    InvalidHash(&'static str),
    InvalidPeriod,
    InvalidRevision,
    InvalidSourceVerification {
        source_kind: &'static str,
        requested: &'static str,
    },
    DuplicateId {
        kind: &'static str,
        id: String,
    },
    UnknownSource(String),
    UnknownFact(String),
    UnknownClaim(String),
    UnknownAsset(String),
    ForbiddenGroundingSource {
        fact_id: String,
        source_id: String,
        source_kind: &'static str,
    },
    UnpublishableVerification {
        item_id: String,
        verification: &'static str,
    },
    InvalidReportPeriod,
    MissingClaims(String),
    UnsafeLocalReference(String),
    Serialization(String),
    EntropyUnavailable,
    UnsafeTemplate {
        reason: String,
    },
    ArchiveLimitExceeded {
        reason: String,
    },
    MissingArchivePart(&'static str),
    UnknownRelationshipTarget(String),
}

impl fmt::Display for DeliverableError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyField(field) => write!(formatter, "{field} must not be empty"),
            Self::InvalidIdentifier { field, value } => {
                write!(formatter, "{field} is not a valid identifier: {value}")
            }
            Self::InvalidHash(field) => {
                write!(formatter, "{field} must be a lowercase SHA-256 hash")
            }
            Self::InvalidPeriod => formatter.write_str("period start must be before period end"),
            Self::InvalidRevision => formatter.write_str("revision must be greater than zero"),
            Self::InvalidSourceVerification {
                source_kind,
                requested,
            } => write!(
                formatter,
                "source kind {source_kind} cannot assert {requested} verification"
            ),
            Self::DuplicateId { kind, id } => write!(formatter, "duplicate {kind} id: {id}"),
            Self::UnknownSource(id) => write!(formatter, "unknown evidence source: {id}"),
            Self::UnknownFact(id) => write!(formatter, "unknown fact: {id}"),
            Self::UnknownClaim(id) => write!(formatter, "unknown claim: {id}"),
            Self::UnknownAsset(id) => write!(formatter, "unknown asset: {id}"),
            Self::ForbiddenGroundingSource {
                fact_id,
                source_id,
                source_kind,
            } => write!(
                formatter,
                "fact {fact_id} cannot be grounded by {source_kind} source {source_id}"
            ),
            Self::UnpublishableVerification {
                item_id,
                verification,
            } => write!(
                formatter,
                "item {item_id} has unpublishable verification state {verification}"
            ),
            Self::InvalidReportPeriod => formatter.write_str("period does not match report kind"),
            Self::MissingClaims(id) => write!(formatter, "slide {id} requires at least one claim"),
            Self::UnsafeLocalReference(value) => {
                write!(formatter, "unsafe local reference: {value}")
            }
            Self::Serialization(message) => {
                write!(formatter, "canonical serialization failed: {message}")
            }
            Self::EntropyUnavailable => {
                formatter.write_str("secure random generation is unavailable")
            }
            Self::UnsafeTemplate { reason } => write!(formatter, "unsafe template: {reason}"),
            Self::ArchiveLimitExceeded { reason } => {
                write!(formatter, "template archive limit exceeded: {reason}")
            }
            Self::MissingArchivePart(part) => {
                write!(formatter, "template archive is missing {part}")
            }
            Self::UnknownRelationshipTarget(target) => {
                write!(
                    formatter,
                    "template relationship target is absent: {target}"
                )
            }
        }
    }
}

impl Error for DeliverableError {}
