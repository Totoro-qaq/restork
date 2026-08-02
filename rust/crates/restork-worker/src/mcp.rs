use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};

use restork_extension::{McpTransport, ResolvedToolCall, SandboxPolicy, StdioDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct McpExecutionOutput {
    pub protocol_version: String,
    pub content: Value,
    pub is_error: bool,
    pub output_bytes: usize,
    pub isolation: String,
    pub output_is_untrusted: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpRuntimeError {
    UnsupportedTransport,
    MissingSecret,
    InvalidExecutable,
    SpawnFailed,
    ProtocolError,
    OversizedOutput,
    Timeout,
    ServerError,
}

impl McpRuntimeError {
    #[must_use]
    pub const fn code(self) -> &'static str {
        match self {
            Self::UnsupportedTransport => "unsupported_transport",
            Self::MissingSecret => "missing_secret",
            Self::InvalidExecutable => "invalid_executable",
            Self::SpawnFailed => "spawn_failed",
            Self::ProtocolError => "protocol_error",
            Self::OversizedOutput => "oversized_output",
            Self::Timeout => "timeout",
            Self::ServerError => "server_error",
        }
    }
}

/// Execute one reviewed, frozen MCP stdio call without a shell or ambient environment.
///
/// `secret_values` is intentionally supplied out-of-band and never appears in the
/// resolved call or returned value. Environment values equal to a declared
/// `secret:*` reference are replaced immediately before process creation.
pub async fn execute_stdio_mcp(
    execution_id: &str,
    call: &ResolvedToolCall,
    secret_values: &BTreeMap<String, String>,
) -> Result<McpExecutionOutput, McpRuntimeError> {
    let McpTransport::Stdio(definition) = &call.transport else {
        return Err(McpRuntimeError::UnsupportedTransport);
    };
    if call
        .secret_references
        .iter()
        .any(|reference| !secret_values.contains_key(reference))
    {
        return Err(McpRuntimeError::MissingSecret);
    }
    let executable = PathBuf::from(&definition.executable)
        .canonicalize()
        .map_err(|_| McpRuntimeError::InvalidExecutable)?;
    if !executable.is_file() {
        return Err(McpRuntimeError::InvalidExecutable);
    }
    let work_root = std::env::temp_dir()
        .join("restork-mcp")
        .join(safe_component(execution_id));
    tokio::fs::create_dir_all(&work_root)
        .await
        .map_err(|_| McpRuntimeError::SpawnFailed)?;

    let (mut command, isolation) = isolated_command(definition, &call.sandbox, &work_root)?;
    command
        .current_dir(&work_root)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    for (name, value) in &definition.environment.variables {
        let selected = secret_values
            .get(value)
            .map_or(value.as_str(), String::as_str);
        command.env(name, selected);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|_| McpRuntimeError::SpawnFailed)?;
    let result = timeout(
        Duration::from_millis(call.sandbox.max_runtime_ms),
        exchange(&mut child, call, &isolation),
    )
    .await;
    let output = match result {
        Ok(result) => result,
        Err(_) => {
            terminate(&mut child).await;
            Err(McpRuntimeError::Timeout)
        }
    };
    let _ = tokio::fs::remove_dir_all(&work_root).await;
    output
}

async fn exchange(
    child: &mut Child,
    call: &ResolvedToolCall,
    isolation: &str,
) -> Result<McpExecutionOutput, McpRuntimeError> {
    let mut stdin = child.stdin.take().ok_or(McpRuntimeError::SpawnFailed)?;
    let stdout = child.stdout.take().ok_or(McpRuntimeError::SpawnFailed)?;
    let mut reader = BufReader::new(stdout);
    write_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "restork", "version": env!("CARGO_PKG_VERSION")}
            }
        }),
    )
    .await?;
    let mut consumed = 0_usize;
    let initialize =
        read_response(&mut reader, 1, call.sandbox.max_output_bytes, &mut consumed).await?;
    if initialize.get("error").is_some() {
        terminate(child).await;
        return Err(McpRuntimeError::ServerError);
    }
    write_message(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}),
    )
    .await?;
    write_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": call.real_tool_id, "arguments": call.input}
        }),
    )
    .await?;
    let response =
        read_response(&mut reader, 2, call.sandbox.max_output_bytes, &mut consumed).await?;
    let _ = stdin.shutdown().await;
    if response.get("error").is_some() {
        terminate(child).await;
        return Err(McpRuntimeError::ServerError);
    }
    let result = response
        .get("result")
        .cloned()
        .ok_or(McpRuntimeError::ProtocolError)?;
    terminate(child).await;
    let is_error = result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Ok(McpExecutionOutput {
        protocol_version: initialize
            .pointer("/result/protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or("2025-06-18")
            .to_owned(),
        content: result,
        is_error,
        output_bytes: consumed,
        isolation: isolation.to_owned(),
        output_is_untrusted: true,
    })
}

async fn write_message(
    writer: &mut tokio::process::ChildStdin,
    value: &Value,
) -> Result<(), McpRuntimeError> {
    let mut encoded = serde_json::to_vec(value).map_err(|_| McpRuntimeError::ProtocolError)?;
    encoded.push(b'\n');
    writer
        .write_all(&encoded)
        .await
        .map_err(|_| McpRuntimeError::ProtocolError)?;
    writer
        .flush()
        .await
        .map_err(|_| McpRuntimeError::ProtocolError)
}

async fn read_response(
    reader: &mut BufReader<tokio::process::ChildStdout>,
    expected_id: i64,
    maximum: u64,
    consumed: &mut usize,
) -> Result<Value, McpRuntimeError> {
    let maximum = usize::try_from(maximum).map_err(|_| McpRuntimeError::OversizedOutput)?;
    loop {
        let remaining = maximum.saturating_sub(*consumed);
        if remaining == 0 {
            return Err(McpRuntimeError::OversizedOutput);
        }
        let mut line = String::new();
        let read = (&mut *reader)
            .take(u64::try_from(remaining + 1).unwrap_or(u64::MAX))
            .read_line(&mut line)
            .await
            .map_err(|_| McpRuntimeError::ProtocolError)?;
        if read == 0 {
            return Err(McpRuntimeError::ProtocolError);
        }
        *consumed = consumed.saturating_add(read);
        if *consumed > maximum {
            return Err(McpRuntimeError::OversizedOutput);
        }
        let message: Value =
            serde_json::from_str(line.trim_end()).map_err(|_| McpRuntimeError::ProtocolError)?;
        if message.get("id").and_then(Value::as_i64) == Some(expected_id) {
            return Ok(message);
        }
    }
}

#[cfg(target_os = "macos")]
fn isolated_command(
    definition: &StdioDefinition,
    policy: &SandboxPolicy,
    work_root: &std::path::Path,
) -> Result<(Command, String), McpRuntimeError> {
    let mut profile = format!(
        "(version 1)(allow default)(deny file-write*)(allow file-write* (subpath \"{}\"))",
        escape_profile(&work_root.to_string_lossy())
    );
    for path in &policy.allowed_paths {
        profile.push_str(&format!(
            "(allow file-write* (subpath \"{}\"))",
            escape_profile(path)
        ));
    }
    if !policy.allow_network {
        profile.push_str("(deny network*)");
    }
    let mut command = Command::new("/usr/bin/sandbox-exec");
    command
        .args(["-p", &profile, "--", &definition.executable])
        .args(&definition.argv);
    Ok((command, "macos-seatbelt".to_owned()))
}

#[cfg(target_os = "linux")]
fn isolated_command(
    definition: &StdioDefinition,
    policy: &SandboxPolicy,
    work_root: &std::path::Path,
) -> Result<(Command, String), McpRuntimeError> {
    let bwrap = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"]
        .into_iter()
        .find(|path| std::path::Path::new(path).is_file());
    if let Some(bwrap) = bwrap {
        let mut command = Command::new(bwrap);
        command.args(["--die-with-parent", "--new-session", "--ro-bind", "/", "/"]);
        if !policy.allow_network {
            command.arg("--unshare-net");
        }
        command
            .args([
                "--bind",
                &work_root.to_string_lossy(),
                &work_root.to_string_lossy(),
            ])
            .args([
                "--chdir",
                &work_root.to_string_lossy(),
                "--",
                &definition.executable,
            ])
            .args(&definition.argv);
        return Ok((command, "linux-bubblewrap".to_owned()));
    }
    let mut command = Command::new(&definition.executable);
    command.args(&definition.argv);
    Ok((command, "process-boundary".to_owned()))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn isolated_command(
    definition: &StdioDefinition,
    _policy: &SandboxPolicy,
    _work_root: &std::path::Path,
) -> Result<(Command, String), McpRuntimeError> {
    let mut command = Command::new(&definition.executable);
    command.args(&definition.argv);
    Ok((command, "process-boundary".to_owned()))
}

async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(process_id) = child.id() {
        // SAFETY: the child is the leader of a process group created above.
        let _ = unsafe { libc::kill(-(process_id as i32), libc::SIGKILL) };
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn safe_component(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(128)
        .collect()
}

#[cfg(target_os = "macos")]
fn escape_profile(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}
