use std::{net::IpAddr, time::Duration};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    sync::oneshot,
    time::timeout,
};

use restorkd::{ConfigError, ServerConfig, bind};

#[cfg(unix)]
static DESKTOP_PROCESS_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn config_accepts_an_os_selected_port_but_never_a_host_override() {
    assert_eq!(
        ServerConfig::parse(["serve", "--port", "0"]).expect("valid config"),
        ServerConfig {
            port: 0,
            state_db: None,
            vault_dir: None,
            vault_grant_file: None,
        }
    );
    assert_eq!(
        ServerConfig::parse(["serve"]).expect("automatic port"),
        ServerConfig {
            port: 0,
            state_db: None,
            vault_dir: None,
            vault_grant_file: None,
        }
    );
    assert_eq!(
        ServerConfig::parse(["serve", "--host", "0.0.0.0"]),
        Err(ConfigError::UnknownArgument("--host".to_owned()))
    );
    assert_eq!(
        ServerConfig::parse(["serve", "--port", "not-a-port"]),
        Err(ConfigError::InvalidPort("not-a-port".to_owned()))
    );
}

#[test]
fn config_accepts_one_private_vault_descriptor_and_rejects_conflicts() {
    let descriptor = std::path::PathBuf::from("private-vault.grant");
    assert_eq!(
        ServerConfig::parse([
            "serve",
            "--vault-grant-file",
            descriptor.to_str().expect("UTF-8 fixture"),
        ])
        .expect("private descriptor"),
        ServerConfig {
            port: 0,
            state_db: None,
            vault_dir: None,
            vault_grant_file: Some(descriptor),
        }
    );
    assert_eq!(
        ServerConfig::parse([
            "serve",
            "--vault-dir",
            "vault",
            "--vault-grant-file",
            "private-vault.grant",
        ]),
        Err(ConfigError::ConflictingArguments(
            "--vault-dir",
            "--vault-grant-file",
        ))
    );
}

#[test]
fn cli_help_never_executes_the_requested_command() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_restork"))
        .args(["runs", "create", "--help"])
        .output()
        .expect("run CLI help");
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Restork command line"));
    assert!(output.stderr.is_empty());
}

#[cfg(unix)]
#[test]
fn desktop_bootstrap_is_private_and_parent_lease_owns_the_daemon_lifetime() {
    use std::{
        fs::File,
        io::Read,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::Instant,
    };

    let _test_guard = DESKTOP_PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut descriptors = [-1_i32; 2];
        // SAFETY: storage is provided for exactly two descriptors and success
        // transfers ownership to the two `OwnedFd` values below.
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        // SAFETY: `pipe` succeeded and returned two newly owned descriptors.
        let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        // SAFETY: `pipe` succeeded and returned two newly owned descriptors.
        let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        (reader, writer)
    }

    fn close_on_exec(descriptor: &OwnedFd) {
        // SAFETY: the descriptor is owned by this test and the flags are integers.
        assert_ne!(
            unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
            -1
        );
    }

    let (bootstrap_reader, bootstrap_writer) = pipe();
    let (lease_reader, lease_writer) = pipe();
    close_on_exec(&bootstrap_reader);
    close_on_exec(&lease_writer);
    let state_directory = tempfile::tempdir().expect("private state directory");
    let mut command = Command::new(env!("CARGO_BIN_EXE_restorkd"));
    command
        .args(["serve", "--port", "0", "--state-db"])
        .arg(state_directory.path().join("restork.db"))
        .env(
            "RESTORK_DESKTOP_BOOTSTRAP_FD",
            bootstrap_writer.as_raw_fd().to_string(),
        )
        .env(
            "RESTORK_DESKTOP_PARENT_FD",
            lease_reader.as_raw_fd().to_string(),
        )
        .env("RESTORK_DESKTOP_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command.spawn().expect("spawn desktop-owned daemon");
    drop(bootstrap_writer);
    drop(lease_reader);

    let mut bootstrap = String::new();
    File::from(bootstrap_reader)
        .read_to_string(&mut bootstrap)
        .expect("read one-shot bootstrap");
    let payload: serde_json::Value = serde_json::from_str(&bootstrap).expect("bootstrap JSON");
    assert_eq!(payload["schema_version"], 1);
    assert_eq!(payload["pid"], child.id());
    assert!(payload["port"].as_u64().is_some_and(|port| port > 0));
    assert_eq!(payload["pairing_code"].as_str().map(str::len), Some(48));
    assert!(
        payload["issued_at"]
            .as_str()
            .is_some_and(|value| value.contains('T'))
    );

    drop(lease_writer);
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        if let Some(status) = child.try_wait().expect("child status") {
            break status;
        }
        assert!(Instant::now() < deadline, "daemon ignored parent lease EOF");
        thread::sleep(Duration::from_millis(10));
    };
    assert!(status.success(), "{status:?}");
    let output = child.wait_with_output().expect("collect daemon output");
    assert!(
        output.stdout.is_empty(),
        "desktop mode leaked bootstrap to stdout"
    );
    assert!(
        output.stderr.is_empty(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(unix)]
#[test]
fn desktop_daemon_still_honors_sigterm_while_the_parent_lease_is_open() {
    use std::{
        fs::File,
        io::{Read, Write},
        net::TcpStream as BlockingTcpStream,
        os::fd::{AsRawFd, FromRawFd, OwnedFd},
        os::unix::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::Instant,
    };

    let _test_guard = DESKTOP_PROCESS_TEST_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut descriptors = [-1_i32; 2];
        // SAFETY: storage is provided for two descriptors and success transfers ownership.
        assert_eq!(unsafe { libc::pipe(descriptors.as_mut_ptr()) }, 0);
        // SAFETY: `pipe` succeeded and returned two newly owned descriptors.
        let reader = unsafe { OwnedFd::from_raw_fd(descriptors[0]) };
        // SAFETY: `pipe` succeeded and returned two newly owned descriptors.
        let writer = unsafe { OwnedFd::from_raw_fd(descriptors[1]) };
        (reader, writer)
    }

    fn close_on_exec(descriptor: &OwnedFd) {
        // SAFETY: the descriptor is owned by this test and the flags are integers.
        assert_ne!(
            unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) },
            -1
        );
    }

    let (bootstrap_reader, bootstrap_writer) = pipe();
    let (lease_reader, lease_writer) = pipe();
    close_on_exec(&bootstrap_reader);
    close_on_exec(&lease_writer);
    let state_directory = tempfile::tempdir().expect("private state directory");
    let mut command = Command::new(env!("CARGO_BIN_EXE_restorkd"));
    command
        .args(["serve", "--port", "0", "--state-db"])
        .arg(state_directory.path().join("restork.db"))
        .env(
            "RESTORK_DESKTOP_BOOTSTRAP_FD",
            bootstrap_writer.as_raw_fd().to_string(),
        )
        .env(
            "RESTORK_DESKTOP_PARENT_FD",
            lease_reader.as_raw_fd().to_string(),
        )
        .env("RESTORK_DESKTOP_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0);
    let mut child = command.spawn().expect("spawn desktop-owned daemon");
    drop(bootstrap_writer);
    drop(lease_reader);
    let mut bootstrap = String::new();
    File::from(bootstrap_reader)
        .read_to_string(&mut bootstrap)
        .expect("read bootstrap");
    let payload: serde_json::Value = serde_json::from_str(&bootstrap).expect("bootstrap JSON");
    let port = payload["port"].as_u64().expect("port") as u16;
    let readiness_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if let Ok(mut stream) = BlockingTcpStream::connect(("127.0.0.1", port)) {
            stream
                .write_all(
                    b"GET /v1/readiness HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )
                .expect("readiness request");
            let mut response = String::new();
            stream
                .read_to_string(&mut response)
                .expect("readiness response");
            if response.starts_with("HTTP/1.1 200 OK") {
                break;
            }
        }
        assert!(
            Instant::now() < readiness_deadline,
            "daemon never reached readiness"
        );
        thread::sleep(Duration::from_millis(10));
    }

    // SAFETY: the child is the leader of the new process group created above.
    assert_eq!(
        unsafe { libc::kill(-(child.id() as i32), libc::SIGTERM) },
        0
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        if let Some(status) = child.try_wait().expect("child status") {
            break status;
        }
        if Instant::now() >= deadline {
            // SAFETY: this targets only the child process group created by the test.
            let _ = unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
            panic!("daemon did not honor SIGTERM while parent lease remained open");
        }
        thread::sleep(Duration::from_millis(10));
    };
    drop(lease_writer);
    assert!(status.success(), "{status:?}");
}

#[tokio::test]
async fn daemon_owns_a_loopback_only_listener_and_shuts_down_cleanly() {
    let state_directory = tempfile::tempdir().expect("private state directory");
    let bound = bind(ServerConfig {
        port: 0,
        state_db: Some(state_directory.path().join("restork.db")),
        vault_dir: None,
        vault_grant_file: None,
    })
    .await
    .expect("bind loopback listener");
    let address = bound.address();
    assert_eq!(address.ip(), IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
    assert_ne!(address.port(), 0);
    let ready = bound.ready_record();
    assert_eq!(ready.address, address.to_string());
    assert_eq!(ready.pairing_code.len(), 48);
    assert_eq!(ready.cli_pairing_code.len(), 48);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    let server = tokio::spawn(bound.serve_until(async move {
        let _ = shutdown_rx.await;
    }));

    let mut stream = TcpStream::connect(address).await.expect("connect daemon");
    stream
        .write_all(b"GET /v1/readiness HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .await
        .expect("write request");
    let mut response = Vec::new();
    stream
        .read_to_end(&mut response)
        .await
        .expect("read response");
    let response = String::from_utf8(response).expect("HTTP response is UTF-8");
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"), "{response}");
    assert!(
        response.ends_with("{\"status\":\"ready\",\"schema\":\"v1\"}"),
        "{response}"
    );

    shutdown_tx.send(()).expect("signal shutdown");
    timeout(Duration::from_secs(1), server)
        .await
        .expect("server stops promptly")
        .expect("server task")
        .expect("graceful shutdown");
}

#[cfg(unix)]
#[tokio::test]
async fn desktop_vault_descriptor_must_be_owner_private() {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let state_directory = tempfile::tempdir().expect("private state directory");
    let vault = tempfile::tempdir().expect("vault");
    let grant = state_directory.path().join("vault-launch.grant");
    fs::write(&grant, vault.path().to_string_lossy().as_bytes()).expect("write grant");
    fs::set_permissions(&grant, fs::Permissions::from_mode(0o600)).expect("private mode");
    let bound = bind(ServerConfig {
        port: 0,
        state_db: Some(state_directory.path().join("private.db")),
        vault_dir: None,
        vault_grant_file: Some(grant.clone()),
    })
    .await
    .expect("private grant binds");
    drop(bound);

    fs::set_permissions(&grant, fs::Permissions::from_mode(0o644)).expect("public mode");
    let error = bind(ServerConfig {
        port: 0,
        state_db: Some(state_directory.path().join("public.db")),
        vault_dir: None,
        vault_grant_file: Some(grant),
    })
    .await
    .err()
    .expect("public grant rejected");
    assert!(error.to_string().contains("owner-private"));
}
