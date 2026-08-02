use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize, de};

use crate::{
    ExtensionError, McpTransport, PermissionSet, UiContribution,
    validation::{
        is_absolute_executable, validate_https_endpoint, validate_identifier, validate_plain_text,
        validate_version, version_tuple,
    },
};

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct Sha256Digest(String);

impl Sha256Digest {
    pub fn parse(value: impl Into<String>) -> Result<Self, ExtensionError> {
        let value = value.into();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ExtensionError::InvalidHash);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct LicenseId(String);

impl LicenseId {
    pub fn parse(value: impl Into<String>) -> Result<Self, ExtensionError> {
        let value = value.into();
        let valid = validate_plain_text(&value, 160)
            && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'-' | b'.' | b'+' | b'(' | b')' | b' ')
            });
        if valid {
            Ok(Self(value))
        } else {
            Err(ExtensionError::InvalidLicense)
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for LicenseId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ResourceRef(String);

impl ResourceRef {
    pub fn parse(value: impl Into<String>) -> Result<Self, ExtensionError> {
        let value = value.into();
        let valid = validate_plain_text(&value, 1024)
            && !value.starts_with(['/', '\\'])
            && !is_absolute_executable(&value)
            && !value.contains(['\\', '\0', '?', '#'])
            && value
                .split('/')
                .all(|component| !component.is_empty() && !matches!(component, "." | ".."));
        if valid {
            Ok(Self(value))
        } else {
            Err(ExtensionError::InvalidReference(value))
        }
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ResourceRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::parse(String::deserialize(deserializer)?).map_err(de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum PinnedSource {
    LocalDirectory { path: String },
    Catalog { catalog_id: String, version: String },
    RepositoryCommit { repository: String, commit: String },
    RepositoryRelease { repository: String, release: String },
}

impl PinnedSource {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        match self {
            Self::LocalDirectory { path } => {
                if !is_absolute_executable(path) || path.contains(['\0', '\n', '\r']) {
                    return Err(ExtensionError::InvalidPinnedSource);
                }
            }
            Self::Catalog {
                catalog_id,
                version,
            } => {
                validate_identifier(catalog_id)?;
                validate_version(version)?;
            }
            Self::RepositoryCommit { repository, commit } => {
                validate_https_endpoint(repository)
                    .map_err(|_| ExtensionError::InvalidPinnedSource)?;
                if !matches!(commit.len(), 40 | 64)
                    || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err(ExtensionError::InvalidPinnedSource);
                }
            }
            Self::RepositoryRelease {
                repository,
                release,
            } => {
                validate_https_endpoint(repository)
                    .map_err(|_| ExtensionError::InvalidPinnedSource)?;
                if version_tuple(release, true).is_none() {
                    return Err(ExtensionError::InvalidPinnedSource);
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Provenance {
    pub source: PinnedSource,
    pub license: LicenseId,
    pub content_hash: Sha256Digest,
    pub signature: Option<String>,
}

impl Provenance {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        self.source.validate()?;
        if let Some(signature) = &self.signature
            && (!validate_plain_text(signature, 4096) || signature.chars().any(char::is_whitespace))
        {
            return Err(ExtensionError::InvalidSignature);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Compatibility {
    pub minimum_core_version: String,
    pub maximum_core_version: Option<String>,
}

impl Compatibility {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_version(&self.minimum_core_version)?;
        let minimum = version_tuple(&self.minimum_core_version, false)
            .ok_or(ExtensionError::InvalidCompatibility)?;
        if let Some(maximum) = &self.maximum_core_version {
            validate_version(maximum)?;
            if version_tuple(maximum, false).is_none_or(|maximum| maximum < minimum) {
                return Err(ExtensionError::InvalidCompatibility);
            }
        }
        Ok(())
    }
}

fn validate_profiles(profiles: &BTreeSet<String>) -> Result<(), ExtensionError> {
    profiles
        .iter()
        .try_for_each(|profile| validate_identifier(profile))
}

fn validate_refs(references: &[ResourceRef]) -> Result<(), ExtensionError> {
    if references.iter().collect::<BTreeSet<_>>().len() != references.len() {
        return Err(ExtensionError::DuplicateIdentifier(
            "resource_reference".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillManifest {
    pub schema_version: u16,
    pub id: String,
    pub version: String,
    pub provenance: Provenance,
    pub compatibility: Compatibility,
    #[serde(default)]
    pub enabled_profiles: BTreeSet<String>,
    pub procedure: ResourceRef,
    #[serde(default)]
    pub prompt_references: Vec<ResourceRef>,
    #[serde(default)]
    pub schema_references: Vec<ResourceRef>,
    #[serde(default)]
    pub template_references: Vec<ResourceRef>,
    #[serde(default)]
    pub requested_permissions: PermissionSet,
}

impl SkillManifest {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_common(
            self.schema_version,
            &self.id,
            &self.version,
            &self.provenance,
            &self.compatibility,
            &self.enabled_profiles,
        )?;
        validate_refs(&self.prompt_references)?;
        validate_refs(&self.schema_references)?;
        validate_refs(&self.template_references)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolManifest {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input_schema: ResourceRef,
    #[serde(default)]
    pub required_permissions: PermissionSet,
}

impl ToolManifest {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_identifier(&self.id)?;
        if !validate_plain_text(&self.name, 160) || !validate_plain_text(&self.description, 4096) {
            return Err(ExtensionError::InvalidIdentifier(self.id.clone()));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxPolicy {
    pub max_runtime_ms: u64,
    pub max_output_bytes: u64,
    pub allow_network: bool,
    #[serde(default)]
    pub allowed_paths: BTreeSet<String>,
}

impl SandboxPolicy {
    fn validate(&self, permissions: &PermissionSet) -> Result<(), ExtensionError> {
        if self.max_runtime_ms == 0
            || self.max_runtime_ms > 3_600_000
            || self.max_output_bytes == 0
            || self.max_output_bytes > 64 * 1024 * 1024
            || (self.allow_network && !permissions.has_namespace("network:"))
            || self
                .allowed_paths
                .iter()
                .any(|path| !is_absolute_executable(path) || path.contains(['\0', '\n', '\r']))
        {
            return Err(ExtensionError::InvalidSandbox);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct McpServerManifest {
    pub schema_version: u16,
    pub id: String,
    pub version: String,
    pub provenance: Provenance,
    pub compatibility: Compatibility,
    #[serde(default)]
    pub enabled_profiles: BTreeSet<String>,
    #[serde(default)]
    pub requested_permissions: PermissionSet,
    #[serde(default)]
    pub secret_references: BTreeSet<String>,
    pub transport: McpTransport,
    pub sandbox: SandboxPolicy,
    #[serde(default)]
    pub tools: Vec<ToolManifest>,
}

impl McpServerManifest {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_common(
            self.schema_version,
            &self.id,
            &self.version,
            &self.provenance,
            &self.compatibility,
            &self.enabled_profiles,
        )?;
        self.transport.validate()?;
        match &self.transport {
            McpTransport::Stdio(_) if !self.requested_permissions.contains_id("process:spawn") => {
                return Err(ExtensionError::HiddenPermission("process:spawn".into()));
            }
            McpTransport::RemoteHttps(_)
                if !self.requested_permissions.has_namespace("network:") =>
            {
                return Err(ExtensionError::HiddenPermission("network:*".into()));
            }
            McpTransport::Stdio(_) | McpTransport::RemoteHttps(_) => {}
        }
        self.sandbox.validate(&self.requested_permissions)?;
        for reference in &self.secret_references {
            validate_identifier(reference)?;
            if !reference.starts_with("secret:") {
                return Err(ExtensionError::InvalidSecretReference);
            }
        }
        let mut tool_ids = BTreeSet::new();
        for tool in &self.tools {
            tool.validate()?;
            if !tool_ids.insert(&tool.id) {
                return Err(ExtensionError::DuplicateIdentifier(tool.id.clone()));
            }
            ensure_permissions_declared(
                &tool.required_permissions,
                &self.requested_permissions,
                &tool.id,
            )?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterManifest {
    pub id: String,
    pub config_schema: ResourceRef,
    #[serde(default)]
    pub requested_permissions: PermissionSet,
}

impl AdapterManifest {
    fn validate(&self) -> Result<(), ExtensionError> {
        validate_identifier(&self.id)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PluginManifest {
    pub schema_version: u16,
    pub id: String,
    pub version: String,
    pub provenance: Provenance,
    pub compatibility: Compatibility,
    #[serde(default)]
    pub enabled_profiles: BTreeSet<String>,
    #[serde(default)]
    pub requested_permissions: PermissionSet,
    #[serde(default)]
    pub skills: Vec<SkillManifest>,
    #[serde(default)]
    pub mcp_servers: Vec<McpServerManifest>,
    #[serde(default)]
    pub adapters: Vec<AdapterManifest>,
    #[serde(default)]
    pub ui: Vec<UiContribution>,
}

impl PluginManifest {
    pub fn validate(&self) -> Result<(), ExtensionError> {
        validate_common(
            self.schema_version,
            &self.id,
            &self.version,
            &self.provenance,
            &self.compatibility,
            &self.enabled_profiles,
        )?;
        let mut component_ids = BTreeSet::new();
        for skill in &self.skills {
            skill.validate()?;
            validate_child(
                &skill.id,
                &skill.enabled_profiles,
                &skill.requested_permissions,
                self,
                &mut component_ids,
            )?;
        }
        let mut tool_ids = BTreeSet::new();
        for server in &self.mcp_servers {
            server.validate()?;
            validate_child(
                &server.id,
                &server.enabled_profiles,
                &server.requested_permissions,
                self,
                &mut component_ids,
            )?;
            for tool in &server.tools {
                if !tool_ids.insert(&tool.id) {
                    return Err(ExtensionError::DuplicateIdentifier(tool.id.clone()));
                }
            }
        }
        for adapter in &self.adapters {
            adapter.validate()?;
            if !component_ids.insert(adapter.id.clone()) {
                return Err(ExtensionError::DuplicateIdentifier(adapter.id.clone()));
            }
            ensure_permissions_declared(
                &adapter.requested_permissions,
                &self.requested_permissions,
                &adapter.id,
            )?;
        }
        let mut ui_ids = BTreeSet::new();
        for contribution in &self.ui {
            contribution.validate()?;
            if !ui_ids.insert(&contribution.id) {
                return Err(ExtensionError::DuplicateIdentifier(contribution.id.clone()));
            }
            for action in &contribution.actions {
                if let Some(tool_id) = &action.tool_id
                    && !tool_ids.contains(tool_id)
                {
                    return Err(ExtensionError::UnknownTool(tool_id.clone()));
                }
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn tool_ids(&self) -> BTreeSet<String> {
        self.mcp_servers
            .iter()
            .flat_map(|server| server.tools.iter().map(|tool| tool.id.clone()))
            .collect()
    }
}

fn validate_common(
    schema_version: u16,
    id: &str,
    version: &str,
    provenance: &Provenance,
    compatibility: &Compatibility,
    profiles: &BTreeSet<String>,
) -> Result<(), ExtensionError> {
    if schema_version != 1 {
        return Err(ExtensionError::InvalidSchemaVersion);
    }
    validate_identifier(id)?;
    validate_version(version)?;
    provenance.validate()?;
    compatibility.validate()?;
    validate_profiles(profiles)
}

fn validate_child(
    id: &str,
    profiles: &BTreeSet<String>,
    permissions: &PermissionSet,
    package: &PluginManifest,
    component_ids: &mut BTreeSet<String>,
) -> Result<(), ExtensionError> {
    if !component_ids.insert(id.to_owned()) {
        return Err(ExtensionError::DuplicateIdentifier(id.to_owned()));
    }
    if !profiles.is_subset(&package.enabled_profiles) {
        return Err(ExtensionError::InvalidCompatibility);
    }
    ensure_permissions_declared(permissions, &package.requested_permissions, id)
}

fn ensure_permissions_declared(
    requested: &PermissionSet,
    declared: &PermissionSet,
    component: &str,
) -> Result<(), ExtensionError> {
    if requested.is_subset(declared) {
        return Ok(());
    }
    let hidden = requested.difference(declared).iter().next().map_or_else(
        || component.to_owned(),
        |permission| permission.as_str().to_owned(),
    );
    Err(ExtensionError::HiddenPermission(hidden))
}
