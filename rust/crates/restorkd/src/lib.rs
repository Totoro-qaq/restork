//! Process lifecycle and loopback listener ownership for `restorkd`.

pub mod cli;
pub mod desktop;

use std::{
    env,
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

use cap_std::{ambient_authority, fs::Dir};
use chrono::{DateTime, Utc};
use restork_automation::{ScheduleJob, ScheduleSpec};
use restork_core::auth::Audience;
use restork_core::auth::{
    AuthError, CLI_SCOPES, DEFAULT_PAIRING_TTL, DEFAULT_TOKEN_TTL, PairingAuthority,
};
use restork_storage::{Database, StorageError};
use serde::Serialize;
use tokio::net::TcpListener;

pub const HELP: &str = "Restork local runtime\n\nUsage:\n  restorkd [--json] serve [--port <0-65535>] [--state-db <path>] [--vault-dir <path>]\n  restorkd provider configure [deepseek|glm|kimi|qwen|openrouter|open_ai_compatible]\n  restorkd doctor [--connect | --smoke | --web-search]\n  restorkd music apple configure\n  restorkd music apple configure-user-token\n  restorkd music apple status\n\nGlobal options:\n  --json        Emit the serve readiness record as JSON.\n  -h, --help    Show this help without executing a command.\n\nServe options:\n  --port <n>        Bind the chosen loopback port; 0 asks the OS for a free port.\n  --state-db <path> Open durable state at this path.\n  --vault-dir <dir> Grant read/write policy access only to this existing directory.\n\nThe listener is always bound to 127.0.0.1. Provider and Apple Music setup delegate secret prompts to native credential storage.\n";

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ServerConfig {
    pub port: u16,
    pub state_db: Option<PathBuf>,
    pub vault_dir: Option<PathBuf>,
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
        let mut vault_dir = None;
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
                "--vault-dir" => {
                    if vault_dir.is_some() {
                        return Err(ConfigError::DuplicateArgument("--vault-dir"));
                    }
                    let value = args
                        .next()
                        .ok_or(ConfigError::MissingValue("--vault-dir"))?;
                    let path = PathBuf::from(value.as_ref());
                    if path.as_os_str().is_empty() {
                        return Err(ConfigError::MissingValue("--vault-dir"));
                    }
                    vault_dir = Some(path);
                }
                unknown => return Err(ConfigError::UnknownArgument(unknown.to_owned())),
            }
        }
        Ok(Self {
            port,
            state_db,
            vault_dir,
        })
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
    pub cli_pairing_code: String,
}

pub struct BoundServer {
    listener: TcpListener,
    address: SocketAddr,
    authority: PairingAuthority,
    cli_pairing_code: String,
    storage: Arc<Database>,
    vault_dir: Option<PathBuf>,
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
            cli_pairing_code: self.cli_pairing_code.clone(),
        }
    }

    pub async fn serve_until<F>(self, shutdown: F) -> io::Result<()>
    where
        F: Future<Output = ()> + Send + 'static,
    {
        let scheduler_storage = Arc::clone(&self.storage);
        let scheduler = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(15));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                let _ = run_due_schedules_once(&scheduler_storage, Utc::now()).await;
            }
        });
        let router = restork_api::router_with_runtime(
            self.authority.clone(),
            self.storage,
            self.vault_dir.clone(),
        );
        let result = axum::serve(self.listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
        scheduler.abort();
        result
    }
}

/// Execute due jobs once. Every job is bounded and uses a stable period key so
/// restart recovery can replay work without duplicating a draft.
pub async fn run_due_schedules_once(
    storage: &Database,
    now: DateTime<Utc>,
) -> Result<usize, StorageError> {
    let mut due = storage.due_schedules(&now.to_rfc3339(), 32)?;
    // A provider call can legitimately take two minutes. Local maintenance
    // must run first, and only one paid model draft may start per scheduler
    // tick so a backlog cannot multiply latency or spend.
    due.sort_by_key(|record| record.schedule["job"]["kind"] == "model_draft");
    let mut completed = 0;
    let mut model_draft_started = false;
    for record in due {
        let Ok(schedule) = serde_json::from_value::<ScheduleSpec>(record.schedule) else {
            let _ = storage.advance_schedule(
                &record.schedule_id,
                record.revision,
                record.next_run_at.as_deref(),
                None,
                &now.to_rfc3339(),
            );
            continue;
        };
        let Some(scheduled_at) = record
            .next_run_at
            .as_deref()
            .and_then(|value| value.parse::<DateTime<Utc>>().ok())
        else {
            let _ = storage.advance_schedule(
                &record.schedule_id,
                record.revision,
                record.next_run_at.as_deref(),
                None,
                &now.to_rfc3339(),
            );
            continue;
        };
        if matches!(&schedule.job, ScheduleJob::ModelDraft { .. }) {
            if model_draft_started {
                continue;
            }
            model_draft_started = true;
        }
        let period_key = format!("scheduled:{}", scheduled_at.timestamp());
        let mut run_was_recorded = false;
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
            ScheduleJob::Deterministic { .. } => {
                serde_json::json!({
                    "state": "rejected",
                    "reason": "job is outside the safe scheduler contract",
                    "external_effect": false,
                })
            }
            ScheduleJob::ModelDraft { .. } => {
                let claim = serde_json::json!({
                    "state": "running",
                    "claim_token": format!(
                        "claim:{}:{}",
                        record.schedule_id,
                        now.timestamp_nanos_opt().unwrap_or_default(),
                    ),
                    "provider_call": false,
                    "network_effect": false,
                    "manual": false,
                });
                let claimed = storage.claim_schedule_run(
                    &record.schedule_id,
                    &period_key,
                    &claim,
                    &now.to_rfc3339(),
                )?;
                run_was_recorded = true;
                if claimed.replayed {
                    claimed.result
                } else {
                    let result = restork_api::execute_scheduled_model_draft(
                        storage,
                        &schedule,
                        &period_key,
                        false,
                    )
                    .await;
                    storage
                        .complete_schedule_run(&record.schedule_id, &period_key, &claim, &result)?
                        .result
                }
            }
        };
        if !run_was_recorded {
            storage.record_schedule_run(
                &record.schedule_id,
                &period_key,
                None,
                &result,
                &now.to_rfc3339(),
            )?;
        }
        let next = schedule
            .next_after(now)
            .ok()
            .flatten()
            .map(|occurrence| occurrence.scheduled_at.to_rfc3339());
        let _ = storage.advance_schedule(
            &record.schedule_id,
            record.revision,
            record.next_run_at.as_deref(),
            next.as_deref(),
            &now.to_rfc3339(),
        )?;
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
    // A pairing code is read off a terminal and typed into a browser; an access
    // token is renewed by the client. One 300-second value for both made the CLI
    // unusable five minutes after pairing, because it has no renewal path.
    let authority = PairingAuthority::with_ttls(DEFAULT_PAIRING_TTL, DEFAULT_TOKEN_TTL)?;
    let cli_pairing_code = authority.new_pairing_code(Audience::Cli, CLI_SCOPES)?;
    let vault_dir = config
        .vault_dir
        .map(|path| path.canonicalize())
        .transpose()?;
    if vault_dir.as_ref().is_some_and(|path| !path.is_dir()) {
        return Err(StartupError::Io(io::Error::new(
            io::ErrorKind::InvalidInput,
            "--vault-dir must name an existing directory",
        )));
    }
    let state_db = match config.state_db {
        Some(path) => path,
        None => default_state_database()?,
    };
    let storage = Arc::new(Database::open(state_db)?);
    Ok(BoundServer {
        listener,
        address,
        authority,
        cli_pairing_code,
        storage,
        vault_dir,
    })
}

fn default_state_database() -> io::Result<PathBuf> {
    let data_directory = if let Some(configured) =
        env::var_os("RESTORK_DATA_DIR").filter(|value| !value.is_empty())
    {
        PathBuf::from(configured)
    } else {
        platform_data_directory()?
    };
    Dir::create_ambient_dir_all(&data_directory, ambient_authority())?;
    let directory = Dir::open_ambient_dir(&data_directory, ambient_authority())?;
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;

        directory.set_permissions(".", cap_std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(data_directory.join("restork.db"))
}

#[cfg(target_os = "macos")]
fn platform_data_directory() -> io::Result<PathBuf> {
    environment_directory("HOME")
        .map(|path| path.join("Library/Application Support/io.github.totoro-qaq.restork"))
}

#[cfg(windows)]
fn platform_data_directory() -> io::Result<PathBuf> {
    environment_directory("LOCALAPPDATA").map(|path| path.join("io.github.totoro-qaq.restork"))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_data_directory() -> io::Result<PathBuf> {
    if let Some(path) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(path).join("restork"));
    }
    environment_directory("HOME").map(|path| path.join(".local/share/restork"))
}

#[cfg(not(any(unix, windows)))]
fn platform_data_directory() -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "set RESTORK_DATA_DIR before starting Restork on this platform",
    ))
}

fn environment_directory(name: &'static str) -> io::Result<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                format!("{name} is unavailable; set RESTORK_DATA_DIR explicitly"),
            )
        })
}
