use std::collections::{BTreeMap, BTreeSet};

use restork_extension::{
    AdapterManifest, Compatibility, EnvironmentPolicy, EvidenceError, InstallPreview,
    Last30DaysEvidence, Last30DaysValidator, LicenseId, McpServerManifest, McpTransport,
    PackageStatus, PermissionSet, PinnedSource, PluginManifest, Provenance, QuarantineReason,
    RemoteDefinition, ResourceRef, SandboxPolicy, Sha256Digest, SkillManifest, SourceGrant,
    StdioDefinition, ToolDescriptor, ToolManifest, ToolRegistry, UiAction, UiContribution,
    UiLocation, UpdateDiff, resolve_effective_grant,
};
use serde_json::json;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn permissions(values: &[&str]) -> PermissionSet {
    PermissionSet::from_ids(values.iter().copied()).expect("valid permission fixture")
}

fn provenance(hash: &str) -> Provenance {
    Provenance {
        source: PinnedSource::RepositoryCommit {
            repository: "https://github.com/example/restork-extension".into(),
            commit: "0123456789abcdef0123456789abcdef01234567".into(),
        },
        license: LicenseId::parse("MIT").expect("valid license"),
        content_hash: Sha256Digest::parse(hash).expect("valid hash"),
        signature: None,
    }
}

fn compatibility() -> Compatibility {
    Compatibility {
        minimum_core_version: "0.1.0".into(),
        maximum_core_version: Some("0.9.99".into()),
    }
}

fn stdio() -> StdioDefinition {
    StdioDefinition {
        executable: "/opt/restork/bin/paper-mcp".into(),
        argv: vec!["serve".into(), "--stdio".into()],
        environment: EnvironmentPolicy {
            inherit: false,
            variables: BTreeMap::from([("LANG".into(), "C.UTF-8".into())]),
        },
    }
}

fn tool(id: &str, required: &[&str]) -> ToolManifest {
    ToolManifest {
        id: id.into(),
        name: "Search papers".into(),
        description: "Search an explicitly granted source catalog.".into(),
        input_schema: ResourceRef::parse("schemas/search-input.json").expect("schema ref"),
        required_permissions: permissions(required),
    }
}

fn server(tools: Vec<ToolManifest>, requested: &[&str]) -> McpServerManifest {
    let requested_permissions = permissions(requested);
    let transport = if requested.contains(&"process:spawn") {
        McpTransport::Stdio(stdio())
    } else {
        McpTransport::RemoteHttps(RemoteDefinition {
            endpoint: "https://papers.example.test/mcp".into(),
            oauth_profile: Some("oauth:paper-catalog".into()),
        })
    };
    McpServerManifest {
        schema_version: 1,
        id: "paper-mcp".into(),
        version: "1.2.3".into(),
        provenance: provenance(HASH_A),
        compatibility: compatibility(),
        enabled_profiles: BTreeSet::from(["research-cloud".into()]),
        requested_permissions,
        secret_references: BTreeSet::from(["secret:provider/papers".into()]),
        transport,
        sandbox: SandboxPolicy {
            max_runtime_ms: 30_000,
            max_output_bytes: 1_000_000,
            allow_network: true,
            allowed_paths: BTreeSet::new(),
        },
        tools,
    }
}

fn skill(requested: &[&str]) -> SkillManifest {
    SkillManifest {
        schema_version: 1,
        id: "paper-review".into(),
        version: "1.2.3".into(),
        provenance: provenance(HASH_A),
        compatibility: compatibility(),
        enabled_profiles: BTreeSet::from(["research-cloud".into()]),
        procedure: ResourceRef::parse("skills/paper-review.md").expect("procedure ref"),
        prompt_references: vec![ResourceRef::parse("prompts/review.md").expect("prompt ref")],
        schema_references: vec![
            ResourceRef::parse("schemas/review-output.json").expect("schema ref"),
        ],
        template_references: vec![ResourceRef::parse("templates/review.md").expect("template ref")],
        requested_permissions: permissions(requested),
    }
}

fn ui() -> UiContribution {
    UiContribution {
        id: "paper-status".into(),
        location: UiLocation::ExtensionStatus,
        title_key: "extension.paper_status.title".into(),
        description_key: "extension.paper_status.description".into(),
        actions: vec![UiAction {
            id: "search".into(),
            label_key: "extension.paper_status.search".into(),
            tool_id: Some("papers.search".into()),
        }],
    }
}

fn plugin(requested: &[&str], tools: Vec<ToolManifest>) -> PluginManifest {
    PluginManifest {
        schema_version: 1,
        id: "paper-suite".into(),
        version: "1.2.3".into(),
        provenance: provenance(HASH_A),
        compatibility: compatibility(),
        enabled_profiles: BTreeSet::from(["research-cloud".into()]),
        requested_permissions: permissions(requested),
        skills: vec![skill(requested)],
        mcp_servers: vec![server(tools, requested)],
        adapters: vec![AdapterManifest {
            id: "paper-normalizer".into(),
            config_schema: ResourceRef::parse("schemas/adapter.json").expect("adapter schema"),
            requested_permissions: PermissionSet::default(),
        }],
        ui: vec![ui()],
    }
}

#[test]
fn declarative_manifests_require_pinned_source_license_hash_and_narrow_authority() {
    let manifest = plugin(
        &["network:papers", "process:spawn"],
        vec![tool("papers.search", &["network:papers"])],
    );
    manifest.validate().expect("fully pinned manifest");

    let mut unpinned = manifest.clone();
    unpinned.provenance.source = PinnedSource::RepositoryRelease {
        repository: "https://github.com/example/restork-extension".into(),
        release: "latest".into(),
    };
    assert!(unpinned.validate().is_err());

    let mut hidden_permission = manifest;
    hidden_permission.mcp_servers[0].tools[0].required_permissions = permissions(&["vault:write"]);
    assert!(hidden_permission.validate().is_err());
}

#[test]
fn stdio_is_exact_isolated_and_never_a_shell_or_dynamic_npx_bootstrap() {
    stdio().validate().expect("exact executable and argv");

    let mut inherited = stdio();
    inherited.environment.inherit = true;
    assert!(inherited.validate().is_err());

    let mut shell = stdio();
    shell.executable = "/bin/sh".into();
    assert!(shell.validate().is_err());

    let mut interpolation = stdio();
    interpolation.argv = vec!["${PRIVATE_PATH}".into()];
    assert!(interpolation.validate().is_err());

    let dynamic = StdioDefinition {
        executable: "/opt/homebrew/bin/npx".into(),
        argv: vec!["-y".into(), "some-mcp@latest".into()],
        environment: EnvironmentPolicy::isolated(),
    };
    assert!(dynamic.validate().is_err());

    let mut undeclared_spawn = server(
        vec![tool("papers.search", &["network:papers"])],
        &["network:papers", "process:spawn"],
    );
    undeclared_spawn.requested_permissions = permissions(&["network:papers"]);
    assert!(undeclared_spawn.validate().is_err());
}

#[test]
fn remote_mcp_requires_credential_free_https_and_reviewed_auth_reference() {
    RemoteDefinition {
        endpoint: "https://mcp.example.test/v1".into(),
        oauth_profile: Some("oauth:paper-catalog".into()),
    }
    .validate()
    .expect("valid HTTPS MCP endpoint");

    for endpoint in [
        "http://mcp.example.test/v1",
        "https://user:password@mcp.example.test/v1",
        "https://mcp.example.test/v1?token=secret",
    ] {
        assert!(
            RemoteDefinition {
                endpoint: endpoint.into(),
                oauth_profile: None,
            }
            .validate()
            .is_err(),
            "{endpoint}"
        );
    }

    let mut undeclared_network = server(
        vec![tool("papers.search", &["network:papers"])],
        &["network:papers"],
    );
    undeclared_network.requested_permissions = PermissionSet::default();
    undeclared_network.sandbox.allow_network = false;
    assert!(undeclared_network.validate().is_err());
}

#[test]
fn effective_grant_is_the_exact_four_layer_intersection() {
    let decision = resolve_effective_grant(
        &permissions(&[
            "network:papers",
            "process:spawn",
            "vault:read",
            "vault:write",
        ]),
        &permissions(&["network:papers", "process:spawn", "vault:read"]),
        &permissions(&["network:papers", "process:spawn", "vault:write"]),
        &permissions(&["network:papers", "vault:read", "vault:write"]),
    );

    assert_eq!(decision.granted(), &permissions(&["network:papers"]));
    assert_eq!(
        decision.denied_from_package(),
        &permissions(&["process:spawn", "vault:write"])
    );
}

#[test]
fn install_and_update_are_quarantined_and_show_authority_diff() {
    let old = plugin(
        &["network:papers"],
        vec![tool("papers.search", &["network:papers"])],
    );
    let preview = InstallPreview::build(
        &old,
        &permissions(&["network:papers", "process:spawn"]),
        &permissions(&["network:papers", "process:spawn"]),
        &permissions(&["network:papers"]),
    )
    .expect("install preview");
    assert_eq!(
        preview.status,
        PackageStatus::Quarantined(QuarantineReason::AwaitingInstallReview)
    );
    assert_eq!(
        preview.effective_permissions,
        permissions(&["network:papers"])
    );

    let mut next = plugin(
        &["network:papers", "process:spawn"],
        vec![
            tool("papers.search", &["network:papers"]),
            tool("papers.fetch", &["network:papers"]),
        ],
    );
    next.version = "1.3.0".into();
    next.provenance.content_hash = Sha256Digest::parse(HASH_B).expect("new hash");

    let diff = UpdateDiff::between(&old, &next).expect("reviewable update diff");
    assert_eq!(
        diff.status,
        PackageStatus::Quarantined(QuarantineReason::AwaitingUpdateReview)
    );
    assert_eq!(diff.added_permissions, permissions(&["process:spawn"]));
    assert_eq!(diff.added_tools, BTreeSet::from(["papers.fetch".into()]));
    assert!(diff.content_hash_changed);
    assert!(diff.requires_review());
}

#[test]
fn declarative_ui_rejects_unknown_html_and_javascript_shaped_values() {
    let with_html = json!({
        "id": "unsafe",
        "location": "extension_status",
        "title_key": "extension.unsafe.title",
        "description_key": "extension.unsafe.description",
        "actions": [],
        "html": "<script>alert(1)</script>"
    });
    assert!(serde_json::from_value::<UiContribution>(with_html).is_err());

    let mut unsafe_key = ui();
    unsafe_key.title_key = "<script>alert(1)</script>".into();
    assert!(unsafe_key.validate().is_err());
}

#[test]
fn a_frozen_session_catalog_never_expands_and_resolves_the_real_tool() {
    let search_tool = tool("papers.search", &["network:papers"]);
    let fetch_tool = tool("papers.fetch", &["network:papers", "vault:write"]);
    let transport = McpTransport::RemoteHttps(RemoteDefinition {
        endpoint: "https://papers.example.test/mcp".into(),
        oauth_profile: Some("oauth:paper-catalog".into()),
    });
    let mut registry = ToolRegistry::new();
    registry
        .register_plugin(&plugin(&["network:papers"], vec![search_tool]))
        .expect("register pinned plugin tools");
    registry
        .register(ToolDescriptor {
            package_id: "paper-suite".into(),
            package_version: "1.2.3".into(),
            package_hash: Sha256Digest::parse(HASH_A).expect("package hash"),
            server_id: "paper-mcp".into(),
            server_permissions: permissions(&["network:papers", "vault:write"]),
            manifest: fetch_tool,
            transport: transport.clone(),
        })
        .expect("register fetch");

    let allowed = BTreeSet::from(["papers.search".into(), "papers.fetch".into()]);
    let frozen = registry
        .freeze_session("session-001", &allowed, &permissions(&["network:papers"]))
        .expect("freeze catalog");
    assert_eq!(frozen.search("papers", 10).expect("search").len(), 1);
    assert!(frozen.describe("papers.fetch").is_err());

    registry
        .register(ToolDescriptor {
            package_id: "paper-suite".into(),
            package_version: "1.2.3".into(),
            package_hash: Sha256Digest::parse(HASH_A).expect("package hash"),
            server_id: "paper-mcp".into(),
            server_permissions: permissions(&["network:papers"]),
            manifest: tool("papers.citations", &["network:papers"]),
            transport,
        })
        .expect("registry can change after freeze");
    assert!(frozen.describe("papers.citations").is_err());

    let resolved = frozen
        .resolve_call("papers.search", json!({"query": "agent memory"}))
        .expect("resolve call without executing it");
    assert_eq!(resolved.real_tool_id, "papers.search");
    assert_eq!(resolved.server_id, "paper-mcp");
    assert!(resolved.output_is_untrusted());
    assert!(
        frozen
            .resolve_call("papers.search", json!(["not", "an", "object"]))
            .is_err()
    );
}

#[test]
fn last_30_days_requires_recent_timestamps_and_source_specific_https_evidence() {
    let now = OffsetDateTime::parse("2026-08-02T12:00:00Z", &Rfc3339).expect("now");
    let validator = Last30DaysValidator::new(
        now,
        vec![SourceGrant::new("papers", "https://papers.example.test/research/").expect("grant")],
    )
    .expect("validator");
    let evidence = Last30DaysEvidence {
        evidence_id: "evidence-001".into(),
        source_id: "papers".into(),
        source_url: "https://papers.example.test/research/agent-memory".into(),
        title: "A synthetic paper".into(),
        published_at: "2026-07-15T09:00:00Z".into(),
        retrieved_at: "2026-08-02T10:00:00Z".into(),
        content_hash: Sha256Digest::parse(HASH_A).expect("hash"),
    };
    let validated = validator
        .validate(std::slice::from_ref(&evidence))
        .expect("recent source evidence");
    assert_eq!(validated.len(), 1);

    let mut old = evidence.clone();
    old.published_at = (now - Duration::days(31))
        .format(&Rfc3339)
        .expect("old timestamp");
    assert_eq!(
        validator.validate(&[old]),
        Err(EvidenceError::OutsideWindow)
    );

    let mut wrong_source = evidence;
    wrong_source.source_url = "https://evil.example/research/agent-memory".into();
    assert_eq!(
        validator.validate(&[wrong_source]),
        Err(EvidenceError::SourceUrlNotGranted)
    );
}
