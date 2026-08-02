//! One-shot desktop bootstrap and parent-death lease handling.

use std::{error::Error, fmt, io};

#[derive(Debug)]
pub enum DesktopError {
    Incomplete,
    Invalid,
    OwnershipMismatch,
    DescriptorUnavailable,
    DescriptorNotPipe,
    AlreadyPublished,
    PayloadInvalid,
    Io(io::Error),
}

impl fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Incomplete => "desktop parent lease is incomplete",
            Self::Invalid => "desktop parent lease is invalid",
            Self::OwnershipMismatch => "desktop parent ownership does not match Core",
            Self::DescriptorUnavailable => "desktop descriptor is unavailable",
            Self::DescriptorNotPipe => "desktop descriptor must be an anonymous pipe",
            Self::AlreadyPublished => "desktop bootstrap was already published",
            Self::PayloadInvalid => "desktop bootstrap payload is invalid",
            Self::Io(error) => return write!(formatter, "desktop channel failed: {error}"),
        };
        formatter.write_str(message)
    }
}

impl Error for DesktopError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}

impl From<io::Error> for DesktopError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

#[cfg(unix)]
mod platform {
    use std::{
        env,
        fs::File,
        io::{self, Write},
        os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
    };

    use serde::Serialize;
    use time::{OffsetDateTime, format_description::well_known::Rfc3339};

    use super::DesktopError;

    const BOOTSTRAP_FD: &str = "RESTORK_DESKTOP_BOOTSTRAP_FD";
    const PARENT_FD: &str = "RESTORK_DESKTOP_PARENT_FD";
    const PARENT_PID: &str = "RESTORK_DESKTOP_PARENT_PID";

    pub struct DesktopRuntime {
        bootstrap: Option<OwnedFd>,
        parent_lease: OwnedFd,
    }

    #[derive(Serialize)]
    struct BootstrapPayload<'a> {
        schema_version: u8,
        pid: u32,
        port: u16,
        pairing_code: &'a str,
        issued_at: String,
    }

    impl DesktopRuntime {
        pub fn from_env() -> Result<Option<Self>, DesktopError> {
            let bootstrap = env::var_os(BOOTSTRAP_FD);
            let parent = env::var_os(PARENT_FD);
            let parent_pid = env::var_os(PARENT_PID);
            if bootstrap.is_none() && parent.is_none() && parent_pid.is_none() {
                return Ok(None);
            }
            let (Some(bootstrap), Some(parent), Some(parent_pid)) = (bootstrap, parent, parent_pid)
            else {
                return Err(DesktopError::Incomplete);
            };
            let bootstrap = parse_descriptor(&bootstrap)?;
            let parent = parse_descriptor(&parent)?;
            let parent_pid = parent_pid
                .to_str()
                .and_then(|value| value.parse::<libc::pid_t>().ok())
                .filter(|pid| *pid >= 2)
                .ok_or(DesktopError::Invalid)?;
            if bootstrap == parent {
                return Err(DesktopError::Invalid);
            }

            // SAFETY: these calls only inspect process identity.
            let identity_matches =
                unsafe { libc::getppid() == parent_pid && libc::getpgrp() == libc::getpid() };
            if !identity_matches {
                return Err(DesktopError::OwnershipMismatch);
            }
            validate_pipe(bootstrap)?;
            validate_pipe(parent)?;
            set_close_on_exec(bootstrap)?;
            set_close_on_exec(parent)?;
            set_nonblocking(parent)?;

            // SAFETY: validation succeeded and the desktop contract transfers
            // ownership of both inherited descriptors to the Core process.
            let bootstrap = unsafe { OwnedFd::from_raw_fd(bootstrap) };
            // SAFETY: as above, this is a distinct inherited descriptor.
            let parent_lease = unsafe { OwnedFd::from_raw_fd(parent) };
            Ok(Some(Self {
                bootstrap: Some(bootstrap),
                parent_lease,
            }))
        }

        pub fn publish(&mut self, port: u16, pairing_code: &str) -> Result<(), DesktopError> {
            if port == 0
                || !(16..=256).contains(&pairing_code.len())
                || pairing_code.contains(['\0', '\n', '\r'])
            {
                return Err(DesktopError::PayloadInvalid);
            }
            let issued_at = OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|_| DesktopError::PayloadInvalid)?;
            let mut payload = serde_json::to_vec(&BootstrapPayload {
                schema_version: 1,
                pid: std::process::id(),
                port,
                pairing_code,
                issued_at,
            })
            .map_err(|_| DesktopError::PayloadInvalid)?;
            payload.push(b'\n');
            if payload.len() > 4096 {
                return Err(DesktopError::PayloadInvalid);
            }
            let descriptor = self
                .bootstrap
                .take()
                .ok_or(DesktopError::AlreadyPublished)?;
            let mut pipe = File::from(descriptor);
            pipe.write_all(&payload)?;
            pipe.flush()?;
            Ok(())
        }

        pub async fn wait_for_parent(self) {
            let Ok(pipe) = tokio::io::unix::AsyncFd::new(self.parent_lease) else {
                return;
            };
            loop {
                let Ok(mut readable) = pipe.readable().await else {
                    return;
                };
                let mut byte = [0_u8; 1];
                let result = readable.try_io(|descriptor| {
                    // SAFETY: the descriptor remains owned by `AsyncFd`, and
                    // the buffer provides valid storage for one byte.
                    let count = unsafe {
                        libc::read(
                            descriptor.get_ref().as_raw_fd(),
                            byte.as_mut_ptr().cast(),
                            byte.len(),
                        )
                    };
                    if count >= 0 {
                        Ok(count as usize)
                    } else {
                        Err(io::Error::last_os_error())
                    }
                });
                match result {
                    Ok(Ok(0)) | Ok(Err(_)) => return,
                    Ok(Ok(_)) | Err(_) => {}
                }
            }
        }
    }

    fn parse_descriptor(value: &std::ffi::OsStr) -> Result<RawFd, DesktopError> {
        value
            .to_str()
            .and_then(|value| value.parse::<RawFd>().ok())
            .filter(|descriptor| *descriptor >= 3)
            .ok_or(DesktopError::Invalid)
    }

    fn validate_pipe(descriptor: RawFd) -> Result<(), DesktopError> {
        // SAFETY: the zeroed structure is valid output storage for `fstat`.
        let mut metadata = unsafe { std::mem::zeroed::<libc::stat>() };
        // SAFETY: `metadata` is writable and the integer descriptor is merely inspected.
        if unsafe { libc::fstat(descriptor, &mut metadata) } != 0 {
            return Err(DesktopError::DescriptorUnavailable);
        }
        if metadata.st_mode & libc::S_IFMT != libc::S_IFIFO {
            return Err(DesktopError::DescriptorNotPipe);
        }
        Ok(())
    }

    fn set_close_on_exec(descriptor: RawFd) -> Result<(), DesktopError> {
        // SAFETY: `fcntl` receives a validated descriptor and integer flags.
        if unsafe { libc::fcntl(descriptor, libc::F_SETFD, libc::FD_CLOEXEC) } == -1 {
            return Err(DesktopError::DescriptorUnavailable);
        }
        Ok(())
    }

    fn set_nonblocking(descriptor: RawFd) -> Result<(), DesktopError> {
        // SAFETY: `fcntl` only reads the flags for a validated descriptor.
        let flags = unsafe { libc::fcntl(descriptor, libc::F_GETFL) };
        if flags == -1 {
            return Err(DesktopError::DescriptorUnavailable);
        }
        // SAFETY: `fcntl` receives the flags read immediately above.
        if unsafe { libc::fcntl(descriptor, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
            return Err(DesktopError::DescriptorUnavailable);
        }
        Ok(())
    }
}

#[cfg(not(unix))]
mod platform {
    use super::DesktopError;

    pub struct DesktopRuntime;

    impl DesktopRuntime {
        pub fn from_env() -> Result<Option<Self>, DesktopError> {
            let configured = [
                "RESTORK_DESKTOP_BOOTSTRAP_FD",
                "RESTORK_DESKTOP_PARENT_FD",
                "RESTORK_DESKTOP_PARENT_PID",
            ]
            .iter()
            .any(|name| std::env::var_os(name).is_some());
            if configured {
                Err(DesktopError::Invalid)
            } else {
                Ok(None)
            }
        }

        pub fn publish(&mut self, _port: u16, _pairing_code: &str) -> Result<(), DesktopError> {
            Err(DesktopError::Invalid)
        }

        pub async fn wait_for_parent(self) {}
    }
}

pub use platform::DesktopRuntime;
