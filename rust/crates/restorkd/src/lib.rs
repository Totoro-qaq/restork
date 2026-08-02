//! Process lifecycle and loopback listener ownership for `restorkd`.

pub mod desktop;

use std::{
    error::Error,
    ffi::OsStr,
    fmt,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::Duration,
};

use restork_core::auth::{AuthError, PairingAuthority};
use serde::Serialize;
use tokio::net::TcpListener;

pub const HELP: &str = "Restork local runtime\n\nUsage:\n  restorkd serve [--port <0-65535>]\n\nThe listener is always bound to 127.0.0.1. Port 0 asks the OS to select a free port.\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ServerConfig {
    pub port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConfigError {
    MissingCommand,
    NonUnicodeArgument,
    UnknownCommand(String),
    UnknownArgument(String),
    MissingValue(&'static str),
    DuplicateArgument(&'static str),
    InvalidPort(String),
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingCommand => write!(formatter, "missing command; expected `serve`"),
            Self::NonUnicodeArgument => write!(formatter, "arguments must be valid Unicode"),
            Self::UnknownCommand(command) => write!(formatter, "unknown command `{command}`"),
            Self::UnknownArgument(argument) => write!(formatter, "unknown argument `{argument}`"),
            Self::MissingValue(argument) => write!(formatter, "missing value for `{argument}`"),
            Self::DuplicateArgument(argument) => {
                write!(formatter, "argument `{argument}` may only be provided once")
            }
            Self::InvalidPort(port) => write!(formatter, "invalid port `{port}`"),
        }
    }
}

impl Error for ConfigError {}

impl ServerConfig {
    pub fn parse<I, S>(args: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut args = args.into_iter();
        let command = args.next().ok_or(ConfigError::MissingCommand)?;
        let command = to_text(command.as_ref())?;
        if command != "serve" {
            return Err(ConfigError::UnknownCommand(command.to_owned()));
        }

        let mut port = 0;
        let mut port_seen = false;
        while let Some(argument) = args.next() {
            let argument = to_text(argument.as_ref())?;
            match argument {
                "--port" => {
                    if port_seen {
                        return Err(ConfigError::DuplicateArgument("--port"));
                    }
                    let value = args.next().ok_or(ConfigError::MissingValue("--port"))?;
                    let value = to_text(value.as_ref())?;
                    port = value
                        .parse::<u16>()
                        .map_err(|_| ConfigError::InvalidPort(value.to_owned()))?;
                    port_seen = true;
                }
                unknown => return Err(ConfigError::UnknownArgument(unknown.to_owned())),
            }
        }
        Ok(Self { port })
    }
}

fn to_text(value: &OsStr) -> Result<&str, ConfigError> {
    value.to_str().ok_or(ConfigError::NonUnicodeArgument)
}

#[derive(Serialize)]
pub struct ReadyRecord {
    pub event: &'static str,
    pub schema: &'static str,
    pub pid: u32,
    pub port: u16,
    pub address: String,
    pub base_url: String,
    pub pairing_code: String,
}

pub struct BoundServer {
    listener: TcpListener,
    address: SocketAddr,
    authority: PairingAuthority,
}

impl BoundServer {
    #[must_use]
    pub fn address(&self) -> SocketAddr {
        self.address
    }

    #[must_use]
    pub fn ready_record(&self) -> ReadyRecord {
        ReadyRecord {
            event: "ready",
            schema: "v1",
            pid: std::process::id(),
            port: self.address.port(),
            address: self.address.to_string(),
            base_url: format!("http://{}", self.address),
            pairing_code: self.authority.initial_pairing_code(),
        }
    }

    pub async fn serve_until<F>(self, shutdown: F) -> io::Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        axum::serve(self.listener, restork_api::router(self.authority))
            .with_graceful_shutdown(shutdown)
            .await
    }
}

#[derive(Debug)]
pub enum StartupError {
    Io(io::Error),
    Auth(AuthError),
}

impl fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Auth(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for StartupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Auth(error) => Some(error),
        }
    }
}

impl From<io::Error> for StartupError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<AuthError> for StartupError {
    fn from(error: AuthError) -> Self {
        Self::Auth(error)
    }
}

pub async fn bind(config: ServerConfig) -> Result<BoundServer, StartupError> {
    let requested = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    let listener = TcpListener::bind(requested).await?;
    let address = listener.local_addr()?;
    let authority = PairingAuthority::new(Duration::from_secs(300))?;
    Ok(BoundServer {
        listener,
        address,
        authority,
    })
}
