//! Import Anthropic-style `SKILL.md` packages as Restork skill manifests.
//!
//! This is an importer, not a compatibility runtime: scripts and binaries are
//! stripped, and Restork tools remain the only execution path.

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    Compatibility, ExtensionError, LicenseId, PinnedSource, Provenance, ResourceRef, Sha256Digest,
    SkillManifest,
};

pub const MAX_SKILL_MD_BYTES: usize = 64 * 1024;
pub const MAX_REFERENCE_BYTES: usize = 256 * 1024;
pub const MAX_PACKAGE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_FILE_COUNT: usize = 40;
pub const DISCOURAGE_INSTRUCTION_CHARS: usize = 200;

const ALLOWED_EXTENSIONS: &[&str] = &["md", "txt", "json", "yaml", "yml", "csv"];
const SCRIPT_EXTENSIONS: &[&str] = &[
    "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "sh", "bash", "zsh", "ps1", "exe", "bin", "wasm",
    "so", "dylib", "dll",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillImportError {
    message: String,
}

impl SkillImportError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for SkillImportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for SkillImportError {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ImportedPart {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    pub bytes: usize,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub sha256: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StrippedPart {
    pub name: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillImportReport {
    pub imported: Vec<ImportedPart>,
    pub stripped: Vec<StrippedPart>,
    pub notice: String,
}

impl SkillImportReport {
    #[must_use]
    pub fn declarative() -> Self {
        Self {
            imported: vec![ImportedPart {
                kind: "instructions".into(),
                name: None,
                bytes: 0,
                sha256: None,
            }],
            stripped: Vec::new(),
            notice: "runs_use_restork_tools".into(),
        }
    }

    #[must_use]
    pub fn should_discourage(&self, instruction_chars: usize) -> bool {
        instruction_chars < DISCOURAGE_INSTRUCTION_CHARS && !self.stripped.is_empty()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillReference {
    pub name: String,
    pub sha256: String,
    pub content: String,
}

#[derive(Clone, Debug, Deserialize)]
struct AgentSkillFile {
    path: String,
    content: String,
}

#[derive(Clone, Debug, Deserialize)]
struct AgentSkillPackage {
    format: String,
    files: Vec<AgentSkillFile>,
}

#[must_use]
pub fn is_agent_skill_package(value: &Value) -> bool {
    value
        .get("format")
        .and_then(Value::as_str)
        .is_some_and(|format| format == "agent_skill_v1")
}

/// Turn an `agent_skill_v1` files payload into a stored `SkillManifest`.
pub fn import_agent_skill_package(value: &Value) -> Result<SkillManifest, SkillImportError> {
    let package: AgentSkillPackage = serde_json::from_value(value.clone()).map_err(|_| {
        SkillImportError::new("skill package must declare format agent_skill_v1 and a files array")
    })?;
    if package.format != "agent_skill_v1" {
        return Err(SkillImportError::new(
            "skill package format must be agent_skill_v1",
        ));
    }
    if package.files.len() > MAX_FILE_COUNT {
        return Err(SkillImportError::new(
            "skill package has more than 40 files",
        ));
    }
    let total_bytes = package
        .files
        .iter()
        .map(|file| file.content.len())
        .sum::<usize>();
    if total_bytes > MAX_PACKAGE_BYTES {
        return Err(SkillImportError::new("skill package exceeds 2 MB"));
    }

    let mut imported = Vec::new();
    let mut stripped = Vec::new();
    let mut references = Vec::new();
    let mut skill_md = None;
    let mut hashed_parts = Vec::new();

    for file in &package.files {
        let path = normalize_relative_path(&file.path)?;
        if file.content.contains('\0') {
            stripped.push(StrippedPart {
                name: path,
                reason: "binary_unsupported".into(),
            });
            continue;
        }
        let lower = path.to_ascii_lowercase();
        let extension = lower.rsplit_once('.').map(|(_, ext)| ext);
        if lower.starts_with("scripts/")
            || extension.is_some_and(|ext| SCRIPT_EXTENSIONS.contains(&ext))
        {
            stripped.push(StrippedPart {
                name: path,
                reason: "script_execution_unsupported".into(),
            });
            continue;
        }
        if extension.is_none_or(|ext| !ALLOWED_EXTENSIONS.contains(&ext)) {
            stripped.push(StrippedPart {
                name: path,
                reason: "file_type_unsupported".into(),
            });
            continue;
        }
        if lower == "skill.md" || lower.ends_with("/skill.md") {
            if skill_md.is_some() {
                return Err(SkillImportError::new(
                    "skill package must contain exactly one SKILL.md",
                ));
            }
            if file.content.len() > MAX_SKILL_MD_BYTES {
                return Err(SkillImportError::new("SKILL.md exceeds 64 KB"));
            }
            skill_md = Some(file.content.clone());
            hashed_parts.push((path, file.content.clone()));
            continue;
        }
        if file.content.len() > MAX_REFERENCE_BYTES {
            return Err(SkillImportError::new(format!(
                "reference {path} exceeds 256 KB"
            )));
        }
        let digest = hex_sha256(file.content.as_bytes());
        imported.push(ImportedPart {
            kind: "reference".into(),
            name: Some(path.clone()),
            bytes: file.content.len(),
            sha256: Some(digest.clone()),
        });
        references.push(SkillReference {
            name: path.clone(),
            sha256: digest,
            content: file.content.clone(),
        });
        hashed_parts.push((path, file.content.clone()));
    }

    let skill_md = skill_md.ok_or_else(|| SkillImportError::new("SKILL.md is missing"))?;
    let parsed = parse_skill_md(&skill_md)?;
    imported.insert(
        0,
        ImportedPart {
            kind: "instructions".into(),
            name: None,
            bytes: parsed.instructions.len(),
            sha256: Some(hex_sha256(parsed.instructions.as_bytes())),
        },
    );

    hashed_parts.sort_by(|left, right| left.0.cmp(&right.0));
    let mut package_hasher = Sha256::new();
    for (path, content) in &hashed_parts {
        package_hasher.update(path.as_bytes());
        package_hasher.update([0]);
        package_hasher.update(content.as_bytes());
    }
    let content_hash = hex_digest(package_hasher.finalize());
    let slug = skill_slug(&parsed.name, &content_hash)?;
    let template_references = references
        .iter()
        .map(|reference| {
            ResourceRef::parse(format!("references/{}", sanitize_ref_name(&reference.name)))
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| SkillImportError::new(error.to_string()))?;

    let report = SkillImportReport {
        imported,
        stripped,
        notice: "runs_use_restork_tools".into(),
    };
    let provenance = Provenance {
        source: PinnedSource::Catalog {
            catalog_id: "local-folder-import".into(),
            version: "1.0.0".into(),
        },
        license: LicenseId::parse("LicenseRef-Imported")
            .map_err(|_| SkillImportError::new("imported skill license is invalid"))?,
        content_hash: Sha256Digest::parse(content_hash)
            .map_err(|_| SkillImportError::new("imported skill hash is invalid"))?,
        signature: None,
    };

    Ok(SkillManifest {
        schema_version: 1,
        id: slug,
        version: "1.0.0".into(),
        provenance,
        compatibility: Compatibility {
            minimum_core_version: "0.1.0".into(),
            maximum_core_version: None,
        },
        enabled_profiles: BTreeSet::new(),
        procedure: ResourceRef::parse("skills/instructions.md")
            .map_err(|error| SkillImportError::new(error.to_string()))?,
        prompt_references: Vec::new(),
        schema_references: Vec::new(),
        template_references,
        requested_permissions: crate::PermissionSet::default(),
        display_name: Some(parsed.name),
        description: parsed.description,
        keywords: parsed.keywords,
        default_mode: parsed.default_mode,
        category: parsed.category,
        surfaces: parsed.surfaces,
        activation: parsed.activation,
        instructions: Some(parsed.instructions),
        import_report: Some(report),
        references,
    })
}

/// Existing declarative skill JSON is left unchanged.
pub fn normalize_skill_manifest(value: &Value) -> Result<Value, SkillImportError> {
    if is_agent_skill_package(value) {
        let manifest = import_agent_skill_package(value)?;
        serde_json::to_value(manifest)
            .map_err(|_| SkillImportError::new("imported skill could not be encoded"))
    } else {
        Ok(value.clone())
    }
}

struct ParsedSkillMd {
    name: String,
    description: Option<String>,
    keywords: Vec<String>,
    default_mode: Option<String>,
    category: Option<String>,
    surfaces: BTreeSet<String>,
    activation: Option<String>,
    instructions: String,
}

fn parse_skill_md(source: &str) -> Result<ParsedSkillMd, SkillImportError> {
    let text = source.trim_start_matches('\u{feff}');
    let (front_matter, body) = split_front_matter(text);
    let fields = parse_front_matter(&front_matter)?;
    let name = fields
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| SkillImportError::new("SKILL.md is missing a name"))?;
    let description = fields
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let keywords = fields
        .iter()
        .find(|(key, _)| key == "keywords")
        .map(|(_, value)| parse_keyword_list(value))
        .unwrap_or_default();
    let default_mode = fields
        .iter()
        .find(|(key, _)| key == "default_mode")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if let Some(mode) = &default_mode
        && !matches!(mode.as_str(), "research" | "study" | "work")
    {
        return Err(SkillImportError::new(
            "default_mode must be research, study, or work",
        ));
    }
    let category = fields
        .iter()
        .find(|(key, _)| key == "category")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let surfaces = fields
        .iter()
        .find(|(key, _)| key == "surfaces")
        .map(|(_, value)| parse_keyword_list(value).into_iter().collect())
        .unwrap_or_default();
    let activation = fields
        .iter()
        .find(|(key, _)| key == "activation")
        .map(|(_, value)| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let (category, surfaces, activation) = infer_routing(
        &name,
        description.as_deref(),
        &keywords,
        default_mode.as_deref(),
        category,
        surfaces,
        activation,
    );
    let instructions = body.trim().to_owned();
    if instructions.is_empty() {
        return Err(SkillImportError::new("SKILL.md is empty"));
    }
    Ok(ParsedSkillMd {
        name,
        description,
        keywords,
        default_mode,
        category,
        surfaces,
        activation,
        instructions,
    })
}

fn infer_routing(
    name: &str,
    description: Option<&str>,
    keywords: &[String],
    default_mode: Option<&str>,
    category: Option<String>,
    surfaces: BTreeSet<String>,
    activation: Option<String>,
) -> (Option<String>, BTreeSet<String>, Option<String>) {
    if !surfaces.is_empty() {
        return (
            category,
            surfaces,
            activation.or_else(|| Some("manual".into())),
        );
    }
    let corpus = format!(
        "{} {} {}",
        name,
        description.unwrap_or_default(),
        keywords.join(" ")
    )
    .to_ascii_lowercase();
    let inferred = if [
        "ppt",
        "pptx",
        "powerpoint",
        "presentation",
        "slide",
        "deck",
        "keynote",
    ]
    .iter()
    .any(|term| corpus.contains(term))
    {
        Some(("presentation", "presentations", "manual"))
    } else if ["vault", "obsidian", "knowledge base", "知识库", "笔记管理"]
        .iter()
        .any(|term| corpus.contains(term))
    {
        Some(("knowledge", "vault", "manual"))
    } else if ["automation", "schedule", "自动化", "定时"]
        .iter()
        .any(|term| corpus.contains(term))
    {
        Some(("automation", "automation", "manual"))
    } else {
        default_mode.map(|mode| {
            (
                mode,
                match mode {
                    "study" => "start.study",
                    "work" => "start.work",
                    _ => "start.research",
                },
                "suggest",
            )
        })
    };
    let Some((inferred_category, surface, inferred_activation)) = inferred else {
        return (
            category.or_else(|| Some("general".into())),
            surfaces,
            activation.or_else(|| Some("manual".into())),
        );
    };
    (
        category.or_else(|| Some(inferred_category.into())),
        BTreeSet::from([surface.into()]),
        activation.or_else(|| Some(inferred_activation.into())),
    )
}

fn split_front_matter(text: &str) -> (String, String) {
    let Some(rest) = text.strip_prefix("---") else {
        return (String::new(), text.to_owned());
    };
    let rest = rest.trim_start_matches(['\r', '\n']);
    let Some(end) = rest.find("\n---") else {
        return (String::new(), text.to_owned());
    };
    let matter = rest[..end].to_owned();
    let after = rest[end + 4..].trim_start_matches(['\r', '\n']).to_owned();
    (matter, after)
}

fn parse_front_matter(source: &str) -> Result<Vec<(String, String)>, SkillImportError> {
    let mut fields = Vec::new();
    let mut pending_key: Option<String> = None;
    let mut pending_items: Vec<String> = Vec::new();
    let flush_pending = |fields: &mut Vec<(String, String)>,
                         pending_key: &mut Option<String>,
                         pending_items: &mut Vec<String>| {
        if let Some(key) = pending_key.take() {
            fields.push((key, pending_items.join(",")));
            pending_items.clear();
        }
    };
    for raw in source.lines() {
        let line = raw.trim_end();
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if let Some(item) = line.trim().strip_prefix("- ")
            && pending_key.is_some()
        {
            pending_items.push(item.trim().trim_matches('"').to_owned());
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            flush_pending(&mut fields, &mut pending_key, &mut pending_items);
            let key = key.trim().to_ascii_lowercase();
            let value = value.trim().trim_matches('"').to_owned();
            if value.is_empty() {
                pending_key = Some(key);
            } else {
                fields.push((key, value));
            }
        }
    }
    flush_pending(&mut fields, &mut pending_key, &mut pending_items);
    Ok(fields)
}

fn parse_keyword_list(value: &str) -> Vec<String> {
    let trimmed = value.trim().trim_start_matches('[').trim_end_matches(']');
    trimmed
        .split([',', ' '])
        .map(|item| item.trim().trim_matches('"').to_owned())
        .filter(|item| !item.is_empty())
        .collect()
}

fn normalize_relative_path(path: &str) -> Result<String, SkillImportError> {
    let unified = path.replace('\\', "/");
    if unified.is_empty()
        || unified.starts_with('/')
        || unified.contains('\0')
        || unified.contains("://")
        || (unified.len() >= 2 && unified.as_bytes()[1] == b':')
    {
        return Err(SkillImportError::new(
            "skill package paths must be relative",
        ));
    }
    let parts = unified.split('/').collect::<Vec<_>>();
    if parts
        .iter()
        .any(|part| part.is_empty() || *part == "." || *part == "..")
    {
        return Err(SkillImportError::new(
            "skill package paths must be relative",
        ));
    }
    Ok(unified)
}

fn skill_slug(name: &str, content_hash: &str) -> Result<String, SkillImportError> {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_matches('-').to_owned();
    let candidate = if slug.is_empty() {
        format!("imported-skill-{}", &content_hash[..8])
    } else if slug.len() > 64 {
        slug[..64].trim_end_matches('-').to_owned()
    } else {
        slug
    };
    crate::validation::validate_identifier(&candidate)
        .map_err(|error: ExtensionError| SkillImportError::new(error.to_string()))?;
    Ok(candidate)
}

fn sanitize_ref_name(name: &str) -> String {
    name.replace('/', "-")
}

fn hex_sha256(bytes: &[u8]) -> String {
    hex_digest(Sha256::digest(bytes))
}

fn hex_digest(digest: impl AsRef<[u8]>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(64);
    for byte in digest.as_ref() {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skill_md(name: &str, body: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: Make decks\nkeywords: [ppt, slides]\ndefault_mode: work\n---\n{body}\n"
        )
    }

    #[test]
    fn instruction_only_package_imports_without_stripping() {
        let package = json!({
            "format": "agent_skill_v1",
            "files": [{
                "path": "SKILL.md",
                "content": skill_md("ppt-master", "Write slides from the brief. Keep claims cited.")
            }, {
                "path": "references/templates.md",
                "content": "# Template\nUse three acts."
            }]
        });
        let manifest = import_agent_skill_package(&package).expect("import");
        assert_eq!(manifest.id, "ppt-master");
        assert_eq!(manifest.display_name.as_deref(), Some("ppt-master"));
        assert_eq!(manifest.default_mode.as_deref(), Some("work"));
        assert_eq!(manifest.keywords, vec!["ppt", "slides"]);
        assert_eq!(manifest.category.as_deref(), Some("presentation"));
        assert_eq!(manifest.surfaces, BTreeSet::from(["presentations".into()]));
        assert_eq!(manifest.activation.as_deref(), Some("manual"));
        let report = manifest.import_report.expect("report");
        assert!(report.stripped.is_empty());
        assert_eq!(report.imported[0].kind, "instructions");
        assert_eq!(
            report.imported[1].name.as_deref(),
            Some("references/templates.md")
        );
        assert!(
            !report.should_discourage(
                manifest
                    .instructions
                    .as_ref()
                    .map_or(0, |text| text.chars().count())
            )
        );
        assert!(
            manifest
                .instructions
                .as_ref()
                .is_some_and(|text| text.contains("Keep claims cited"))
        );
    }

    #[test]
    fn scripts_are_stripped_and_script_cores_are_discouraged() {
        let package = json!({
            "format": "agent_skill_v1",
            "files": [{
                "path": "SKILL.md",
                "content": skill_md("cobsidian", "Run the helper.")
            }, {
                "path": "scripts/render-check.mjs",
                "content": "console.log('nope')"
            }]
        });
        let manifest = import_agent_skill_package(&package).expect("import");
        let report = manifest.import_report.expect("report");
        assert_eq!(report.stripped[0].name, "scripts/render-check.mjs");
        assert_eq!(report.stripped[0].reason, "script_execution_unsupported");
        assert!(
            report.should_discourage(
                manifest
                    .instructions
                    .as_ref()
                    .map_or(0, |text| text.chars().count())
            )
        );
        assert!(
            manifest
                .instructions
                .as_ref()
                .is_some_and(|text| !text.contains("console.log"))
        );
    }

    #[test]
    fn missing_name_empty_body_and_bounds_are_rejected() {
        let missing_name = json!({
            "format": "agent_skill_v1",
            "files": [{ "path": "SKILL.md", "content": "---\ndescription: x\n---\nBody text that is long enough.\n" }]
        });
        assert_eq!(
            import_agent_skill_package(&missing_name)
                .unwrap_err()
                .message(),
            "SKILL.md is missing a name"
        );
        let empty_body = json!({
            "format": "agent_skill_v1",
            "files": [{ "path": "SKILL.md", "content": "---\nname: empty\n---\n\n" }]
        });
        assert_eq!(
            import_agent_skill_package(&empty_body)
                .unwrap_err()
                .message(),
            "SKILL.md is empty"
        );
        let huge = "a".repeat(MAX_SKILL_MD_BYTES + 1);
        let oversized = json!({
            "format": "agent_skill_v1",
            "files": [{ "path": "SKILL.md", "content": format!("---\nname: huge\n---\n{huge}") }]
        });
        assert_eq!(
            import_agent_skill_package(&oversized)
                .unwrap_err()
                .message(),
            "SKILL.md exceeds 64 KB"
        );
        let too_many = json!({
            "format": "agent_skill_v1",
            "files": (0..41).map(|index| json!({
                "path": format!("note-{index}.md"),
                "content": "x"
            })).collect::<Vec<_>>()
        });
        assert_eq!(
            import_agent_skill_package(&too_many).unwrap_err().message(),
            "skill package has more than 40 files"
        );
        let duplicate_skill_md = json!({
            "format": "agent_skill_v1",
            "files": [{
                "path": "SKILL.md",
                "content": skill_md("first", "First instructions.")
            }, {
                "path": "nested/SKILL.md",
                "content": skill_md("second", "Second instructions.")
            }]
        });
        assert_eq!(
            import_agent_skill_package(&duplicate_skill_md)
                .unwrap_err()
                .message(),
            "skill package must contain exactly one SKILL.md"
        );
    }

    #[test]
    fn absolute_and_binary_paths_never_enter_the_manifest() {
        let absolute = json!({
            "format": "agent_skill_v1",
            "files": [{
                "path": "/opt/restork-fixture/ppt-master/SKILL.md",
                "content": skill_md("abs", "Body")
            }]
        });
        assert!(
            import_agent_skill_package(&absolute)
                .unwrap_err()
                .message()
                .contains("relative")
        );
        let binary = json!({
            "format": "agent_skill_v1",
            "files": [{
                "path": "SKILL.md",
                "content": skill_md("bin", "Body that is imported.")
            }, {
                "path": "assets/icon.png",
                "content": "not-a-png\u{0000}hidden"
            }]
        });
        let manifest = import_agent_skill_package(&binary).expect("png stripped");
        let report = manifest.import_report.as_ref().expect("report");
        assert!(
            report
                .stripped
                .iter()
                .any(|part| part.reason == "binary_unsupported")
        );
        let encoded = serde_json::to_string(&manifest).expect("json");
        assert!(!encoded.contains("/opt/restork-fixture/"));
        assert!(!encoded.contains('\u{0000}'));
    }
}
