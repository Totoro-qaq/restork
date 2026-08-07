//! Consolidated loopback CLI for the Rust Core.

use std::{
    ffi::{OsStr, OsString},
    fmt,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use futures_util::StreamExt;
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

pub const CLI_HELP: &str = "Restork command line\n\nUsage:\n  restork [global options] pair <CLI_CODE>\n  restork [global options] health\n  restork [global options] schema\n  restork [global options] runs list [--limit <1-100>]\n  restork [global options] runs create --mode <research|study|work> --goal <text> [--provider <id>] [--no-start]\n  restork [global options] runs get <run_id>\n  restork [global options] runs stream <run_id> [--last-event-id <n>]\n  restork [global options] approvals list [--limit <1-100>]\n  restork [global options] memory list [--limit <1-100>]\n  restork [global options] tasks list [--limit <1-100>]\n  restork [global options] radar list [--limit <1-100>]\n  restork [global options] providers list\n  restork [global options] profiles list\n  restork [global options] sessions list [--limit <1-100>]\n  restork [global options] extensions list\n  restork [global options] schedules list [--limit <1-100>]\n  restork [global options] deliverables list [--limit <1-100>]\n\nGlobal options:\n  --url <loopback-url>   Core URL printed by `restorkd serve` (or RESTORK_URL).\n  --token-file <path>   Private CLI token cache (or RESTORK_TOKEN_FILE).\n  --json                Emit compact JSON instead of human-readable output.\n  -h, --help            Show help and execute nothing.\n\nEvery mutating command creates its own bounded idempotency key. Authenticated commands rotate the CLI token automatically. `runs stream` follows live SSE output until the run ends or you press Ctrl+C.\n";

#[derive(Debug)]
pub enum CliError {
    Usage(String),
    Configuration(String),
    Authentication(String),
    Network(String),
    Server { status: StatusCode, detail: String },
    Io(String),
}

impl CliError {
    #[must_use]
    pub const fn exit_code(&self) -> i32 {
        match self {
            Self::Usage(_) | Self::Configuration(_) => 2,
            Self::Authentication(_) => 3,
            Self::Network(_) | Self::Server { .. } | Self::Io(_) => 4,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Usage(detail)
            | Self::Configuration(detail)
            | Self::Authentication(detail)
            | Self::Network(detail)
            | Self::Io(detail) => formatter.write_str(detail),
            Self::Server { status, detail } => {
                write!(formatter, "server returned {status}: {detail}")
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum Command {
    Pair {
        code: String,
    },
    Get {
        path: String,
    },
    CreateRun {
        mode: String,
        goal: String,
        provider: String,
        auto_start: bool,
    },
    StreamRun {
        run_id: String,
        last_event_id: i64,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CliConfig {
    base_url: Url,
    token_file: PathBuf,
    json: bool,
    command: Command,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct TokenDocument {
    base_url: String,
    access_token: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_at: String,
}

pub async fn run(arguments: Vec<OsString>) -> Result<(), CliError> {
    let config = CliConfig::parse(arguments)?;
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| CliError::Configuration("HTTP client could not be initialized".to_owned()))?;
    match config.command.clone() {
        Command::Pair { code } => pair(&client, &config, &code).await,
        Command::Get { path } => {
            let token = rotate_token(&client, &config).await?;
            let value = request_json(&client, &config, Method::GET, &path, &token, None).await?;
            print_value(&value, config.json)
        }
        Command::CreateRun {
            mode,
            goal,
            provider,
            auto_start,
        } => {
            let token = rotate_token(&client, &config).await?;
            let body = json!({
                "mode": mode,
                "goal": goal,
                "provider_profile_id": provider,
                "auto_start": auto_start,
                "allowed_tools": [],
            });
            let value = request_json(
                &client,
                &config,
                Method::POST,
                "/v1/runs",
                &token,
                Some(&body),
            )
            .await?;
            print_value(&value, config.json)
        }
        Command::StreamRun {
            run_id,
            last_event_id,
        } => stream_run(&client, &config, &run_id, last_event_id).await,
    }
}

impl CliConfig {
    fn parse(arguments: Vec<OsString>) -> Result<Self, CliError> {
        let mut arguments = arguments;
        let json = take_flag(&mut arguments, "--json")?;
        let url = take_option(&mut arguments, "--url")?
            .or_else(|| std::env::var_os("RESTORK_URL"))
            .unwrap_or_else(|| OsString::from("http://127.0.0.1:7337"));
        let base_url = parse_loopback_url(&url)?;
        let token_file = take_option(&mut arguments, "--token-file")?
            .or_else(|| std::env::var_os("RESTORK_TOKEN_FILE"))
            .map(PathBuf::from)
            .unwrap_or_else(default_token_file);
        if arguments.is_empty() {
            return Err(CliError::Usage(format!("missing command\n\n{CLI_HELP}")));
        }
        let words = arguments
            .iter()
            .map(|argument| {
                argument
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| CliError::Usage("arguments must be valid Unicode".to_owned()))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let command = parse_command(&words)?;
        Ok(Self {
            base_url,
            token_file,
            json,
            command,
        })
    }
}

fn parse_command(words: &[String]) -> Result<Command, CliError> {
    match words {
        [command] if command == "health" => Ok(get("/v1/health")),
        [command] if command == "schema" => Ok(get("/v1/schema")),
        [command, code] if command == "pair" && !code.is_empty() => {
            Ok(Command::Pair { code: code.clone() })
        }
        [resource, action] if action == "list" => list_command(resource, 20),
        [resource, action, option, limit] if action == "list" && option == "--limit" => {
            list_command(resource, parse_limit(limit)?)
        }
        [resource, action, run_id] if resource == "runs" && action == "get" => {
            validate_identifier(run_id, "run id")?;
            Ok(get(&format!("/v1/runs/{run_id}")))
        }
        [resource, action, run_id, rest @ ..] if resource == "runs" && action == "stream" => {
            validate_identifier(run_id, "run id")?;
            let last_event_id = match rest {
                [] => 0,
                [option, value] if option == "--last-event-id" => value
                    .parse::<i64>()
                    .ok()
                    .filter(|value| *value >= 0)
                    .ok_or_else(|| {
                        CliError::Usage("--last-event-id must be a non-negative integer".to_owned())
                    })?,
                _ => {
                    return Err(CliError::Usage(
                        "usage: restork runs stream <run_id> [--last-event-id <n>]".to_owned(),
                    ));
                }
            };
            Ok(Command::StreamRun {
                run_id: run_id.clone(),
                last_event_id,
            })
        }
        [resource, action, rest @ ..] if resource == "runs" && action == "create" => {
            parse_create_run(rest)
        }
        _ => Err(CliError::Usage(format!(
            "unknown or incomplete command\n\n{CLI_HELP}"
        ))),
    }
}

fn list_command(resource: &str, limit: usize) -> Result<Command, CliError> {
    let path = match resource {
        "runs" => format!("/v1/runs?limit={limit}"),
        "approvals" => format!("/v1/approvals?limit={limit}&pending_only=false"),
        "memory" => format!("/v1/memory?limit={limit}"),
        "tasks" => format!("/v1/tasks?limit={limit}"),
        "radar" => format!("/v1/radar?limit={limit}"),
        "sessions" => format!("/v1/sessions?limit={limit}"),
        "schedules" => format!("/v1/schedules?limit={limit}"),
        "deliverables" => format!("/v1/deliverables?limit={limit}"),
        "providers" => "/v1/providers".to_owned(),
        "profiles" => "/v1/provider-profiles".to_owned(),
        "extensions" => "/v1/extensions".to_owned(),
        _ => {
            return Err(CliError::Usage(format!(
                "`{resource} list` is not a supported list command"
            )));
        }
    };
    Ok(get(&path))
}

fn parse_create_run(arguments: &[String]) -> Result<Command, CliError> {
    let mut mode = None;
    let mut goal = None;
    let mut provider = "deepseek".to_owned();
    let mut auto_start = true;
    let mut index = 0;
    while index < arguments.len() {
        match arguments[index].as_str() {
            "--mode" | "--goal" | "--provider" => {
                let option = arguments[index].as_str();
                let value = arguments
                    .get(index + 1)
                    .ok_or_else(|| CliError::Usage(format!("missing value for {option}")))?;
                match option {
                    "--mode" => mode = Some(value.clone()),
                    "--goal" => goal = Some(value.clone()),
                    "--provider" => provider = value.clone(),
                    _ => unreachable!(),
                }
                index += 2;
            }
            "--no-start" => {
                auto_start = false;
                index += 1;
            }
            unknown => {
                return Err(CliError::Usage(format!(
                    "unknown runs create option `{unknown}`"
                )));
            }
        }
    }
    let mode = mode.ok_or_else(|| CliError::Usage("--mode is required".to_owned()))?;
    if !matches!(mode.as_str(), "research" | "study" | "work") {
        return Err(CliError::Usage(
            "--mode must be research, study, or work".to_owned(),
        ));
    }
    let goal = goal.ok_or_else(|| CliError::Usage("--goal is required".to_owned()))?;
    if goal.trim().is_empty() || goal.len() > 32_000 {
        return Err(CliError::Usage(
            "--goal must be non-empty and at most 32000 bytes".to_owned(),
        ));
    }
    validate_identifier(&provider, "provider id")?;
    Ok(Command::CreateRun {
        mode,
        goal,
        provider,
        auto_start,
    })
}

fn get(path: &str) -> Command {
    Command::Get {
        path: path.to_owned(),
    }
}

fn parse_limit(value: &str) -> Result<usize, CliError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|value| (1..=100).contains(value))
        .ok_or_else(|| CliError::Usage("--limit must be between 1 and 100".to_owned()))
}

fn validate_identifier(value: &str, label: &str) -> Result<(), CliError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(CliError::Usage(format!("invalid {label}")));
    }
    Ok(())
}

fn take_flag(arguments: &mut Vec<OsString>, name: &str) -> Result<bool, CliError> {
    let positions = arguments
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == name).then_some(index))
        .collect::<Vec<_>>();
    if positions.len() > 1 {
        return Err(CliError::Usage(format!("{name} may only be provided once")));
    }
    if let Some(index) = positions.first().copied() {
        arguments.remove(index);
        Ok(true)
    } else {
        Ok(false)
    }
}

fn take_option(arguments: &mut Vec<OsString>, name: &str) -> Result<Option<OsString>, CliError> {
    let Some(index) = arguments.iter().position(|argument| argument == name) else {
        return Ok(None);
    };
    if arguments
        .iter()
        .skip(index + 1)
        .any(|argument| argument == name)
    {
        return Err(CliError::Usage(format!("{name} may only be provided once")));
    }
    if index + 1 >= arguments.len() {
        return Err(CliError::Usage(format!("missing value for {name}")));
    }
    arguments.remove(index);
    Ok(Some(arguments.remove(index)))
}

fn parse_loopback_url(value: &OsStr) -> Result<Url, CliError> {
    let value = value
        .to_str()
        .ok_or_else(|| CliError::Configuration("Core URL must be valid Unicode".to_owned()))?;
    let mut url = Url::parse(value)
        .map_err(|_| CliError::Configuration("Core URL is malformed".to_owned()))?;
    let loopback = url
        .host_str()
        .and_then(|host| host.parse::<std::net::IpAddr>().ok())
        .is_some_and(|address| address.is_loopback())
        || url.host_str() == Some("localhost");
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(CliError::Configuration(
            "Core URL must be an unauthenticated http:// loopback URL".to_owned(),
        ));
    }
    url.set_path("/");
    Ok(url)
}

fn default_token_file() -> PathBuf {
    if let Some(root) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(root).join("restork/cli-token.json");
    }
    if let Some(root) = std::env::var_os("HOME") {
        return PathBuf::from(root).join(".config/restork/cli-token.json");
    }
    PathBuf::from(".restork-cli-token.json")
}

async fn pair(client: &Client, config: &CliConfig, code: &str) -> Result<(), CliError> {
    if code.len() > 256 {
        return Err(CliError::Usage("pairing code is too long".to_owned()));
    }
    let response = client
        .post(join_url(&config.base_url, "/v1/cli/pair")?)
        .json(&json!({"code": code}))
        .send()
        .await
        .map_err(network_error)?;
    let token = parse_token_response(response).await?;
    save_token(config, &token)?;
    if config.json {
        print_value(
            &json!({
                "paired": true,
                "audience": "restork-cli",
                "expires_at": token.expires_at,
            }),
            true,
        )
    } else {
        println!("CLI paired with {}", config.base_url);
        println!(
            "Token expires at {} and will rotate automatically.",
            token.expires_at
        );
        Ok(())
    }
}

async fn rotate_token(client: &Client, config: &CliConfig) -> Result<String, CliError> {
    let cached = load_token(config)?;
    let response = client
        .post(join_url(&config.base_url, "/v1/token/rotate")?)
        .bearer_auth(&cached.access_token)
        .send()
        .await
        .map_err(network_error)?;
    let token = match parse_token_response(response).await {
        Ok(token) => token,
        Err(CliError::Server { status, detail }) if status == StatusCode::UNAUTHORIZED => {
            return Err(CliError::Authentication(format!(
                "{detail}; run `restork --url {} pair <CLI_CODE>` with the current CLI pairing code",
                config.base_url
            )));
        }
        Err(error) => return Err(error),
    };
    save_token(config, &token)?;
    Ok(token.access_token)
}

fn load_token(config: &CliConfig) -> Result<TokenDocument, CliError> {
    let (directory, file_name) = open_token_directory(&config.token_file, false)?;
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = directory.open_with(&file_name, &options).map_err(|error| {
        CliError::Authentication(format!(
            "CLI token is unavailable at {} ({error}); pair this CLI first",
            config.token_file.display()
        ))
    })?;
    let metadata = file.metadata().map_err(|_| {
        CliError::Authentication("CLI token cache metadata is unavailable".to_owned())
    })?;
    const MAX_TOKEN_DOCUMENT_BYTES: u64 = 64 * 1024;
    if !metadata.is_file() || metadata.len() > MAX_TOKEN_DOCUMENT_BYTES {
        return Err(CliError::Authentication(
            "CLI token cache is not a bounded regular file".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_TOKEN_DOCUMENT_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| CliError::Authentication("CLI token cache could not be read".to_owned()))?;
    if bytes.len() as u64 > MAX_TOKEN_DOCUMENT_BYTES {
        return Err(CliError::Authentication(
            "CLI token cache exceeds the size limit".to_owned(),
        ));
    }
    let token: TokenDocument = serde_json::from_slice(&bytes).map_err(|_| {
        CliError::Authentication(format!(
            "CLI token cache at {} is invalid; delete it and pair again",
            config.token_file.display()
        ))
    })?;
    if token.base_url != config.base_url.as_str() {
        return Err(CliError::Authentication(format!(
            "CLI token belongs to {}, not {}; pair with this Core",
            token.base_url, config.base_url
        )));
    }
    Ok(token)
}

fn save_token(config: &CliConfig, token: &TokenResponse) -> Result<(), CliError> {
    let document = TokenDocument {
        base_url: config.base_url.as_str().to_owned(),
        access_token: token.access_token.clone(),
        expires_at: token.expires_at.clone(),
    };
    let bytes = serde_json::to_vec(&document)
        .map_err(|_| CliError::Io("CLI token could not be encoded".to_owned()))?;
    let (directory, file_name) = open_token_directory(&config.token_file, true)?;
    let mut entropy = [0_u8; 12];
    getrandom::fill(&mut entropy)
        .map_err(|_| CliError::Io("secure randomness is unavailable".to_owned()))?;
    let suffix = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = PathBuf::from(format!(".restork-token-{suffix}.tmp"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;

        options.mode(0o600);
    }
    let mut file = directory
        .open_with(&temporary, &options)
        .map_err(|error| CliError::Io(format!("cannot create private token cache: {error}")))?;
    if let Err(error) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = directory.remove_file(&temporary);
        return Err(CliError::Io(format!(
            "cannot write private token cache: {error}"
        )));
    }
    drop(file);
    #[cfg(unix)]
    {
        use cap_std::fs::PermissionsExt;

        if let Err(error) =
            directory.set_permissions(&temporary, cap_std::fs::Permissions::from_mode(0o600))
        {
            let _ = directory.remove_file(&temporary);
            return Err(CliError::Io(format!("cannot protect token cache: {error}")));
        }
    }
    if let Err(error) = directory.rename(&temporary, &directory, &file_name) {
        let _ = directory.remove_file(&temporary);
        return Err(CliError::Io(format!("cannot replace token cache: {error}")));
    }
    Ok(())
}

fn open_token_directory(
    token_file: &Path,
    create_parent: bool,
) -> Result<(Dir, OsString), CliError> {
    let file_name = token_file
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CliError::Configuration("token cache must name a file".to_owned()))?
        .to_os_string();
    if Path::new(&file_name).components().count() != 1 {
        return Err(CliError::Configuration(
            "token cache filename is invalid".to_owned(),
        ));
    }
    let parent = token_file
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    if create_parent {
        Dir::create_ambient_dir_all(parent, ambient_authority()).map_err(|error| {
            CliError::Io(format!(
                "cannot create token directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    let canonical_parent = parent.canonicalize().map_err(|error| {
        CliError::Io(format!(
            "cannot access token directory {}: {error}",
            parent.display()
        ))
    })?;
    let directory =
        Dir::open_ambient_dir(&canonical_parent, ambient_authority()).map_err(|error| {
            CliError::Io(format!(
                "cannot open token directory {}: {error}",
                canonical_parent.display()
            ))
        })?;
    match directory.symlink_metadata(&file_name) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(CliError::Io(
                "token cache must be a regular file, not a symlink".to_owned(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(CliError::Io(format!("cannot inspect token cache: {error}")));
        }
    }
    Ok((directory, file_name))
}

async fn request_json(
    client: &Client,
    config: &CliConfig,
    method: Method,
    path: &str,
    token: &str,
    body: Option<&Value>,
) -> Result<Value, CliError> {
    let mut request = client
        .request(method.clone(), join_url(&config.base_url, path)?)
        .bearer_auth(token);
    if matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    ) {
        request = request.header("idempotency-key", idempotency_key()?);
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request.send().await.map_err(network_error)?;
    parse_json_response(response).await
}

async fn stream_run(
    client: &Client,
    config: &CliConfig,
    run_id: &str,
    last_event_id: i64,
) -> Result<(), CliError> {
    let token = rotate_token(client, config).await?;
    let stream_client = Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| {
            CliError::Configuration("stream client could not be initialized".to_owned())
        })?;
    let response = stream_client
        .get(join_url(
            &config.base_url,
            &format!("/v1/runs/{run_id}/events?follow=true"),
        )?)
        .bearer_auth(token)
        .header("last-event-id", last_event_id.to_string())
        .send()
        .await
        .map_err(network_error)?;
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    let mut stream = response.bytes_stream();
    let mut stdout = io::stdout().lock();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        stdout
            .write_all(&chunk)
            .and_then(|()| stdout.flush())
            .map_err(|error| CliError::Io(format!("cannot write stream output: {error}")))?;
    }
    Ok(())
}

async fn parse_token_response(response: reqwest::Response) -> Result<TokenResponse, CliError> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    response
        .json::<TokenResponse>()
        .await
        .map_err(|_| CliError::Server {
            status: StatusCode::BAD_GATEWAY,
            detail: "Core returned an invalid token document".to_owned(),
        })
}

async fn parse_json_response(response: reqwest::Response) -> Result<Value, CliError> {
    if !response.status().is_success() {
        return Err(response_error(response).await);
    }
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(json!({"ok": true}));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| CliError::Server {
            status: StatusCode::BAD_GATEWAY,
            detail: "Core returned a non-JSON response".to_owned(),
        })
}

async fn response_error(response: reqwest::Response) -> CliError {
    let status = response.status();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(_) => {
            return CliError::Server {
                status,
                detail: "response body was unavailable".to_owned(),
            };
        }
    };
    let detail = error_detail(&bytes).unwrap_or_else(|| {
        String::from_utf8_lossy(&bytes)
            .trim()
            .chars()
            .take(2_000)
            .collect()
    });
    CliError::Server {
        status,
        detail: if detail.is_empty() {
            "request failed without a detail".to_owned()
        } else {
            detail
        },
    }
}

fn error_detail(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<Value>(bytes)
        .ok()?
        .get("detail")?
        .as_str()
        .map(str::to_owned)
}

fn network_error(error: reqwest::Error) -> CliError {
    if error.is_timeout() {
        CliError::Network(
            "Core request timed out; verify the printed URL and Core health".to_owned(),
        )
    } else if error.is_connect() {
        CliError::Network(
            "cannot reach the loopback Core; start `restorkd serve` and pass its printed --url"
                .to_owned(),
        )
    } else {
        CliError::Network("Core connection failed before a complete response arrived".to_owned())
    }
}

fn join_url(base: &Url, path: &str) -> Result<Url, CliError> {
    base.join(path)
        .map_err(|_| CliError::Configuration("request path is invalid".to_owned()))
}

fn idempotency_key() -> Result<String, CliError> {
    let mut bytes = [0_u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|_| CliError::Configuration("secure randomness is unavailable".to_owned()))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn print_value(value: &Value, json_output: bool) -> Result<(), CliError> {
    let output = if json_output {
        serde_json::to_string(value)
    } else {
        serde_json::to_string_pretty(value)
    }
    .map_err(|_| CliError::Io("response could not be encoded".to_owned()))?;
    println!("{output}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_loopback_core_urls() {
        assert!(parse_loopback_url(OsStr::new("https://example.com")).is_err());
        assert!(parse_loopback_url(OsStr::new("http://127.0.0.1:7337")).is_ok());
    }

    #[test]
    fn parses_run_creation_and_generates_a_default_profile() {
        let command = parse_command(&[
            "runs".to_owned(),
            "create".to_owned(),
            "--mode".to_owned(),
            "research".to_owned(),
            "--goal".to_owned(),
            "Find evidence".to_owned(),
        ])
        .expect("valid command");
        assert_eq!(
            command,
            Command::CreateRun {
                mode: "research".to_owned(),
                goal: "Find evidence".to_owned(),
                provider: "deepseek".to_owned(),
                auto_start: true,
            }
        );
    }

    #[test]
    fn preserves_server_detail_verbatim() {
        assert_eq!(
            error_detail(br#"{"detail":"Vault is not configured; restart with --vault-dir"}"#),
            Some("Vault is not configured; restart with --vault-dir".to_owned())
        );
    }

    #[test]
    fn token_cache_round_trip_uses_a_private_regular_file() {
        let directory = tempfile::tempdir().expect("token directory");
        let token_file = directory.path().join("token.json");
        let config = CliConfig {
            base_url: Url::parse("http://127.0.0.1:7337").expect("loopback URL"),
            token_file: token_file.clone(),
            json: true,
            command: Command::Get {
                path: "/v1/health".to_owned(),
            },
        };
        let token = TokenResponse {
            access_token: "private-token".to_owned(),
            expires_at: "2026-08-07T00:00:00Z".to_owned(),
        };

        save_token(&config, &token).expect("save token");
        let loaded = load_token(&config).expect("load token");
        assert_eq!(loaded.access_token, token.access_token);
        assert_eq!(loaded.base_url, config.base_url.as_str());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            assert_eq!(
                std::fs::metadata(token_file)
                    .expect("token metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn token_cache_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("token directory");
        let outside = tempfile::NamedTempFile::new().expect("outside token");
        let token_file = directory.path().join("token.json");
        symlink(outside.path(), &token_file).expect("token symlink");
        let config = CliConfig {
            base_url: Url::parse("http://127.0.0.1:7337").expect("loopback URL"),
            token_file,
            json: true,
            command: Command::Get {
                path: "/v1/health".to_owned(),
            },
        };
        let token = TokenResponse {
            access_token: "private-token".to_owned(),
            expires_at: "2026-08-07T00:00:00Z".to_owned(),
        };

        assert!(matches!(save_token(&config, &token), Err(CliError::Io(_))));
        assert_eq!(std::fs::read(outside.path()).expect("outside file"), b"");
    }
}
