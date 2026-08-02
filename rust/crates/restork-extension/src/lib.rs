//! Pure domain contracts for governed Restork extensions.
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
pub use transport::{EnvironmentPolicy, McpTransport, RemoteDefinition, StdioDefinition};
pub use ui::{UiAction, UiContribution, UiLocation};
