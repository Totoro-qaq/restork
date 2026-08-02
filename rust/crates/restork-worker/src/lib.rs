//! Size-bounded framed protocol for optional capability workers.
//!
//! Workers receive no inherited environment, database handle, secret reference,
//! or network grant. The desktop supervisor owns the outer process tree; Unix
//! workers also receive a dedicated process group for per-request cleanup.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
    time::timeout,
};

const PROTOCOL_VERSION: u8 = 1;
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerLimits {
    pub timeout_ms: u64,
    pub max_request_bytes: usize,
    pub max_response_bytes: usize,
}

impl WorkerLimits {
    pub fn bounded(
        timeout_ms: u64,
        max_request_bytes: usize,
        max_response_bytes: usize,
    ) -> Result<Self, WorkerError> {
        if !(100..=3_600_000).contains(&timeout_ms)
            || !(1..=MAX_FRAME_BYTES).contains(&max_request_bytes)
            || !(1..=MAX_FRAME_BYTES).contains(&max_response_bytes)
        {
            return Err(WorkerError::InvalidManifest);
        }
        Ok(Self {
            timeout_ms,
            max_request_bytes,
            max_response_bytes,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CapabilityManifest {
    pub capability_id: String,
    pub version: String,
    pub executable_hash: String,
    pub allowed_relative_paths: BTreeSet<String>,
    pub network_allowed: bool,
    pub secret_refs: BTreeSet<String>,
    pub limits: WorkerLimits,
}

impl CapabilityManifest {
    pub fn validate(&self) -> Result<(), WorkerError> {
        validate_identifier(&self.capability_id, 128)?;
        validate_identifier(&self.version, 64)?;
        validate_hash(&self.executable_hash)?;
        if self.network_allowed
            || !self.secret_refs.is_empty()
            || self.allowed_relative_paths.len() > 64
        {
            return Err(WorkerError::InvalidManifest);
        }
        for path in &self.allowed_relative_paths {
            validate_relative_path(path)?;
        }
        WorkerLimits::bounded(
            self.limits.timeout_ms,
            self.limits.max_request_bytes,
            self.limits.max_response_bytes,
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerRequest {
    pub protocol_version: u8,
    pub request_id: String,
    pub capability_id: String,
    pub capability_version: String,
    pub input: Value,
}

impl WorkerRequest {
    pub fn new(
        request_id: &str,
        manifest: &CapabilityManifest,
        input: Value,
    ) -> Result<Self, WorkerError> {
        manifest.validate()?;
        validate_identifier(request_id, 128)?;
        if !input.is_object() {
            return Err(WorkerError::InvalidRequest);
        }
        Ok(Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.to_owned(),
            capability_id: manifest.capability_id.clone(),
            capability_version: manifest.version.clone(),
            input,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerArtifact {
    pub kind: String,
    pub content_hash: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkerResponse {
    pub protocol_version: u8,
    pub request_id: String,
    pub status: String,
    pub artifact: Option<WorkerArtifact>,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerError {
    InvalidManifest,
    InvalidRequest,
    InvalidExecutable,
    SpawnFailed,
    Timeout,
    Crash,
    OversizedOutput,
    MalformedResponse,
    ResponseMismatch,
}

pub struct WorkerCommand {
    executable: PathBuf,
    arguments: Vec<String>,
    work_root: PathBuf,
}

impl WorkerCommand {
    pub fn new(
        executable: impl AsRef<Path>,
        arguments: Vec<String>,
        work_root: impl AsRef<Path>,
    ) -> Result<Self, WorkerError> {
        let executable = executable
            .as_ref()
            .canonicalize()
            .map_err(|_| WorkerError::InvalidExecutable)?;
        let work_root = work_root
            .as_ref()
            .canonicalize()
            .map_err(|_| WorkerError::InvalidManifest)?;
        if !executable.is_absolute()
            || !executable.is_file()
            || !work_root.is_absolute()
            || !work_root.is_dir()
            || arguments.len() > 64
            || arguments
                .iter()
                .any(|argument| argument.len() > 4_096 || argument.contains('\0'))
        {
            return Err(WorkerError::InvalidExecutable);
        }
        Ok(Self {
            executable,
            arguments,
            work_root,
        })
    }

    pub async fn execute(
        &self,
        manifest: &CapabilityManifest,
        request: &WorkerRequest,
    ) -> Result<WorkerResponse, WorkerError> {
        manifest.validate()?;
        validate_request_binding(manifest, request)?;
        let request_bytes = serde_json::to_vec(request).map_err(|_| WorkerError::InvalidRequest)?;
        if request_bytes.len() > manifest.limits.max_request_bytes {
            return Err(WorkerError::InvalidRequest);
        }
        let executable_hash = file_hash(&self.executable).await?;
        if executable_hash != manifest.executable_hash {
            return Err(WorkerError::InvalidExecutable);
        }
        let mut command = Command::new(&self.executable);
        command
            .args(&self.arguments)
            .current_dir(&self.work_root)
            .env_clear()
            .env("RESTORK_WORKER_PROTOCOL", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.as_std_mut().process_group(0);
        }
        let mut child = command.spawn().map_err(|_| WorkerError::SpawnFailed)?;
        let duration = Duration::from_millis(manifest.limits.timeout_ms);
        match timeout(
            duration,
            exchange(
                &mut child,
                &request_bytes,
                manifest.limits.max_response_bytes,
            ),
        )
        .await
        {
            Ok(result) => {
                let response = result?;
                validate_response(request, &response)?;
                Ok(response)
            }
            Err(_) => {
                terminate(&mut child).await;
                Err(WorkerError::Timeout)
            }
        }
    }
}

async fn exchange(
    child: &mut Child,
    request: &[u8],
    max_response_bytes: usize,
) -> Result<WorkerResponse, WorkerError> {
    let mut stdin = child.stdin.take().ok_or(WorkerError::SpawnFailed)?;
    let mut stdout = child.stdout.take().ok_or(WorkerError::SpawnFailed)?;
    let length = u32::try_from(request.len()).map_err(|_| WorkerError::InvalidRequest)?;
    stdin
        .write_all(&length.to_be_bytes())
        .await
        .map_err(|_| WorkerError::Crash)?;
    stdin
        .write_all(request)
        .await
        .map_err(|_| WorkerError::Crash)?;
    stdin.shutdown().await.map_err(|_| WorkerError::Crash)?;
    drop(stdin);

    let mut header = [0_u8; 4];
    stdout
        .read_exact(&mut header)
        .await
        .map_err(|_| WorkerError::MalformedResponse)?;
    let response_length =
        usize::try_from(u32::from_be_bytes(header)).map_err(|_| WorkerError::OversizedOutput)?;
    if response_length == 0 || response_length > max_response_bytes {
        terminate(child).await;
        return Err(WorkerError::OversizedOutput);
    }
    let mut response = vec![0_u8; response_length];
    stdout
        .read_exact(&mut response)
        .await
        .map_err(|_| WorkerError::MalformedResponse)?;
    drop(stdout);
    let status = child.wait().await.map_err(|_| WorkerError::Crash)?;
    if !status.success() {
        return Err(WorkerError::Crash);
    }
    serde_json::from_slice(&response).map_err(|_| WorkerError::MalformedResponse)
}

async fn terminate(child: &mut Child) {
    #[cfg(unix)]
    if let Some(process_id) = child.id() {
        // SAFETY: the child was created as the leader of a dedicated process group.
        let _ = unsafe { libc::kill(-(process_id as i32), libc::SIGKILL) };
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

fn validate_request_binding(
    manifest: &CapabilityManifest,
    request: &WorkerRequest,
) -> Result<(), WorkerError> {
    if request.protocol_version != PROTOCOL_VERSION
        || request.capability_id != manifest.capability_id
        || request.capability_version != manifest.version
        || !request.input.is_object()
    {
        return Err(WorkerError::InvalidRequest);
    }
    Ok(())
}

fn validate_response(
    request: &WorkerRequest,
    response: &WorkerResponse,
) -> Result<(), WorkerError> {
    if response.protocol_version != PROTOCOL_VERSION
        || response.request_id != request.request_id
        || !matches!(response.status.as_str(), "ok" | "error")
        || (response.status == "ok") != response.artifact.is_some()
        || (response.status == "error") != response.error_code.is_some()
    {
        return Err(WorkerError::ResponseMismatch);
    }
    if let Some(artifact) = &response.artifact {
        validate_identifier(&artifact.kind, 128)?;
        validate_hash(&artifact.content_hash)?;
        let computed = json_hash(&artifact.payload);
        if artifact.content_hash != computed {
            return Err(WorkerError::ResponseMismatch);
        }
    }
    if let Some(error_code) = &response.error_code {
        validate_identifier(error_code, 128)?;
    }
    Ok(())
}

async fn file_hash(path: &Path) -> Result<String, WorkerError> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|_| WorkerError::InvalidExecutable)?;
    if metadata.len() > 256 * 1024 * 1024 {
        return Err(WorkerError::InvalidExecutable);
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|_| WorkerError::InvalidExecutable)?;
    Ok(bytes_hash(&bytes))
}

#[must_use]
pub fn bytes_hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[must_use]
pub fn json_hash(value: &Value) -> String {
    bytes_hash(&serde_json::to_vec(value).unwrap_or_default())
}

fn validate_identifier(value: &str, maximum: usize) -> Result<(), WorkerError> {
    if value.is_empty()
        || value.len() > maximum
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(WorkerError::InvalidManifest);
    }
    Ok(())
}

fn validate_hash(value: &str) -> Result<(), WorkerError> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(WorkerError::InvalidManifest)
    }
}

fn validate_relative_path(value: &str) -> Result<(), WorkerError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 1_024
        || path.is_absolute()
        || value.contains(['\0', '\\'])
        || path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(WorkerError::InvalidManifest);
    }
    Ok(())
}
