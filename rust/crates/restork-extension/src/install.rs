use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::{
    ExtensionError, LicenseId, PermissionSet, PinnedSource, PluginManifest, Sha256Digest,
    resolve_effective_grant,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineReason {
    AwaitingInstallReview,
    AwaitingUpdateReview,
    ValidationFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "state", content = "reason", rename_all = "snake_case")]
pub enum PackageStatus {
    Quarantined(QuarantineReason),
    Disabled,
    Enabled,
}

/// Metadata shown before an installation can be approved.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstallPreview {
    pub package_id: String,
    pub version: String,
    pub source: PinnedSource,
    pub license: LicenseId,
    pub content_hash: Sha256Digest,
    pub signature_present: bool,
    pub requested_permissions: PermissionSet,
    pub effective_permissions: PermissionSet,
    pub denied_permissions: PermissionSet,
    pub required_executables: BTreeSet<String>,
    pub secret_references: BTreeSet<String>,
    pub tool_ids: BTreeSet<String>,
    pub status: PackageStatus,
}

impl InstallPreview {
    pub fn build(
        manifest: &PluginManifest,
        core_ceiling: &PermissionSet,
        profile_grant: &PermissionSet,
        run_grant: &PermissionSet,
    ) -> Result<Self, ExtensionError> {
        manifest.validate()?;
        let grant = resolve_effective_grant(
            core_ceiling,
            profile_grant,
            &manifest.requested_permissions,
            run_grant,
        );
        let required_executables = manifest
            .mcp_servers
            .iter()
            .filter_map(|server| match &server.transport {
                crate::McpTransport::Stdio(definition) => Some(definition.executable.clone()),
                crate::McpTransport::RemoteHttps(_) => None,
            })
            .collect();
        let secret_references = manifest
            .mcp_servers
            .iter()
            .flat_map(|server| server.secret_references.iter().cloned())
            .collect();
        Ok(Self {
            package_id: manifest.id.clone(),
            version: manifest.version.clone(),
            source: manifest.provenance.source.clone(),
            license: manifest.provenance.license.clone(),
            content_hash: manifest.provenance.content_hash.clone(),
            signature_present: manifest.provenance.signature.is_some(),
            requested_permissions: manifest.requested_permissions.clone(),
            effective_permissions: grant.granted().clone(),
            denied_permissions: grant.denied_from_package().clone(),
            required_executables,
            secret_references,
            tool_ids: manifest.tool_ids(),
            status: PackageStatus::Quarantined(QuarantineReason::AwaitingInstallReview),
        })
    }
}

/// Reviewable changes between two immutable package snapshots.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct UpdateDiff {
    pub package_id: String,
    pub previous_version: String,
    pub next_version: String,
    pub source_changed: bool,
    pub license_changed: bool,
    pub content_hash_changed: bool,
    pub signature_changed: bool,
    pub transport_changed: bool,
    pub ui_changed: bool,
    pub added_permissions: PermissionSet,
    pub removed_permissions: PermissionSet,
    pub added_tools: BTreeSet<String>,
    pub removed_tools: BTreeSet<String>,
    pub added_components: BTreeSet<String>,
    pub removed_components: BTreeSet<String>,
    pub status: PackageStatus,
}

impl UpdateDiff {
    pub fn between(
        previous: &PluginManifest,
        next: &PluginManifest,
    ) -> Result<Self, ExtensionError> {
        previous.validate()?;
        next.validate()?;
        if previous.id != next.id {
            return Err(ExtensionError::PackageIdentityChanged);
        }
        let previous_tools = previous.tool_ids();
        let next_tools = next.tool_ids();
        let previous_components = component_ids(previous);
        let next_components = component_ids(next);
        Ok(Self {
            package_id: previous.id.clone(),
            previous_version: previous.version.clone(),
            next_version: next.version.clone(),
            source_changed: previous.provenance.source != next.provenance.source,
            license_changed: previous.provenance.license != next.provenance.license,
            content_hash_changed: previous.provenance.content_hash != next.provenance.content_hash,
            signature_changed: previous.provenance.signature != next.provenance.signature,
            transport_changed: previous
                .mcp_servers
                .iter()
                .map(|server| (&server.id, &server.transport))
                .collect::<Vec<_>>()
                != next
                    .mcp_servers
                    .iter()
                    .map(|server| (&server.id, &server.transport))
                    .collect::<Vec<_>>(),
            ui_changed: previous.ui != next.ui,
            added_permissions: next
                .requested_permissions
                .difference(&previous.requested_permissions),
            removed_permissions: previous
                .requested_permissions
                .difference(&next.requested_permissions),
            added_tools: next_tools.difference(&previous_tools).cloned().collect(),
            removed_tools: previous_tools.difference(&next_tools).cloned().collect(),
            added_components: next_components
                .difference(&previous_components)
                .cloned()
                .collect(),
            removed_components: previous_components
                .difference(&next_components)
                .cloned()
                .collect(),
            status: PackageStatus::Quarantined(QuarantineReason::AwaitingUpdateReview),
        })
    }

    #[must_use]
    pub fn requires_review(&self) -> bool {
        self.previous_version != self.next_version
            || self.source_changed
            || self.license_changed
            || self.content_hash_changed
            || self.signature_changed
            || self.transport_changed
            || self.ui_changed
            || self.added_permissions != PermissionSet::default()
            || self.removed_permissions != PermissionSet::default()
            || !self.added_tools.is_empty()
            || !self.removed_tools.is_empty()
            || !self.added_components.is_empty()
            || !self.removed_components.is_empty()
    }
}

fn component_ids(manifest: &PluginManifest) -> BTreeSet<String> {
    manifest
        .skills
        .iter()
        .map(|skill| format!("skill:{}", skill.id))
        .chain(
            manifest
                .mcp_servers
                .iter()
                .map(|server| format!("mcp:{}", server.id)),
        )
        .chain(
            manifest
                .adapters
                .iter()
                .map(|adapter| format!("adapter:{}", adapter.id)),
        )
        .chain(
            manifest
                .ui
                .iter()
                .map(|contribution| format!("ui:{}", contribution.id)),
        )
        .collect()
}
