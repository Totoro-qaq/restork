use std::collections::BTreeSet;

use serde::Serialize;

use crate::{
    DeliverableError, Result,
    hash::domain_hash,
    safety::{validate_hash, validate_nonempty_text},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveEntryMetadata {
    name: String,
    compressed_bytes: u64,
    uncompressed_bytes: u64,
    content_type: Option<String>,
    is_directory: bool,
}

impl ArchiveEntryMetadata {
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        compressed_bytes: u64,
        uncompressed_bytes: u64,
        content_type: Option<&str>,
        is_directory: bool,
    ) -> Self {
        Self {
            name: name.into(),
            compressed_bytes,
            uncompressed_bytes,
            content_type: content_type.map(str::to_owned),
            is_directory,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveRelationship {
    source_part: String,
    target: String,
    relationship_type: String,
    target_mode_external: bool,
}

impl ArchiveRelationship {
    #[must_use]
    pub fn new(
        source_part: impl Into<String>,
        target: impl Into<String>,
        relationship_type: impl Into<String>,
        target_mode_external: bool,
    ) -> Self {
        Self {
            source_part: source_part.into(),
            target: target.into(),
            relationship_type: relationship_type.into(),
            target_mode_external,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateArchiveMetadata {
    file_name: String,
    archive_hash: String,
    entries: Vec<ArchiveEntryMetadata>,
    relationships: Vec<ArchiveRelationship>,
}

impl TemplateArchiveMetadata {
    pub fn new<E, R>(
        file_name: impl Into<String>,
        archive_hash: impl Into<String>,
        entries: E,
        relationships: R,
    ) -> Result<Self>
    where
        E: IntoIterator<Item = ArchiveEntryMetadata>,
        R: IntoIterator<Item = ArchiveRelationship>,
    {
        let file_name = file_name.into();
        validate_nonempty_text("file_name", &file_name)?;
        let archive_hash = archive_hash.into();
        validate_hash("archive_hash", &archive_hash)?;
        Ok(Self {
            file_name,
            archive_hash,
            entries: entries.into_iter().collect(),
            relationships: relationships.into_iter().collect(),
        })
    }

    pub fn replace_relationships<R>(&mut self, relationships: R)
    where
        R: IntoIterator<Item = ArchiveRelationship>,
    {
        self.relationships = relationships.into_iter().collect();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArchiveLimits {
    pub max_entries: usize,
    pub max_entry_uncompressed_bytes: u64,
    pub max_total_uncompressed_bytes: u64,
    pub max_compression_ratio: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            max_entries: 2_048,
            max_entry_uncompressed_bytes: 64 * 1024 * 1024,
            max_total_uncompressed_bytes: 256 * 1024 * 1024,
            max_compression_ratio: 200,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateSafetyReport {
    archive_hash: String,
    entry_count: usize,
    total_uncompressed_bytes: u64,
    rules_digest: String,
}

impl TemplateSafetyReport {
    #[must_use]
    pub const fn entry_count(&self) -> usize {
        self.entry_count
    }

    #[must_use]
    pub const fn total_uncompressed_bytes(&self) -> u64 {
        self.total_uncompressed_bytes
    }

    #[must_use]
    pub fn rules_digest(&self) -> &str {
        &self.rules_digest
    }
}

/// Validates already parsed central-directory and OOXML relationship metadata.
///
/// The archive reader remains responsible for enforcing these byte caps while
/// streaming decompression; central-directory metadata alone cannot stop a
/// malicious decompressor from lying about its output size.
pub fn scan_template_archive(
    archive: &TemplateArchiveMetadata,
    limits: &ArchiveLimits,
) -> Result<TemplateSafetyReport> {
    validate_limits(limits)?;
    if !archive.file_name.to_ascii_lowercase().ends_with(".pptx") {
        return unsafe_template("only macro-free .pptx templates are accepted");
    }
    if archive.entries.len() > limits.max_entries {
        return archive_limit("entry count");
    }

    let mut normalized_names = BTreeSet::new();
    let mut exact_names = BTreeSet::new();
    let mut total_uncompressed = 0_u64;
    for entry in &archive.entries {
        validate_archive_entry_name(&entry.name)?;
        let normalized = entry.name.to_ascii_lowercase();
        if !normalized_names.insert(normalized.clone()) {
            return unsafe_template("duplicate or case-colliding archive entry");
        }
        exact_names.insert(entry.name.clone());
        reject_active_content(&normalized, entry.content_type.as_deref())?;

        if entry.is_directory && (entry.compressed_bytes != 0 || entry.uncompressed_bytes != 0) {
            return unsafe_template("directory entries must have zero byte sizes");
        }
        if entry.uncompressed_bytes > limits.max_entry_uncompressed_bytes {
            return archive_limit("single entry uncompressed size");
        }
        if entry.uncompressed_bytes > 0 && entry.compressed_bytes == 0 {
            return archive_limit("zero-byte compressed entry expands to data");
        }
        if entry.uncompressed_bytes
            > entry
                .compressed_bytes
                .saturating_mul(limits.max_compression_ratio)
        {
            return archive_limit("compression ratio");
        }
        total_uncompressed = total_uncompressed
            .checked_add(entry.uncompressed_bytes)
            .ok_or_else(|| DeliverableError::ArchiveLimitExceeded {
                reason: "total uncompressed size overflow".to_owned(),
            })?;
        if total_uncompressed > limits.max_total_uncompressed_bytes {
            return archive_limit("total uncompressed size");
        }
    }

    if !exact_names.contains("[Content_Types].xml") {
        return Err(DeliverableError::MissingArchivePart("[Content_Types].xml"));
    }
    if !exact_names.contains("ppt/presentation.xml") {
        return Err(DeliverableError::MissingArchivePart("ppt/presentation.xml"));
    }

    for relationship in &archive.relationships {
        validate_relationship(relationship, &exact_names)?;
    }

    let limits_text = format!(
        "{}:{}:{}:{}",
        limits.max_entries,
        limits.max_entry_uncompressed_bytes,
        limits.max_total_uncompressed_bytes,
        limits.max_compression_ratio
    );
    Ok(TemplateSafetyReport {
        archive_hash: archive.archive_hash.clone(),
        entry_count: archive.entries.len(),
        total_uncompressed_bytes: total_uncompressed,
        rules_digest: domain_hash(
            "restork.template-safety.v1",
            &[&archive.archive_hash, &limits_text],
        ),
    })
}

fn validate_limits(limits: &ArchiveLimits) -> Result<()> {
    if limits.max_entries == 0
        || limits.max_entry_uncompressed_bytes == 0
        || limits.max_total_uncompressed_bytes == 0
        || limits.max_compression_ratio == 0
    {
        return archive_limit("zero-valued safety limit");
    }
    Ok(())
}

fn validate_archive_entry_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.contains('\0')
        || name.contains('\\')
        || name.contains('%')
        || name.contains(':')
    {
        return unsafe_template("invalid archive entry path");
    }
    if name
        .split('/')
        .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return unsafe_template("archive entry path traversal");
    }
    Ok(())
}

fn reject_active_content(normalized_name: &str, content_type: Option<&str>) -> Result<()> {
    const UNSAFE_PATHS: &[&str] = &[
        "vbaproject",
        "ppt/activex/",
        "ppt/embeddings/",
        "ppt/oleobjects/",
        "ppt/externallinks/",
        "customui/",
    ];
    if normalized_name.ends_with(".bin")
        || UNSAFE_PATHS
            .iter()
            .any(|fragment| normalized_name.contains(fragment))
    {
        return unsafe_template("macro, OLE, ActiveX, or embedded content");
    }
    if let Some(content_type) = content_type {
        let normalized_type = content_type.to_ascii_lowercase();
        if ["macroenabled", "vba", "oleobject", "activex"]
            .iter()
            .any(|fragment| normalized_type.contains(fragment))
        {
            return unsafe_template("active OOXML content type");
        }
    }
    Ok(())
}

fn validate_relationship(
    relationship: &ArchiveRelationship,
    entries: &BTreeSet<String>,
) -> Result<()> {
    if relationship.target_mode_external {
        return unsafe_template("external relationship target");
    }
    if !entries.contains(&relationship.source_part) {
        return Err(DeliverableError::UnknownRelationshipTarget(
            relationship.source_part.clone(),
        ));
    }

    let relationship_type = relationship.relationship_type.to_ascii_lowercase();
    if [
        "oleobject",
        "package",
        "externallink",
        "hyperlink",
        "attachedtemplate",
        "vbaproject",
        "activex",
    ]
    .iter()
    .any(|fragment| relationship_type.contains(fragment))
    {
        return unsafe_template("active or external OOXML relationship type");
    }

    let target = relationship.target.as_str();
    let normalized_target = target.to_ascii_lowercase();
    if target.is_empty()
        || target.starts_with('/')
        || target.starts_with('\\')
        || target.starts_with("//")
        || target.contains('\\')
        || target.contains('%')
        || target.contains('?')
        || target.contains('#')
        || target.contains('\0')
        || normalized_target.contains("://")
        || ["mailto:", "file:", "data:", "javascript:"]
            .iter()
            .any(|scheme| normalized_target.starts_with(scheme))
    {
        return unsafe_template("external or malformed relationship target");
    }

    let resolved = resolve_relationship_target(&relationship.source_part, target)?;
    if !entries.contains(&resolved) {
        return Err(DeliverableError::UnknownRelationshipTarget(resolved));
    }
    Ok(())
}

fn resolve_relationship_target(source_part: &str, target: &str) -> Result<String> {
    validate_archive_entry_name(source_part)?;
    let mut parts: Vec<&str> = source_part.split('/').collect();
    parts.pop();
    for part in target.split('/') {
        match part {
            "" | "." => return unsafe_template("empty relationship path component"),
            ".." => {
                if parts.pop().is_none() {
                    return unsafe_template("relationship escapes the archive root");
                }
            }
            value => parts.push(value),
        }
    }
    if parts.is_empty() {
        return unsafe_template("empty relationship target");
    }
    Ok(parts.join("/"))
}

fn unsafe_template<T>(reason: &str) -> Result<T> {
    Err(DeliverableError::UnsafeTemplate {
        reason: reason.to_owned(),
    })
}

fn archive_limit<T>(reason: &str) -> Result<T> {
    Err(DeliverableError::ArchiveLimitExceeded {
        reason: reason.to_owned(),
    })
}
