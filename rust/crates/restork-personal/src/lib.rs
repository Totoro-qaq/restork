//! Pure Step 13 and Step 14 personal-workspace domain contracts.
//!
//! This crate deliberately owns no storage, network, secret resolver, tool
//! executor, or operating-system permission. It validates the immutable values
//! those outer adapters may persist or execute.

mod conversation;
mod error;
mod manifest;
mod personal;
mod profile;
mod prompt;
mod provider;
mod validation;

pub use conversation::{
    ConversationSession, ConversationStatus, LocalIntakeBoundary, ProposalStatus, RunProposal,
};
pub use error::{ContractError, ContractResult};
pub use manifest::{BudgetLimits, FrozenRunManifestV2, PolicyRef, SourceBinding, VersionedHashRef};
pub use personal::{DailyContext, PersonalSettings, StartupPage, Theme, TimeBand, WeekStart};
pub use profile::{ConfigurationProfile, DataClass, Mode};
pub use prompt::{PromptLayer, PromptManifest, PromptRef, PromptRevision};
pub use provider::{
    EndpointPolicy, ExplicitFallback, FallbackPolicy, ModelDiscovery, PROVIDER_REGISTRY_VERSION,
    ProviderAuthKind, ProviderCapabilities, ProviderDefinition, ProviderKind, ProviderProfile,
    ProviderProtocol, ProviderRequestAdapter, ReasoningCapabilities, ReasoningConfig,
    ReasoningEffort, provider_definitions,
};
pub use validation::content_hash;
