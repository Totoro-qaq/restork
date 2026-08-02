use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::{
    DeliverableError, Result,
    hash::{canonical_hash, domain_hash, encode_hex},
    safety::{validate_hash, validate_id, validate_nonempty_text, validate_safe_relative_path},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Pptx,
    Pdf,
}

impl ExportFormat {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Pptx => "pptx",
            Self::Pdf => "pdf",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ExportManifest {
    export_id: String,
    deck_id: String,
    deck_revision: u64,
    format: ExportFormat,
    artifact_hash: String,
    deck_spec_hash: String,
    renderer_id: String,
    renderer_version: String,
    renderer_binary_hash: String,
    reproducibility_manifest_hash: String,
    outline_approval_digest: String,
    created_at: OffsetDateTime,
    manifest_hash: String,
}

impl ExportManifest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        export_id: impl Into<String>,
        deck_id: impl Into<String>,
        deck_revision: u64,
        format: ExportFormat,
        artifact_hash: impl Into<String>,
        deck_spec_hash: impl Into<String>,
        renderer_id: impl Into<String>,
        renderer_version: impl Into<String>,
        renderer_binary_hash: impl Into<String>,
        reproducibility_manifest_hash: impl Into<String>,
        outline_approval_digest: impl Into<String>,
        created_at: OffsetDateTime,
    ) -> Result<Self> {
        let export_id = export_id.into();
        validate_id("export_id", &export_id)?;
        let deck_id = deck_id.into();
        validate_id("deck_id", &deck_id)?;
        if deck_revision == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        let artifact_hash = artifact_hash.into();
        validate_hash("artifact_hash", &artifact_hash)?;
        let deck_spec_hash = deck_spec_hash.into();
        validate_hash("deck_spec_hash", &deck_spec_hash)?;
        let renderer_id = renderer_id.into();
        validate_id("renderer_id", &renderer_id)?;
        let renderer_version = renderer_version.into();
        validate_nonempty_text("renderer_version", &renderer_version)?;
        let renderer_binary_hash = renderer_binary_hash.into();
        validate_hash("renderer_binary_hash", &renderer_binary_hash)?;
        let reproducibility_manifest_hash = reproducibility_manifest_hash.into();
        validate_hash(
            "reproducibility_manifest_hash",
            &reproducibility_manifest_hash,
        )?;
        let outline_approval_digest = outline_approval_digest.into();
        validate_hash("outline_approval_digest", &outline_approval_digest)?;
        let canonical = canonical_hash(&(
            &export_id,
            &deck_id,
            deck_revision,
            format,
            &artifact_hash,
            &deck_spec_hash,
            &renderer_id,
            &renderer_version,
            &renderer_binary_hash,
            &reproducibility_manifest_hash,
            &outline_approval_digest,
            created_at,
        ))?;
        let manifest_hash = domain_hash("restork.export-manifest.v1", &[&canonical]);
        Ok(Self {
            export_id,
            deck_id,
            deck_revision,
            format,
            artifact_hash,
            deck_spec_hash,
            renderer_id,
            renderer_version,
            renderer_binary_hash,
            reproducibility_manifest_hash,
            outline_approval_digest,
            created_at,
            manifest_hash,
        })
    }

    #[must_use]
    pub fn manifest_hash(&self) -> &str {
        &self.manifest_hash
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalAction {
    ReportWrite,
    DeckOutlineFreeze,
    DeckExport,
}

impl ApprovalAction {
    const fn as_str(self) -> &'static str {
        match self {
            Self::ReportWrite => "report_write",
            Self::DeckOutlineFreeze => "deck_outline_freeze",
            Self::DeckExport => "deck_export",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ApprovalBinding {
    action: ApprovalAction,
    scope: String,
    resources: BTreeMap<String, String>,
    policy_version: String,
    nonce: String,
    digest: String,
}

impl ApprovalBinding {
    pub fn deck_outline(
        deck_id: &str,
        revision: u64,
        deck_spec_hash: &str,
        ledger_hash: &str,
        policy_version: &str,
    ) -> Result<Self> {
        Self::deck_outline_with_nonce(
            deck_id,
            revision,
            deck_spec_hash,
            ledger_hash,
            policy_version,
            random_nonce()?,
        )
    }

    pub fn deck_outline_with_nonce(
        deck_id: &str,
        revision: u64,
        deck_spec_hash: &str,
        ledger_hash: &str,
        policy_version: &str,
        nonce: [u8; 32],
    ) -> Result<Self> {
        validate_id("deck_id", deck_id)?;
        if revision == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        validate_hash("deck_spec_hash", deck_spec_hash)?;
        validate_hash("ledger_hash", ledger_hash)?;
        let outline_digest = domain_hash(
            "restork.deck.outline.v1",
            &[deck_id, &revision.to_string(), deck_spec_hash, ledger_hash],
        );
        let resources = BTreeMap::from([
            ("deck_spec".to_owned(), deck_spec_hash.to_owned()),
            ("evidence_ledger".to_owned(), ledger_hash.to_owned()),
            ("outline".to_owned(), outline_digest),
        ]);
        Self::build(
            ApprovalAction::DeckOutlineFreeze,
            format!("deck:{deck_id}:revision:{revision}"),
            resources,
            policy_version,
            nonce,
        )
    }

    pub fn deck_export(manifest: &ExportManifest, policy_version: &str) -> Result<Self> {
        Self::deck_export_with_nonce(manifest, policy_version, random_nonce()?)
    }

    pub fn deck_export_with_nonce(
        manifest: &ExportManifest,
        policy_version: &str,
        nonce: [u8; 32],
    ) -> Result<Self> {
        let resources = BTreeMap::from([
            ("artifact".to_owned(), manifest.artifact_hash.clone()),
            ("deck_spec".to_owned(), manifest.deck_spec_hash.clone()),
            (
                "renderer_binary".to_owned(),
                manifest.renderer_binary_hash.clone(),
            ),
            (
                "reproducibility_manifest".to_owned(),
                manifest.reproducibility_manifest_hash.clone(),
            ),
            (
                "outline_approval".to_owned(),
                manifest.outline_approval_digest.clone(),
            ),
            ("export_manifest".to_owned(), manifest.manifest_hash.clone()),
        ]);
        Self::build(
            ApprovalAction::DeckExport,
            format!(
                "deck:{}:revision:{}:export:{}:{}",
                manifest.deck_id,
                manifest.deck_revision,
                manifest.export_id,
                manifest.format.as_str()
            ),
            resources,
            policy_version,
            nonce,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn report_write_with_nonce(
        report_id: &str,
        revision: u64,
        ledger_hash: &str,
        markdown_hash: &str,
        target_relative_path: &str,
        expected_preimage_hash: Option<&str>,
        policy_version: &str,
        nonce: [u8; 32],
    ) -> Result<Self> {
        validate_id("report_id", report_id)?;
        if revision == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        validate_hash("ledger_hash", ledger_hash)?;
        validate_hash("markdown_hash", markdown_hash)?;
        validate_safe_relative_path(target_relative_path)?;
        if let Some(hash) = expected_preimage_hash {
            validate_hash("expected_preimage_hash", hash)?;
        }
        let resources = BTreeMap::from([
            ("evidence_ledger".to_owned(), ledger_hash.to_owned()),
            ("markdown".to_owned(), markdown_hash.to_owned()),
            (
                "target_preimage".to_owned(),
                expected_preimage_hash.unwrap_or("absent").to_owned(),
            ),
        ]);
        Self::build(
            ApprovalAction::ReportWrite,
            format!("report:{report_id}:revision:{revision}:target:{target_relative_path}"),
            resources,
            policy_version,
            nonce,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn report_write(
        report_id: &str,
        revision: u64,
        ledger_hash: &str,
        markdown_hash: &str,
        target_relative_path: &str,
        expected_preimage_hash: Option<&str>,
        policy_version: &str,
    ) -> Result<Self> {
        Self::report_write_with_nonce(
            report_id,
            revision,
            ledger_hash,
            markdown_hash,
            target_relative_path,
            expected_preimage_hash,
            policy_version,
            random_nonce()?,
        )
    }

    fn build(
        action: ApprovalAction,
        scope: String,
        resources: BTreeMap<String, String>,
        policy_version: &str,
        nonce: [u8; 32],
    ) -> Result<Self> {
        validate_id("policy_version", policy_version)?;
        let resources_hash = canonical_hash(&resources)?;
        let nonce = encode_hex(&nonce);
        let digest = domain_hash(
            "restork.approval-binding.v1",
            &[
                action.as_str(),
                &scope,
                &resources_hash,
                policy_version,
                &nonce,
            ],
        );
        Ok(Self {
            action,
            scope,
            resources,
            policy_version: policy_version.to_owned(),
            nonce,
            digest,
        })
    }

    #[must_use]
    pub const fn action(&self) -> ApprovalAction {
        self.action
    }

    #[must_use]
    pub fn resources(&self) -> &BTreeMap<String, String> {
        &self.resources
    }

    #[must_use]
    pub fn digest(&self) -> &str {
        &self.digest
    }
}

fn random_nonce() -> Result<[u8; 32]> {
    let mut storage = [std::mem::MaybeUninit::<u8>::uninit(); 32];
    let initialized =
        getrandom::fill_uninit(&mut storage).map_err(|_| DeliverableError::EntropyUnavailable)?;
    let initialized: &[u8] = initialized;
    let nonce: &[u8; 32] = initialized
        .try_into()
        .map_err(|_| DeliverableError::EntropyUnavailable)?;
    Ok(*nonce)
}
