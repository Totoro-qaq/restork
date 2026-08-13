//! Pure domain contracts for Restork extensions with explicit permissions.
//!
//! This crate deliberately performs no process creation, secret resolution, file
//! access, or network I/O. It validates declarative manifests and resolves the
//! authority that a separate Core runtime may exercise.

mod catalog;
mod error;
mod install;
mod last30days;
mod manifest;
mod permissions;
pub mod skill_import;
mod transport;
mod ui;
mod validation;

pub use catalog::{
    FrozenToolCatalog, ResolvedToolCall, ToolDescriptor, ToolRegistry, ToolSearchHit,
};
pub use error::ExtensionError;
pub use install::{InstallPreview, PackageStatus, QuarantineReason, UpdateDiff};
pub use last30days::{
    EvidenceError, Last30DaysEvidence, Last30DaysValidator, SourceGrant, ValidatedEvidenceSet,
};
pub use manifest::{
    AdapterManifest, Compatibility, LicenseId, McpServerManifest, PinnedSource, PluginManifest,
    Provenance, ResourceRef, SandboxPolicy, Sha256Digest, SkillManifest, ToolManifest,
};
pub use permissions::{EffectiveGrant, Permission, PermissionSet, resolve_effective_grant};
pub use skill_import::{
    ImportedPart, SkillImportError, SkillImportReport, SkillReference, StrippedPart,
    import_agent_skill_package, is_agent_skill_package, normalize_skill_manifest,
};
pub use transport::{EnvironmentPolicy, McpTransport, RemoteDefinition, StdioDefinition};
pub use ui::{UiAction, UiContribution, UiLocation};
