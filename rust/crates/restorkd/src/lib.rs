//! Process lifecycle and loopback listener ownership for `restorkd`.

pub mod desktop;

use std::{
    error::Error,
    ffi::OsStr,
    fmt,
    future::Future,
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};

use chrono::{DateTime, Utc};
use restork_automation::{ScheduleJob, ScheduleSpec};
use restork_core::auth::{AuthError, PairingAuthority};
use restork_storage::{Database, StorageError};
use serde::Serialize;
use tokio::net::TcpListener;

pub const HELP: &str = "Restork local runtime\n\nUsage:\n  restorkd serve [--port <0-65535>] [--state-db <path>]\n  restorkd provider configure [deepseek|glm|kimi|qwen|openrouter|open_ai_compatible]\n  restorkd doctor [--connect | --smoke | --web-search]\n  restorkd music apple configure\n  restorkd music apple configure-user-token\n  restorkd music apple status\n\nThe listener is always bound to 127.0.0.1. Port 0 asks the OS to select a free port. Provider and Apple Music setup delegate secret prompts to native credential storage.\n";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerConfig {
    pub port: u16,
    pub state_db: Option<PathBuf>,
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
        let mut state_db = None;
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
                "--state-db" => {
                    if state_db.is_some() {
                        return Err(ConfigError::DuplicateArgument("--state-db"));
                    }
                    let value = args.next().ok_or(ConfigError::MissingValue("--state-db"))?;
                    let path = PathBuf::from(value.as_ref());
                    if path.as_os_str().is_empty() {
                        return Err(ConfigError::MissingValue("--state-db"));
                    }
                    state_db = Some(path);
                }
                unknown => return Err(ConfigError::UnknownArgument(unknown.to_owned())),
            }
        }
        Ok(Self { port, state_db })
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
    storage: Option<Arc<Database>>,
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
        let scheduler = self.storage.clone().map(|storage| {
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(15));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    let _ = run_due_schedules_once(&storage, Utc::now());
                }
            })
        });
        let router = self.storage.map_or_else(
            || restork_api::router(self.authority.clone()),
            |storage| restork_api::router_with_storage(self.authority.clone(), storage),
        );
        let result = axum::serve(self.listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
        if let Some(scheduler) = scheduler {
            scheduler.abort();
        }
        result
    }
}

/// Execute due jobs once. It is synchronous and bounded so restart recovery can
/// replay an already-recorded period without duplicating work.
pub fn run_due_schedules_once(
    storage: &Database,
    now: DateTime<Utc>,
) -> Result<usize, StorageError> {
    let due = storage.due_schedules(&now.to_rfc3339(), 32)?;
    let mut completed = 0;
    for record in due {
        let Ok(schedule) = serde_json::from_value::<ScheduleSpec>(record.schedule) else {
            let _ = storage.advance_schedule(&record.schedule_id, None, &now.to_rfc3339());
            continue;
        };
        let Some(scheduled_at) = record
            .next_run_at
            .as_deref()
            .and_then(|value| value.parse::<DateTime<Utc>>().ok())
        else {
            let _ = storage.advance_schedule(&record.schedule_id, None, &now.to_rfc3339());
            continue;
        };
        let result = match &schedule.job {
            ScheduleJob::Deterministic { job } if job == "health.check" => serde_json::json!({
                "state": "completed",
                "job": job,
                "mode": "no_model",
                "schema_version": storage.schema_version()?,
                "external_effect": false,
            }),
            ScheduleJob::Deterministic { job } if job == "daily.refresh" => {
                storage.clear_daily_cache("weather-current")?;
                serde_json::json!({
                    "state": "completed",
                    "job": job,
                    "mode": "no_model",
                    "cache_invalidated": true,
                    "external_effect": false,
                })
            }
            ScheduleJob::ModelDraft {
                profile_id,
                requested_effect: None,
            } => serde_json::json!({
                "state": "draft_created",
                "profile_id": profile_id,
                "mode": "model_draft",
                "external_effect": false,
            }),
            ScheduleJob::Deterministic { .. } | ScheduleJob::ModelDraft { .. } => {
                serde_json::json!({
                    "state": "rejected",
                    "reason": "job is outside the safe scheduler contract",
                    "external_effect": false,
                })
            }
        };
        let period_key = format!("scheduled:{}", scheduled_at.timestamp());
        storage.record_schedule_run(
            &record.schedule_id,
            &period_key,
            None,
            &result,
            &now.to_rfc3339(),
        )?;
        let next = schedule
            .next_after(now)
            .ok()
            .flatten()
            .map(|occurrence| occurrence.scheduled_at.to_rfc3339());
        storage.advance_schedule(&record.schedule_id, next.as_deref(), &now.to_rfc3339())?;
        completed += 1;
    }
    Ok(completed)
}

#[derive(Debug)]
pub enum StartupError {
    Io(io::Error),
    Auth(AuthError),
    Storage(StorageError),
}

impl fmt::Display for StartupError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(formatter, "{error}"),
            Self::Auth(error) => write!(formatter, "{error}"),
            Self::Storage(error) => write!(formatter, "{error}"),
        }
    }
}

impl Error for StartupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Auth(error) => Some(error),
            Self::Storage(error) => Some(error),
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

impl From<StorageError> for StartupError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

pub async fn bind(config: ServerConfig) -> Result<BoundServer, StartupError> {
    let requested = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), config.port);
    let listener = TcpListener::bind(requested).await?;
    let address = listener.local_addr()?;
    let authority = PairingAuthority::new(Duration::from_secs(300))?;
    let storage = config
        .state_db
        .map(Database::open)
        .transpose()?
        .map(Arc::new);
    Ok(BoundServer {
        listener,
        address,
        authority,
        storage,
    })
}
