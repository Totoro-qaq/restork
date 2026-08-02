use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::{
    ExtensionError, McpTransport, PermissionSet, PluginManifest, SandboxPolicy, Sha256Digest,
    ToolManifest,
    validation::{validate_identifier, validate_plain_text, validate_version},
};

const MAX_TOOL_INPUT_BYTES: usize = 1024 * 1024;

/// Fully resolved tool metadata retained by Core, not executable behavior.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ToolDescriptor {
    pub package_id: String,
    pub package_version: String,
    pub package_hash: Sha256Digest,
    pub server_id: String,
    pub server_permissions: PermissionSet,
    pub secret_references: BTreeSet<String>,
    pub sandbox: SandboxPolicy,
    pub manifest: ToolManifest,
    pub transport: McpTransport,
}

impl ToolDescriptor {
    fn validate(&self) -> Result<(), ExtensionError> {
        validate_identifier(&self.package_id)?;
        validate_version(&self.package_version)?;
        validate_identifier(&self.server_id)?;
        self.manifest.validate()?;
        self.transport.validate()?;
        self.sandbox.validate(&self.server_permissions)?;
        for reference in &self.secret_references {
            validate_identifier(reference)?;
            if !reference.starts_with("secret:") {
                return Err(ExtensionError::InvalidSecretReference);
            }
        }
        if !self
            .manifest
            .required_permissions
            .is_subset(&self.server_permissions)
        {
            return Err(ExtensionError::HiddenPermission(self.manifest.id.clone()));
        }
        match &self.transport {
            McpTransport::Stdio(_) if !self.server_permissions.contains_id("process:spawn") => {
                Err(ExtensionError::HiddenPermission("process:spawn".into()))
            }
            McpTransport::RemoteHttps(_) if !self.server_permissions.has_namespace("network:") => {
                Err(ExtensionError::HiddenPermission("network:*".into()))
            }
            McpTransport::Stdio(_) | McpTransport::RemoteHttps(_) => Ok(()),
        }
    }
}

#[derive(Default)]
pub struct ToolRegistry {
    revision: u64,
    tools: BTreeMap<String, ToolDescriptor>,
}

impl ToolRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, descriptor: ToolDescriptor) -> Result<(), ExtensionError> {
        descriptor.validate()?;
        let id = descriptor.manifest.id.clone();
        if self.tools.contains_key(&id) {
            return Err(ExtensionError::DuplicateIdentifier(id));
        }
        self.tools.insert(id, descriptor);
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    /// Atomically register every tool from one validated, pinned plugin snapshot.
    pub fn register_plugin(&mut self, plugin: &PluginManifest) -> Result<(), ExtensionError> {
        plugin.validate()?;
        let descriptors = plugin
            .mcp_servers
            .iter()
            .flat_map(|server| {
                server.tools.iter().map(|tool| ToolDescriptor {
                    package_id: plugin.id.clone(),
                    package_version: plugin.version.clone(),
                    package_hash: plugin.provenance.content_hash.clone(),
                    server_id: server.id.clone(),
                    server_permissions: server.requested_permissions.clone(),
                    secret_references: server.secret_references.clone(),
                    sandbox: server.sandbox.clone(),
                    manifest: tool.clone(),
                    transport: server.transport.clone(),
                })
            })
            .collect::<Vec<_>>();
        for descriptor in &descriptors {
            descriptor.validate()?;
            if self.tools.contains_key(&descriptor.manifest.id) {
                return Err(ExtensionError::DuplicateIdentifier(
                    descriptor.manifest.id.clone(),
                ));
            }
        }
        for descriptor in descriptors {
            self.tools
                .insert(descriptor.manifest.id.clone(), descriptor);
        }
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn freeze_session(
        &self,
        session_id: &str,
        allowed_tool_ids: &BTreeSet<String>,
        effective_grant: &PermissionSet,
    ) -> Result<FrozenToolCatalog, ExtensionError> {
        validate_identifier(session_id)?;
        let tools = allowed_tool_ids
            .iter()
            .filter_map(|tool_id| {
                self.tools
                    .get(tool_id)
                    .filter(|descriptor| descriptor.server_permissions.is_subset(effective_grant))
            })
            .map(|descriptor| (descriptor.manifest.id.clone(), descriptor.clone()))
            .collect::<BTreeMap<_, _>>();
        let fingerprint = catalog_fingerprint(session_id, self.revision, &tools)?;
        Ok(FrozenToolCatalog {
            session_id: session_id.to_owned(),
            source_revision: self.revision,
            fingerprint,
            tools,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrozenToolCatalog {
    session_id: String,
    source_revision: u64,
    fingerprint: Sha256Digest,
    tools: BTreeMap<String, ToolDescriptor>,
}

impl FrozenToolCatalog {
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub const fn source_revision(&self) -> u64 {
        self.source_revision
    }

    #[must_use]
    pub const fn fingerprint(&self) -> &Sha256Digest {
        &self.fingerprint
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<ToolSearchHit>, ExtensionError> {
        let query = query.trim().to_lowercase();
        if !validate_plain_text(&query, 512) || !(1..=50).contains(&limit) {
            return Err(ExtensionError::InvalidSearch);
        }
        let terms = query.split_whitespace().collect::<Vec<_>>();
        let mut hits = self
            .tools
            .values()
            .filter_map(|descriptor| {
                let id = descriptor.manifest.id.to_lowercase();
                let name = descriptor.manifest.name.to_lowercase();
                let description = descriptor.manifest.description.to_lowercase();
                let score = terms.iter().fold(0_u32, |score, term| {
                    score
                        + u32::from(id == *term) * 1000
                        + u32::from(id.contains(term)) * 160
                        + u32::from(name.contains(term)) * 100
                        + u32::from(description.contains(term)) * 40
                });
                (score > 0).then(|| ToolSearchHit {
                    tool_id: descriptor.manifest.id.clone(),
                    name: descriptor.manifest.name.clone(),
                    score,
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            right
                .score
                .cmp(&left.score)
                .then_with(|| left.tool_id.cmp(&right.tool_id))
        });
        hits.truncate(limit);
        Ok(hits)
    }

    pub fn describe(&self, tool_id: &str) -> Result<&ToolDescriptor, ExtensionError> {
        self.tools
            .get(tool_id)
            .ok_or_else(|| ExtensionError::UnknownTool(tool_id.to_owned()))
    }

    pub fn resolve_call(
        &self,
        tool_id: &str,
        input: Value,
    ) -> Result<ResolvedToolCall, ExtensionError> {
        let descriptor = self.describe(tool_id)?;
        if !input.is_object()
            || serde_json::to_vec(&input)
                .map_err(|_| ExtensionError::InvalidToolInput)?
                .len()
                > MAX_TOOL_INPUT_BYTES
        {
            return Err(ExtensionError::InvalidToolInput);
        }
        Ok(ResolvedToolCall {
            session_id: self.session_id.clone(),
            catalog_fingerprint: self.fingerprint.clone(),
            real_tool_id: descriptor.manifest.id.clone(),
            package_id: descriptor.package_id.clone(),
            package_version: descriptor.package_version.clone(),
            package_hash: descriptor.package_hash.clone(),
            server_id: descriptor.server_id.clone(),
            transport: descriptor.transport.clone(),
            secret_references: descriptor.secret_references.clone(),
            sandbox: descriptor.sandbox.clone(),
            required_permissions: descriptor.server_permissions.clone(),
            input,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ToolSearchHit {
    pub tool_id: String,
    pub name: String,
    pub score: u32,
}

/// Resolved call metadata for the Harness. Execution is intentionally absent.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ResolvedToolCall {
    pub session_id: String,
    pub catalog_fingerprint: Sha256Digest,
    pub real_tool_id: String,
    pub package_id: String,
    pub package_version: String,
    pub package_hash: Sha256Digest,
    pub server_id: String,
    pub transport: McpTransport,
    pub secret_references: BTreeSet<String>,
    pub sandbox: SandboxPolicy,
    pub required_permissions: PermissionSet,
    pub input: Value,
}

impl ResolvedToolCall {
    /// MCP descriptions and outputs are always data, never policy or authority.
    #[must_use]
    pub const fn output_is_untrusted(&self) -> bool {
        true
    }
}

fn catalog_fingerprint(
    session_id: &str,
    revision: u64,
    tools: &BTreeMap<String, ToolDescriptor>,
) -> Result<Sha256Digest, ExtensionError> {
    let encoded = serde_json::to_vec(&(session_id, revision, tools))
        .map_err(|_| ExtensionError::InvalidToolInput)?;
    let digest = Sha256::digest(encoded);
    let mut encoded_digest = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded_digest.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded_digest.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Sha256Digest::parse(encoded_digest)
}
