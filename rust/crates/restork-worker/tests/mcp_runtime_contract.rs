use std::collections::{BTreeMap, BTreeSet};

use restork_extension::{
    EnvironmentPolicy, McpTransport, PermissionSet, ResolvedToolCall, SandboxPolicy, Sha256Digest,
    StdioDefinition,
};
use restork_worker::execute_stdio_mcp;
use serde_json::json;

#[tokio::test]
async fn reviewed_stdio_mcp_uses_json_rpc_without_shell_or_ambient_environment() {
    let call = ResolvedToolCall {
        session_id: "session-mcp".to_owned(),
        catalog_fingerprint: Sha256Digest::parse("a".repeat(64)).expect("catalog hash"),
        real_tool_id: "papers.search".to_owned(),
        package_id: "paper-mcp".to_owned(),
        package_version: "1.0.0".to_owned(),
        package_hash: Sha256Digest::parse("b".repeat(64)).expect("package hash"),
        server_id: "paper-mcp".to_owned(),
        transport: McpTransport::Stdio(StdioDefinition {
            executable: env!("CARGO_BIN_EXE_restork-mcp-fixture").to_owned(),
            argv: Vec::new(),
            environment: EnvironmentPolicy::isolated(),
        }),
        secret_references: BTreeSet::new(),
        sandbox: SandboxPolicy {
            // This budget must survive a full-workspace `cargo test`, where many
            // test binaries compete for CPU. The fixture spawns a real process
            // and, on macOS, wraps it in `sandbox-exec` before a JSON-RPC
            // handshake; 2_000 ms passed in isolation and failed roughly one run
            // in three under load. Production callers set their own budget.
            max_runtime_ms: 30_000,
            max_output_bytes: 64 * 1024,
            allow_network: false,
            allowed_paths: BTreeSet::new(),
        },
        required_permissions: PermissionSet::from_ids(["process:spawn"]).expect("permission"),
        input: json!({"query": "memory-safe agents"}),
    };

    let output = execute_stdio_mcp(&call, &BTreeMap::new())
        .await
        .expect("MCP output");
    assert_eq!(output.protocol_version, "2025-06-18");
    assert_eq!(output.content["content"][0]["text"], "memory-safe agents");
    assert_eq!(output.content["ambientHomeInherited"], false);
    assert!(output.output_is_untrusted);
    let working_directory = output.content["workingDirectory"]
        .as_str()
        .expect("fixture reports its isolated working directory");
    let leaf = std::path::Path::new(working_directory)
        .file_name()
        .and_then(std::ffi::OsStr::to_str)
        .expect("working directory has a UTF-8 leaf");
    assert!(leaf.starts_with("restork-mcp-"));
    assert_ne!(leaf, "shared-root");
    assert!(!std::path::Path::new(working_directory).exists());
}
