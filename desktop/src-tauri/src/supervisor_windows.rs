use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_SUSPENDED, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME,
};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_LIMIT: usize = 3;

pub(crate) struct CoreProcess {
    pub(crate) child: Child,
    pub(crate) origin: String,
    pub(crate) port: u16,
    pub(crate) pairing_code: String,
    job: JobHandle,
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
            terminate_child(&mut self.child, &self.job);
            self.terminated = true;
        }
    }
}

struct JobHandle(isize);

impl JobHandle {
    fn raw(&self) -> HANDLE {
        self.0 as HANDLE
    }
}

// The handle is owned by this process and is only closed from Drop after the
// monitor thread releases the CoreProcess lock.
unsafe impl Send for JobHandle {}

impl Drop for JobHandle {
    fn drop(&mut self) {
        if self.0 != 0 && self.raw() != INVALID_HANDLE_VALUE {
            // SAFETY: this wrapper uniquely owns the Job Object handle.
            let _ = unsafe { CloseHandle(self.raw()) };
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
    let state_database = state_database(app)?;
    let mut last_error = "core_start_failed";
    for _attempt in 0..RETRY_LIMIT {
        match start_attempt(&executable, &state_database) {
            Ok(core) => return Ok(core),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn start_attempt(
    executable: &PathBuf,
    state_database: &PathBuf,
) -> Result<CoreProcess, &'static str> {
    let port = reserve_port()?;
    let mut command = Command::new(executable);
    command
        .arg("serve")
        .arg("--port")
        .arg(port.to_string())
        .arg("--state-db")
        .arg(state_database)
        .env("RESTORK_DESKTOP_WINDOWS_JOB", "1")
        .env("RESTORK_DESKTOP_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_SUSPENDED | CREATE_NO_WINDOW);
    let mut child = command.spawn().map_err(|_| "core_spawn_failed")?;
    let job = match own_suspended_process(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let stdout = child.stdout.take().ok_or("bootstrap_pipe_failed")?;
    let receiver = bootstrap_reader(stdout);
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let payload = match wait_for_bootstrap(&receiver, &mut child, port, deadline) {
        Ok(payload) => payload,
        Err(error) => {
            terminate_child(&mut child, &job);
            return Err(error);
        }
    };
    if !wait_for_readiness(&mut child, port, deadline) {
        terminate_child(&mut child, &job);
        return Err("core_readiness_failed");
    }
    Ok(CoreProcess {
        child,
        origin: format!("http://127.0.0.1:{port}"),
        port,
        pairing_code: payload.pairing_code,
        job,
        terminated: false,
    })
}

fn own_suspended_process(child: &Child) -> Result<JobHandle, &'static str> {
    // SAFETY: null name creates a private Job Object owned by the returned handle.
    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() || job == INVALID_HANDLE_VALUE {
        return Err("job_object_create_failed");
    }
    let owned = JobHandle(job as isize);
    // SAFETY: zero is a valid base state for this documented information structure.
    let mut limits = unsafe { std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: both handles and the fixed-size information buffer remain valid for the call.
    if unsafe {
        SetInformationJobObject(
            owned.raw(),
            JobObjectExtendedLimitInformation,
            std::ptr::addr_of!(limits).cast(),
            u32::try_from(std::mem::size_of_val(&limits)).expect("job limit size fits u32"),
        )
    } == 0
    {
        return Err("job_object_configure_failed");
    }
    let process = child.as_raw_handle() as HANDLE;
    // SAFETY: the child is still suspended, and the Job Object is configured before assignment.
    if unsafe { AssignProcessToJobObject(owned.raw(), process) } == 0 {
        return Err("job_object_assign_failed");
    }
    resume_primary_thread(child.id())?;
    Ok(owned)
}

fn resume_primary_thread(process_id: u32) -> Result<(), &'static str> {
    // SAFETY: this creates a read-only snapshot handle which is closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err("core_thread_snapshot_failed");
    }
    // SAFETY: zero plus the required size field is the documented initialization.
    let mut entry = unsafe { std::mem::zeroed::<THREADENTRY32>() };
    entry.dwSize =
        u32::try_from(std::mem::size_of::<THREADENTRY32>()).expect("thread entry size fits u32");
    // SAFETY: snapshot and entry are valid for enumeration.
    let mut available = unsafe { Thread32First(snapshot, &mut entry) } != 0;
    let mut resumed = false;
    while available {
        if entry.th32OwnerProcessID == process_id {
            // SAFETY: the enumerated thread belongs to the suspended child.
            let thread_handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if !thread_handle.is_null() && thread_handle != INVALID_HANDLE_VALUE {
                // SAFETY: this is the suspended primary thread; a non-u32::MAX result is success.
                resumed = unsafe { ResumeThread(thread_handle) } != u32::MAX;
                // SAFETY: the local wrapper owns this opened thread handle.
                let _ = unsafe { CloseHandle(thread_handle) };
            }
            break;
        }
        // SAFETY: snapshot and entry remain valid until enumeration ends.
        available = unsafe { Thread32Next(snapshot, &mut entry) } != 0;
    }
    // SAFETY: this function uniquely owns the snapshot handle.
    let _ = unsafe { CloseHandle(snapshot) };
    resumed.then_some(()).ok_or("core_thread_resume_failed")
}

fn bootstrap_reader(stdout: std::process::ChildStdout) -> mpsc::Receiver<Result<Vec<u8>, ()>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout).take(4097);
        let mut line = Vec::with_capacity(512);
        let result = reader.read_until(b'\n', &mut line).map_err(|_| ());
        let _ = sender.send(result.map(|_| line));
    });
    receiver
}

fn wait_for_bootstrap(
    receiver: &mpsc::Receiver<Result<Vec<u8>, ()>>,
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
        match receiver.try_recv() {
            Ok(Ok(bytes)) => {
                if bytes.is_empty() || bytes.len() > 4096 {
                    return Err("bootstrap_too_large");
                }
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
            Ok(Err(())) | Err(mpsc::TryRecvError::Disconnected) => {
                return Err("bootstrap_read_failed");
            }
            Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(25)),
        }
    }
    Err("bootstrap_timeout")
}

fn core_executable(app: &AppHandle) -> Result<PathBuf, &'static str> {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os("RESTORK_DESKTOP_CORE") {
        let expected = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../dist/desktop-runtime/restorkd.exe");
        if value != expected.as_os_str() {
            return Err("core_path_invalid");
        }
        let selected = fs::canonicalize(expected).map_err(|_| "core_path_invalid")?;
        if !selected.is_file() {
            return Err("core_path_invalid");
        }
        return Ok(selected);
    }

    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| "core_resource_unavailable")?;
    let resources = fs::canonicalize(resources).map_err(|_| "core_resource_unavailable")?;
    let selected = fs::canonicalize(resources.join("core/restorkd.exe"))
        .map_err(|_| "core_resource_unavailable")?;
    if !selected.starts_with(&resources) || !selected.is_file() {
        return Err("core_resource_invalid");
    }
    Ok(selected)
}

fn state_database(app: &AppHandle) -> Result<PathBuf, &'static str> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "core_state_unavailable")?;
    fs::create_dir_all(&directory).map_err(|_| "core_state_unavailable")?;
    let directory = fs::canonicalize(directory).map_err(|_| "core_state_unavailable")?;
    let metadata = directory
        .symlink_metadata()
        .map_err(|_| "core_state_unavailable")?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err("core_state_unavailable");
    }
    Ok(directory.join("restork.db"))
}

fn reserve_port() -> Result<u16, &'static str> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| "port_unavailable")?;
    listener
        .local_addr()
        .map(|address| address.port())
        .map_err(|_| "port_unavailable")
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

fn terminate_child(child: &mut Child, job: &JobHandle) {
    // SAFETY: the Job Object exclusively owns the Core process tree.
    let _ = unsafe { TerminateJobObject(job.raw(), 1) };
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::reserve_port;

    #[test]
    fn reserves_a_non_privileged_loopback_port() {
        let port = reserve_port().expect("port should be available");
        assert!(port > 1024);
    }
}
