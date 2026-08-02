use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tempfile::TempDir;

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_LIMIT: usize = 3;

pub(crate) struct CoreProcess {
    pub(crate) child: Child,
    pub(crate) origin: String,
    pub(crate) port: u16,
    pub(crate) pairing_code: String,
    _parent_lease: OwnedFd,
    terminated: bool,
}

impl Drop for CoreProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl CoreProcess {
    pub(crate) fn terminate(&mut self) {
        if !self.terminated {
            terminate_child(&mut self.child);
            self.terminated = true;
        }
    }
}

#[derive(Deserialize)]
struct BootstrapPayload {
    schema_version: u8,
    pid: u32,
    port: u16,
    pairing_code: String,
    issued_at: String,
}

pub(crate) fn start_core(app: &AppHandle) -> Result<CoreProcess, &'static str> {
    let executable = core_executable(app)?;
    let mut last_error = "core_start_failed";
    for _attempt in 0..RETRY_LIMIT {
        match start_attempt(&executable) {
            Ok(core) => return Ok(core),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn start_attempt(executable: &PathBuf) -> Result<CoreProcess, &'static str> {
    let port = reserve_port()?;
    let bootstrap_dir = private_tempdir()?;
    let bootstrap_path = bootstrap_dir.path().join("core.json");
    let (lease_reader, lease_writer) = parent_lease()?;
    let mut command = Command::new(executable);
    command
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .env("RESTORK_DESKTOP_BOOTSTRAP_PATH", &bootstrap_path)
        .env(
            "RESTORK_DESKTOP_PARENT_FD",
            lease_reader.as_raw_fd().to_string(),
        )
        .env("RESTORK_DESKTOP_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = command.spawn().map_err(|_| "core_spawn_failed")?;
    drop(lease_reader);

    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let payload = match wait_for_bootstrap(&bootstrap_path, &mut child, port, deadline) {
        Ok(payload) => payload,
        Err(error) => {
            terminate_child(&mut child);
            return Err(error);
        }
    };
    let _ = fs::remove_file(&bootstrap_path);
    drop(bootstrap_dir);

    if !wait_for_readiness(&mut child, port, deadline) {
        terminate_child(&mut child);
        return Err("core_readiness_failed");
    }
    Ok(CoreProcess {
        child,
        origin: format!("http://127.0.0.1:{port}"),
        port,
        pairing_code: payload.pairing_code,
        _parent_lease: lease_writer,
        terminated: false,
    })
}

fn parent_lease() -> Result<(OwnedFd, OwnedFd), &'static str> {
    let mut descriptors = [-1_i32; 2];
    // SAFETY: `descriptors` points to storage for exactly two file descriptors.
    if unsafe { libc::pipe(descriptors.as_mut_ptr()) } != 0 {
        return Err("parent_lease_failed");
    }
    // SAFETY: a successful `pipe` call transfers ownership of both descriptors.
    let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
    // SAFETY: a successful `pipe` call transfers ownership of both descriptors.
    let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
    // The Core must inherit the read end. The write end belongs only to the Rust
    // supervisor so kernel EOF becomes an unforgeable parent-death signal.
    // SAFETY: `writer` is a valid descriptor and F_SETFD has no pointer arguments.
    if unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
        return Err("parent_lease_failed");
    }
    Ok((reader, writer))
}

fn core_executable(app: &AppHandle) -> Result<PathBuf, &'static str> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("RESTORK_DESKTOP_CORE") {
        let selected = PathBuf::from(value);
        if selected.is_absolute() && selected.is_file() {
            return fs::canonicalize(selected).map_err(|_| "core_path_invalid");
        }
        return Err("core_path_invalid");
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "core_resource_unavailable")?;
    let resources = fs::canonicalize(resources).map_err(|_| "core_resource_unavailable")?;
    let selected = fs::canonicalize(resources.join("core/restork-core/restork-core"))
        .map_err(|_| "core_resource_unavailable")?;
    if !selected.starts_with(&resources) || !selected.is_file() {
        return Err("core_resource_invalid");
    }
    let mode = selected
        .metadata()
        .map_err(|_| "core_resource_invalid")?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        return Err("core_resource_not_executable");
    }
    Ok(selected)
}

fn reserve_port() -> Result<u16, &'static str> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| "port_unavailable")?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|_| "port_unavailable")
}

fn private_tempdir() -> Result<TempDir, &'static str> {
    let directory = tempfile::Builder::new()
        .prefix("restork-desktop-")
        .tempdir()
        .map_err(|_| "bootstrap_directory_failed")?;
    fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
        .map_err(|_| "bootstrap_directory_failed")?;
    Ok(directory)
}

fn wait_for_bootstrap(
    path: &PathBuf,
    child: &mut Child,
    expected_port: u16,
    deadline: Instant,
) -> Result<BootstrapPayload, &'static str> {
    while Instant::now() < deadline {
        if child
            .try_wait()
            .map_err(|_| "core_status_failed")?
            .is_some()
        {
            return Err("core_exited_early");
        }
        if path.exists() {
            let metadata = path
                .symlink_metadata()
                .map_err(|_| "bootstrap_metadata_invalid")?;
            if !metadata.file_type().is_file()
                || metadata.file_type().is_symlink()
                || metadata.uid() != current_uid()
                || metadata.mode() & 0o777 != 0o600
                || metadata.len() > 4096
            {
                return Err("bootstrap_metadata_invalid");
            }
            let bytes = fs::read(path).map_err(|_| "bootstrap_read_failed")?;
            let payload: BootstrapPayload =
                serde_json::from_slice(&bytes).map_err(|_| "bootstrap_json_invalid")?;
            if payload.schema_version != 1
                || payload.pid != child.id()
                || payload.port != expected_port
                || !(16..=256).contains(&payload.pairing_code.len())
                || payload.pairing_code.contains(char::is_whitespace)
                || !(20..=64).contains(&payload.issued_at.len())
            {
                return Err("bootstrap_contract_invalid");
            }
            return Ok(payload);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err("bootstrap_timeout")
}

fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and does not dereference memory.
    unsafe { libc::getuid() }
}

fn wait_for_readiness(child: &mut Child, port: u16, deadline: Instant) -> bool {
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return false;
        }
        if readiness_request(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

pub(crate) fn readiness_request(port: u16) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(150)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(150)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(150)));
    let request = format!(
        "GET /v1/readiness HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::with_capacity(512);
    if stream.take(4096).read_to_end(&mut response).is_err() {
        return false;
    }
    response.starts_with(b"HTTP/1.1 200")
        && response
            .windows(b"\"status\":\"ready\"".len())
            .any(|window| window == b"\"status\":\"ready\"")
}

pub(crate) fn terminate_child(child: &mut Child) {
    let process_group = child.id() as i32;
    #[cfg(unix)]
    {
        // SAFETY: this PID is the process-group leader created by `process_group(0)` above.
        let _ = unsafe { libc::kill(-process_group, libc::SIGTERM) };
    }
    for _attempt in 0..20 {
        let child_exited = child.try_wait().ok().flatten().is_some();
        if child_exited && !process_group_exists(process_group) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    {
        // SAFETY: the retained child PID identifies only the process group created for this Core.
        let _ = unsafe { libc::kill(-process_group, libc::SIGKILL) };
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn process_group_exists(process_group: i32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: signal 0 performs an existence/permission check and delivers no signal.
        unsafe { libc::kill(-process_group, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    use super::{process_group_exists, reserve_port, terminate_child};

    #[test]
    fn reserves_a_non_privileged_loopback_port() {
        let port = reserve_port().expect("port should be available");
        assert!(port > 1024);
    }

    #[test]
    fn terminates_the_owned_process_group() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "sleep 30 & wait"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command
            .spawn()
            .expect("synthetic process group should start");
        let process_group = child.id() as i32;
        assert!(process_group_exists(process_group));

        terminate_child(&mut child);

        assert!(!process_group_exists(process_group));
    }
}
