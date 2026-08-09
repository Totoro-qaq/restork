//! Bounded provider transport and native secret resolution.
//!
//! Provider configuration contains only a native secret reference. Secret
//! values are resolved just-in-time, never serialized, and zeroized on drop.

mod secrets;

use std::{
    collections::{BTreeMap, BTreeSet},
    net::IpAddr,
    pin::Pin,
    time::{Duration, Instant},
};

use futures_util::{Stream, StreamExt};
use reqwest::{
    Client, RequestBuilder, StatusCode,
    header::{HeaderMap, RETRY_AFTER},
    redirect::Policy,
};
use restork_personal::{
    ModelDiscovery, ProviderAuthKind, ProviderKind, ProviderProfile, ProviderProtocol,
    ProviderRequestAdapter, ReasoningEffort,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use url::Url;

pub use secrets::{NativeSecretStore, SecretError};

const WEB_SEARCH_RESPONSE_MAX_BYTES: usize = 2 * 1024 * 1024;
const WEB_SEARCH_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProviderError {
    Configuration,
    CredentialMissing,
    Authentication,
    InsufficientBalance,
    RateLimited,
    Timeout,
    Unavailable,
    ModelUnavailable,
    InvalidResponse,
    Incomplete,
    WebSearchNotExecuted,
    StructuredOutputInvalid,
    SourcesMissing,
    PolicyDenied,
}

impl ProviderError {
    #[must_use]
    pub const fn status(&self) -> &'static str {
        match self {
            Self::Configuration => "invalid_configuration",
            Self::CredentialMissing => "credential_missing",
            Self::Authentication => "authentication_failed",
            Self::InsufficientBalance => "insufficient_balance",
            Self::RateLimited => "rate_limited",
            Self::Timeout => "timeout",
            Self::Unavailable => "provider_unavailable",
            Self::ModelUnavailable => "model_unavailable",
            Self::InvalidResponse => "invalid_response",
            Self::Incomplete => "incomplete",
            Self::WebSearchNotExecuted => "web_search_not_executed",
            Self::StructuredOutputInvalid => "structured_output_invalid",
            Self::SourcesMissing => "sources_missing",
            Self::PolicyDenied => "policy_denied",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderDiagnostic {
    pub schema_version: u8,
    pub provider: String,
    pub model: String,
    pub status: String,
    pub message: String,
    pub setup_command: String,
    pub config_present: bool,
    pub config_valid: bool,
    pub credential_present: bool,
    pub connection_checked: bool,
    pub connection_ok: Option<bool>,
    pub model_available: Option<bool>,
    pub smoke_checked: bool,
    pub smoke_ok: Option<bool>,
    pub restart_required: bool,
    pub latency_ms: Option<u64>,
    pub request_id: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ProviderModel {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ProviderModelCatalog {
    pub registry_version: u16,
    pub provider_kind: String,
    pub discovery: String,
    pub manual_entry: bool,
    pub models: Vec<ProviderModel>,
    pub latency_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

impl ChatMessage {
    #[must_use]
    pub fn text(role: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
            reasoning_content: None,
        }
    }

    #[must_use]
    pub fn tool_result(tool_call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            role: "tool".to_owned(),
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(tool_call_id.into()),
            reasoning_content: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ChatTool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct SamplingControls {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub seed: Option<i64>,
    #[serde(default)]
    pub stop: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatToolChoice {
    #[default]
    Auto,
    None,
    Required,
    Function(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ChatOptions {
    #[serde(default)]
    pub tools: Vec<ChatTool>,
    #[serde(default)]
    pub tool_choice: ChatToolChoice,
    pub parallel_tool_calls: Option<bool>,
    #[serde(default)]
    pub sampling: SamplingControls,
    #[serde(default)]
    pub retry: ChatRetryPolicy,
}

impl Default for ChatOptions {
    fn default() -> Self {
        Self {
            tools: Vec::new(),
            tool_choice: ChatToolChoice::Auto,
            parallel_tool_calls: None,
            sampling: SamplingControls::default(),
            retry: ChatRetryPolicy::Disabled,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatRetryPolicy {
    #[default]
    Disabled,
    Bounded,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatCompletion {
    pub content: String,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    pub reasoning_content: Option<String>,
    pub finish_reason: Option<String>,
    pub latency_ms: u64,
    pub request_id: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd_micros: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ChatChunk {
    pub content: String,
    pub reasoning_content: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub cost_usd_micros: Option<u64>,
}

pub type ChatEventStream =
    Pin<Box<dyn Stream<Item = Result<ChatChunk, ProviderError>> + Send + 'static>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WebCitation {
    pub title: String,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WebSearchCompletion {
    pub content: String,
    pub citations: Vec<WebCitation>,
    pub model: String,
    pub latency_ms: u64,
    pub request_id: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

pub struct WebSearchRequest<'a> {
    pub instructions: &'a str,
    pub input: &'a str,
    pub schema_name: &'a str,
    pub response_schema: &'a Value,
    pub max_output_tokens: u32,
    pub reasoning_effort: &'a str,
    pub require_sources: bool,
}

pub struct ProviderClient {
    client: Client,
    web_client: Client,
    secrets: NativeSecretStore,
}

/// Bounded, redirect-free HTTP gateway for explicitly allowlisted public JSON sources.
#[derive(Clone)]
pub struct PublicWebGateway {
    client: Client,
}

impl PublicWebGateway {
    pub fn new() -> Result<Self, ProviderError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(20))
            .redirect(Policy::none())
            .no_proxy()
            .user_agent(concat!("restork/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ProviderError::Configuration)?;
        Ok(Self { client })
    }

    pub async fn get_json(&self, url: &str) -> Result<Value, ProviderError> {
        let parsed = Url::parse(url).map_err(|_| ProviderError::PolicyDenied)?;
        if parsed.scheme() != "https"
            || parsed.username() != ""
            || parsed.password().is_some()
            || parsed.fragment().is_some()
            || !matches!(
                parsed.host_str(),
                Some("api.github.com" | "hacker-news.firebaseio.com")
            )
        {
            return Err(ProviderError::PolicyDenied);
        }
        let response = self
            .client
            .get(parsed)
            .send()
            .await
            .map_err(map_transport)?;
        let status = response.status();
        let length = response.content_length();
        if length.is_some_and(|length| length > 2 * 1024 * 1024) {
            return Err(ProviderError::InvalidResponse);
        }
        let bytes = response.bytes().await.map_err(map_transport)?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err(ProviderError::InvalidResponse);
        }
        let payload =
            serde_json::from_slice::<Value>(&bytes).map_err(|_| ProviderError::InvalidResponse)?;
        map_status(status, &payload)?;
        Ok(payload)
    }
}

impl ProviderClient {
    pub fn new() -> Result<Self, ProviderError> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .redirect(Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| ProviderError::Configuration)?;
        let web_client = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(WEB_SEARCH_TIMEOUT)
            .redirect(Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| ProviderError::Configuration)?;
        Ok(Self {
            client,
            web_client,
            secrets: NativeSecretStore,
        })
    }

    pub async fn diagnose(&self, profile: &ProviderProfile, smoke: bool) -> ProviderDiagnostic {
        let started = Instant::now();
        let result = if smoke {
            let smoke_profile = fixed_smoke_profile(profile);
            self.chat(
                &smoke_profile,
                &[ChatMessage::text("user", "Reply with exactly OK.")],
                16,
            )
            .await
            .and_then(|completion| {
                if completion.content.trim() != "OK" {
                    return Err(ProviderError::InvalidResponse);
                }
                Ok(DiagnosticSuccess {
                    request_id: completion.request_id,
                    prompt_tokens: completion.prompt_tokens,
                    completion_tokens: completion.completion_tokens,
                    total_tokens: completion.total_tokens,
                    connection_checked: true,
                    model_available: Some(true),
                })
            })
        } else {
            self.check_models(profile).await
        };
        match result {
            Ok(success) => ProviderDiagnostic {
                schema_version: 1,
                provider: profile.profile_id().to_owned(),
                model: profile.model().to_owned(),
                status: if smoke {
                    "smoke_passed"
                } else if success.connection_checked {
                    "connected"
                } else {
                    "manual_model_ready"
                }
                .to_owned(),
                message: if smoke {
                    "The fixed public low-token completion passed."
                } else if success.connection_checked {
                    "Authentication succeeded and the configured model is available."
                } else {
                    "This provider uses manual model entry; run the optional smoke test to verify it."
                }
                .to_owned(),
                setup_command: provider_setup_command(profile),
                config_present: true,
                config_valid: true,
                credential_present: profile.secret_ref().is_some(),
                connection_checked: success.connection_checked,
                connection_ok: success.connection_checked.then_some(true),
                model_available: success.model_available,
                smoke_checked: smoke,
                smoke_ok: smoke.then_some(true),
                restart_required: false,
                latency_ms: Some(elapsed_ms(started)),
                request_id: success.request_id,
                prompt_tokens: success.prompt_tokens,
                completion_tokens: success.completion_tokens,
                total_tokens: success.total_tokens,
            },
            Err(error) => ProviderDiagnostic {
                schema_version: 1,
                provider: profile.profile_id().to_owned(),
                model: profile.model().to_owned(),
                status: error.status().to_owned(),
                message: safe_message(&error).to_owned(),
                setup_command: provider_setup_command(profile),
                config_present: true,
                config_valid: !matches!(error, ProviderError::Configuration),
                credential_present: !matches!(error, ProviderError::CredentialMissing),
                connection_checked: !matches!(
                    error,
                    ProviderError::CredentialMissing
                        | ProviderError::Configuration
                        | ProviderError::PolicyDenied
                ),
                connection_ok: match error {
                    ProviderError::CredentialMissing
                    | ProviderError::Configuration
                    | ProviderError::PolicyDenied => None,
                    _ => Some(false),
                },
                model_available: matches!(error, ProviderError::ModelUnavailable).then_some(false),
                smoke_checked: smoke,
                smoke_ok: smoke.then_some(false),
                restart_required: false,
                latency_ms: Some(elapsed_ms(started)),
                request_id: None,
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
            },
        }
    }

    pub async fn diagnose_web_search(&self, profile: &ProviderProfile) -> ProviderDiagnostic {
        let started = Instant::now();
        let result = self
            .web_search(
                profile,
                WebSearchRequest {
                    instructions: "Use web search to find the official DeepSeek Responses API documentation. Return only the requested JSON object, including the official public HTTPS documentation source.",
                    input: "This is a public synthetic capability test. Return RESTORK_WEB_OK only after a server-side web search finds the official DeepSeek API documentation, and include at least one source object with title and URL.",
                    schema_name: "restork_web_search_smoke",
                    response_schema: &json!({
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "result": {"type": "string", "enum": ["RESTORK_WEB_OK"]},
                            "sources": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 3,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "properties": {
                                        "title": {"type": "string"},
                                        "url": {"type": "string"}
                                    },
                                    "required": ["title", "url"]
                                }
                            }
                        },
                        "required": ["result", "sources"]
                    }),
                    // V4 maps low/medium effort to high and counts hidden reasoning
                    // against this budget. A tiny cap can complete the search but
                    // truncate the JSON envelope before the visible result begins.
                    max_output_tokens: 4_096,
                    reasoning_effort: "high",
                    require_sources: false,
                },
            )
            .await;
        match result {
            Ok(completion) => ProviderDiagnostic {
                schema_version: 1,
                provider: profile.profile_id().to_owned(),
                model: "deepseek-v4-flash".to_owned(),
                status: "smoke_passed".to_owned(),
                message: "The public V4 Flash server-side web-search test passed.".to_owned(),
                setup_command: provider_setup_command(profile),
                config_present: true,
                config_valid: true,
                credential_present: true,
                connection_checked: true,
                connection_ok: Some(true),
                model_available: Some(true),
                smoke_checked: true,
                smoke_ok: Some(true),
                restart_required: false,
                latency_ms: Some(elapsed_ms(started)),
                request_id: completion.request_id,
                prompt_tokens: completion.prompt_tokens,
                completion_tokens: completion.completion_tokens,
                total_tokens: completion.total_tokens,
            },
            Err(error) => ProviderDiagnostic {
                schema_version: 1,
                provider: profile.profile_id().to_owned(),
                model: "deepseek-v4-flash".to_owned(),
                status: error.status().to_owned(),
                message: safe_message(&error).to_owned(),
                setup_command: provider_setup_command(profile),
                config_present: true,
                config_valid: !matches!(error, ProviderError::Configuration),
                credential_present: !matches!(error, ProviderError::CredentialMissing),
                connection_checked: !matches!(
                    error,
                    ProviderError::CredentialMissing
                        | ProviderError::Configuration
                        | ProviderError::PolicyDenied
                ),
                connection_ok: match error {
                    ProviderError::CredentialMissing
                    | ProviderError::Configuration
                    | ProviderError::PolicyDenied => None,
                    _ => Some(false),
                },
                model_available: matches!(error, ProviderError::ModelUnavailable).then_some(false),
                smoke_checked: true,
                smoke_ok: Some(false),
                restart_required: false,
                latency_ms: Some(elapsed_ms(started)),
                request_id: None,
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
            },
        }
    }

    /// Check native credential availability without exposing the credential to callers.
    pub async fn credential_present(&self, profile: &ProviderProfile) -> bool {
        match profile.kind().definition().auth_kind {
            ProviderAuthKind::None => true,
            ProviderAuthKind::Bearer => {
                let Some(reference) = profile.secret_ref() else {
                    return false;
                };
                self.secrets.exists(reference).await
            }
        }
    }

    pub async fn chat(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
    ) -> Result<ChatCompletion, ProviderError> {
        self.chat_with_options(profile, messages, max_tokens, &ChatOptions::default())
            .await
    }

    pub async fn chat_with_options(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
        options: &ChatOptions,
    ) -> Result<ChatCompletion, ProviderError> {
        validate_chat_request(profile, messages, max_tokens, options)?;
        match profile.kind().definition().protocol {
            ProviderProtocol::OllamaChat => {
                self.chat_ollama(profile, messages, max_tokens, options)
                    .await
            }
            ProviderProtocol::OpenAiChatCompletions => {
                self.chat_openai(profile, messages, max_tokens, options)
                    .await
            }
        }
    }

    pub async fn chat_stream(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
        options: &ChatOptions,
    ) -> Result<ChatEventStream, ProviderError> {
        validate_chat_request(profile, messages, max_tokens, options)?;
        let protocol = profile.kind().definition().protocol;
        let request = match protocol {
            ProviderProtocol::OpenAiChatCompletions => {
                let secret = self.resolve_secret(profile).await?;
                self.client
                    .post(format!("{}/chat/completions", profile.base_url()))
                    .bearer_auth(secret.expose())
                    .json(&build_openai_chat_request_with_options(
                        profile, messages, max_tokens, options, true,
                    )?)
            }
            ProviderProtocol::OllamaChat => self
                .client
                .post(format!("{}/api/chat", profile.base_url()))
                .json(&build_ollama_chat_request_with_options(
                    profile, messages, max_tokens, options, true,
                )?),
        };
        let response = send_chat_request(request, options.retry).await?;
        let status = response.status();
        if !status.is_success() {
            let payload = response
                .json::<Value>()
                .await
                .map_err(|_| ProviderError::InvalidResponse)?;
            return Err(map_status(status, &payload)
                .err()
                .unwrap_or(ProviderError::InvalidResponse));
        }
        let state = ChatStreamState {
            body: Box::pin(response.bytes_stream()),
            buffer: Vec::new(),
            protocol,
            model: profile.model().to_owned(),
            tool_calls: BTreeMap::new(),
            finished: false,
        };
        Ok(Box::pin(futures_util::stream::unfold(
            state,
            |mut state| async move {
                loop {
                    if state.finished {
                        return None;
                    }
                    if let Some(frame) = take_stream_frame(&mut state) {
                        match frame {
                            Ok(frame) => match parse_stream_frame(&mut state, &frame) {
                                Ok(Some(chunk)) => return Some((Ok(chunk), state)),
                                Ok(None) => continue,
                                Err(error) => {
                                    state.finished = true;
                                    return Some((Err(error), state));
                                }
                            },
                            Err(error) => {
                                state.finished = true;
                                return Some((Err(error), state));
                            }
                        }
                    }
                    match state.body.next().await {
                        Some(Ok(bytes)) => {
                            if state.buffer.len().saturating_add(bytes.len()) > 4_000_000 {
                                state.finished = true;
                                return Some((Err(ProviderError::InvalidResponse), state));
                            }
                            state.buffer.extend_from_slice(&bytes);
                        }
                        Some(Err(error)) => {
                            state.finished = true;
                            return Some((Err(map_transport(error)), state));
                        }
                        None => {
                            if state.buffer.is_empty() {
                                return None;
                            }
                            state.buffer.push(b'\n');
                        }
                    }
                }
            },
        )))
    }

    pub async fn models(
        &self,
        profile: &ProviderProfile,
    ) -> Result<ProviderModelCatalog, ProviderError> {
        let started = Instant::now();
        let definition = profile.kind().definition();
        let models = match definition.model_discovery {
            ModelDiscovery::ManualOnly => Vec::new(),
            ModelDiscovery::OllamaTags => {
                let response = self
                    .send_idempotent(self.client.get(format!("{}/api/tags", profile.base_url())))
                    .await?;
                let status = response.status();
                let payload: Value = response
                    .json()
                    .await
                    .map_err(|_| ProviderError::InvalidResponse)?;
                map_status(status, &payload)?;
                parse_ollama_models(&payload)?
            }
            ModelDiscovery::OpenAiModels => {
                let secret = self.resolve_secret(profile).await?;
                let response = self
                    .send_idempotent(
                        self.client
                            .get(format!("{}/models", profile.base_url()))
                            .bearer_auth(secret.expose()),
                    )
                    .await?;
                let status = response.status();
                let payload: Value = response
                    .json()
                    .await
                    .map_err(|_| ProviderError::InvalidResponse)?;
                map_status(status, &payload)?;
                parse_openai_models(&payload)?
            }
        };
        Ok(ProviderModelCatalog {
            registry_version: definition.registry_version,
            provider_kind: definition.id.to_owned(),
            discovery: match definition.model_discovery {
                ModelDiscovery::OpenAiModels => "open_ai_models",
                ModelDiscovery::OllamaTags => "ollama_tags",
                ModelDiscovery::ManualOnly => "manual_only",
            }
            .to_owned(),
            manual_entry: matches!(definition.model_discovery, ModelDiscovery::ManualOnly),
            models,
            latency_ms: elapsed_ms(started),
        })
    }

    /// Run one explicit DeepSeek Responses request with mandatory server-side web search.
    ///
    /// This paid, non-idempotent request is never retried automatically. Callers must expose a
    /// user-started retry and preserve the last valid local cache.
    pub async fn web_search(
        &self,
        profile: &ProviderProfile,
        request: WebSearchRequest<'_>,
    ) -> Result<WebSearchCompletion, ProviderError> {
        if profile.kind() != ProviderKind::DeepSeek
            || profile.base_url() != "https://api.deepseek.com"
            || request.instructions.is_empty()
            || request.instructions.len() > 16_000
            || request.input.is_empty()
            || request.input.len() > 16_000
            || request.schema_name.is_empty()
            || request.schema_name.len() > 64
            || !request
                .schema_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
            || !(1..=8_192).contains(&request.max_output_tokens)
            || !matches!(request.reasoning_effort, "low" | "medium" | "high" | "max")
            || !request.response_schema.is_object()
        {
            return Err(ProviderError::PolicyDenied);
        }
        let secret = self.resolve_secret(profile).await?;
        let started = Instant::now();
        let response = self
            .web_client
            .post(format!("{}/responses", profile.base_url()))
            .bearer_auth(secret.expose())
            .json(&json!({
                "model": "deepseek-v4-flash",
                "instructions": request.instructions,
                "input": request.input,
                "tools": [{"type": "web_search"}],
                "tool_choice": {"type": "web_search"},
                "reasoning": {"effort": request.reasoning_effort},
                "text": {
                    "format": {
                        "type": "json_schema",
                        "name": request.schema_name,
                        "strict": true,
                        "schema": request.response_schema,
                    }
                },
                "max_output_tokens": request.max_output_tokens,
                "stream": false,
            }))
            .send()
            .await
            .map_err(map_transport)?;
        let response_request_id = request_id(&response);
        let status = response.status();
        let payload = read_bounded_json(response, WEB_SEARCH_RESPONSE_MAX_BYTES).await?;
        map_status(status, &payload)?;
        if payload["status"].as_str() == Some("incomplete") {
            return Err(ProviderError::Incomplete);
        }
        if payload["status"].as_str() != Some("completed") {
            return Err(ProviderError::InvalidResponse);
        }
        let response_model =
            web_search_response_model(&payload).ok_or(ProviderError::InvalidResponse)?;
        let output = payload["output"]
            .as_array()
            .ok_or(ProviderError::InvalidResponse)?;
        let searched = output.iter().any(|item| {
            item["type"].as_str() == Some("web_search_call")
                && item["status"].as_str() == Some("completed")
        });
        if !searched {
            return Err(ProviderError::WebSearchNotExecuted);
        }
        let raw_content =
            web_search_output_text(&payload).ok_or(ProviderError::StructuredOutputInvalid)?;
        if raw_content.is_empty() || raw_content.len() > 100_000 {
            return Err(ProviderError::StructuredOutputInvalid);
        }
        let content = normalize_structured_json(&raw_content)
            .ok_or(ProviderError::StructuredOutputInvalid)?;
        let citations = response_citations(output);
        if request.require_sources && citations.is_empty() {
            return Err(ProviderError::SourcesMissing);
        }
        let usage = &payload["usage"];
        Ok(WebSearchCompletion {
            content,
            citations,
            model: response_model,
            latency_ms: elapsed_ms(started),
            request_id: response_request_id,
            prompt_tokens: usage["input_tokens"].as_u64(),
            completion_tokens: usage["output_tokens"].as_u64(),
            total_tokens: usage["total_tokens"].as_u64(),
        })
    }

    /// Retry only idempotent provider discovery, once, and only when the first
    /// attempt clearly failed before a useful response. Chat completions are
    /// never replayed automatically because doing so can duplicate cost.
    async fn send_idempotent(
        &self,
        request: RequestBuilder,
    ) -> Result<reqwest::Response, ProviderError> {
        send_with_bounded_retry(request, 3, true).await
    }

    async fn check_models(
        &self,
        profile: &ProviderProfile,
    ) -> Result<DiagnosticSuccess, ProviderError> {
        let catalog = self.models(profile).await?;
        if catalog.manual_entry {
            return Ok(DiagnosticSuccess {
                request_id: None,
                prompt_tokens: None,
                completion_tokens: None,
                total_tokens: None,
                connection_checked: false,
                model_available: None,
            });
        }
        if !catalog
            .models
            .iter()
            .any(|model| model.id == profile.model())
        {
            return Err(ProviderError::ModelUnavailable);
        }
        Ok(DiagnosticSuccess {
            request_id: None,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            connection_checked: true,
            model_available: Some(true),
        })
    }

    async fn chat_openai(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
        options: &ChatOptions,
    ) -> Result<ChatCompletion, ProviderError> {
        let secret = self.resolve_secret(profile).await?;
        let started = Instant::now();
        let request = self
            .client
            .post(format!("{}/chat/completions", profile.base_url()))
            .bearer_auth(secret.expose())
            .json(&build_openai_chat_request_with_options(
                profile, messages, max_tokens, options, false,
            )?);
        let response = send_chat_request(request, options.retry).await?;
        let request_id = request_id(&response);
        let status = response.status();
        let payload = read_bounded_json(response, WEB_SEARCH_RESPONSE_MAX_BYTES).await?;
        map_status(status, &payload)?;
        let message = &payload["choices"][0]["message"];
        let content = message["content"].as_str().unwrap_or_default().to_owned();
        let tool_calls = parse_openai_tool_calls(&message["tool_calls"])?;
        if (content.is_empty() && tool_calls.is_empty()) || content.len() > 2_000_000 {
            return Err(ProviderError::InvalidResponse);
        }
        let reasoning_content = message["reasoning_content"]
            .as_str()
            .filter(|content| content.len() <= 2_000_000)
            .map(str::to_owned);
        let usage = &payload["usage"];
        let prompt_tokens = usage["prompt_tokens"].as_u64();
        let completion_tokens = usage["completion_tokens"].as_u64();
        let total_tokens = usage["total_tokens"].as_u64();
        Ok(ChatCompletion {
            content,
            tool_calls,
            reasoning_content,
            finish_reason: payload["choices"][0]["finish_reason"]
                .as_str()
                .map(str::to_owned),
            latency_ms: elapsed_ms(started),
            request_id,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cost_usd_micros: response_cost_usd_micros(usage).or_else(|| {
                model_cost_usd_micros(profile.model(), prompt_tokens?, completion_tokens?)
            }),
        })
    }

    async fn chat_ollama(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
        options: &ChatOptions,
    ) -> Result<ChatCompletion, ProviderError> {
        let started = Instant::now();
        let request = self
            .client
            .post(format!("{}/api/chat", profile.base_url()))
            .json(&build_ollama_chat_request_with_options(
                profile, messages, max_tokens, options, false,
            )?);
        let response = send_chat_request(request, options.retry).await?;
        let status = response.status();
        let payload = read_bounded_json(response, WEB_SEARCH_RESPONSE_MAX_BYTES).await?;
        map_status(status, &payload)?;
        let message = &payload["message"];
        let content = message["content"].as_str().unwrap_or_default().to_owned();
        let tool_calls = parse_ollama_tool_calls(&message["tool_calls"])?;
        if (content.is_empty() && tool_calls.is_empty()) || content.len() > 2_000_000 {
            return Err(ProviderError::InvalidResponse);
        }
        let prompt_tokens = payload["prompt_eval_count"].as_u64();
        let completion_tokens = payload["eval_count"].as_u64();
        Ok(ChatCompletion {
            content,
            tool_calls,
            reasoning_content: message["thinking"].as_str().map(str::to_owned),
            finish_reason: payload["done_reason"].as_str().map(str::to_owned),
            latency_ms: elapsed_ms(started),
            request_id: None,
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens
                .zip(completion_tokens)
                .map(|(left, right)| left + right),
            cost_usd_micros: None,
        })
    }

    async fn resolve_secret(
        &self,
        profile: &ProviderProfile,
    ) -> Result<secrets::ResolvedSecret, ProviderError> {
        let reference = profile
            .secret_ref()
            .ok_or(ProviderError::CredentialMissing)?;
        self.secrets
            .resolve(reference)
            .await
            .map_err(|_| ProviderError::CredentialMissing)
    }
}

struct ChatStreamState {
    body: Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>,
    buffer: Vec<u8>,
    protocol: ProviderProtocol,
    model: String,
    tool_calls: BTreeMap<usize, StreamingToolCall>,
    finished: bool,
}

#[derive(Default)]
struct StreamingToolCall {
    id: String,
    name: String,
    arguments: String,
}

fn take_stream_frame(state: &mut ChatStreamState) -> Option<Result<Vec<u8>, ProviderError>> {
    let delimiter = match state.protocol {
        ProviderProtocol::OpenAiChatCompletions => state
            .buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|position| (position, 2))
            .or_else(|| {
                state
                    .buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|position| (position, 4))
            }),
        ProviderProtocol::OllamaChat => state
            .buffer
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|position| (position, 1)),
    }?;
    let (position, width) = delimiter;
    let frame = state.buffer.drain(..position).collect::<Vec<_>>();
    state.buffer.drain(..width);
    if frame.len() > 2_000_000 {
        return Some(Err(ProviderError::InvalidResponse));
    }
    Some(Ok(frame))
}

fn parse_stream_frame(
    state: &mut ChatStreamState,
    frame: &[u8],
) -> Result<Option<ChatChunk>, ProviderError> {
    match state.protocol {
        ProviderProtocol::OpenAiChatCompletions => parse_openai_stream_frame(state, frame),
        ProviderProtocol::OllamaChat => parse_ollama_stream_frame(state, frame),
    }
}

fn parse_openai_stream_frame(
    state: &mut ChatStreamState,
    frame: &[u8],
) -> Result<Option<ChatChunk>, ProviderError> {
    let text = std::str::from_utf8(frame).map_err(|_| ProviderError::InvalidResponse)?;
    let data = text
        .lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim_start)
        .collect::<Vec<_>>()
        .join("\n");
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        state.finished = true;
        return Ok(None);
    }
    let payload: Value = serde_json::from_str(&data).map_err(|_| ProviderError::InvalidResponse)?;
    let choice = &payload["choices"][0];
    let delta = &choice["delta"];
    if let Some(calls) = delta["tool_calls"].as_array() {
        for call in calls {
            let index = call["index"]
                .as_u64()
                .and_then(|value| usize::try_from(value).ok())
                .ok_or(ProviderError::StructuredOutputInvalid)?;
            let entry = state.tool_calls.entry(index).or_default();
            if let Some(id) = call["id"].as_str() {
                entry.id.push_str(id);
            }
            if let Some(name) = call["function"]["name"].as_str() {
                entry.name.push_str(name);
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                entry.arguments.push_str(arguments);
            }
            if entry.id.len() > 256 || entry.name.len() > 128 || entry.arguments.len() > 1_000_000 {
                return Err(ProviderError::StructuredOutputInvalid);
            }
        }
    }
    let finish_reason = choice["finish_reason"].as_str().map(str::to_owned);
    let tool_calls = if finish_reason.is_some() {
        complete_stream_tool_calls(&state.tool_calls)?
    } else {
        Vec::new()
    };
    let usage = &payload["usage"];
    let prompt_tokens = usage["prompt_tokens"].as_u64();
    let completion_tokens = usage["completion_tokens"].as_u64();
    let total_tokens = usage["total_tokens"].as_u64();
    let chunk = ChatChunk {
        content: delta["content"].as_str().unwrap_or_default().to_owned(),
        reasoning_content: delta["reasoning_content"].as_str().map(str::to_owned),
        tool_calls,
        finish_reason,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        cost_usd_micros: response_cost_usd_micros(usage)
            .or_else(|| model_cost_usd_micros(&state.model, prompt_tokens?, completion_tokens?)),
    };
    Ok(Some(chunk))
}

fn parse_ollama_stream_frame(
    state: &mut ChatStreamState,
    frame: &[u8],
) -> Result<Option<ChatChunk>, ProviderError> {
    if frame.iter().all(u8::is_ascii_whitespace) {
        return Ok(None);
    }
    let payload: Value =
        serde_json::from_slice(frame).map_err(|_| ProviderError::InvalidResponse)?;
    let message = &payload["message"];
    let done = payload["done"].as_bool().unwrap_or(false);
    if done {
        state.finished = true;
    }
    let prompt_tokens = payload["prompt_eval_count"].as_u64();
    let completion_tokens = payload["eval_count"].as_u64();
    Ok(Some(ChatChunk {
        content: message["content"].as_str().unwrap_or_default().to_owned(),
        reasoning_content: message["thinking"].as_str().map(str::to_owned),
        tool_calls: parse_ollama_tool_calls(&message["tool_calls"])?,
        finish_reason: payload["done_reason"].as_str().map(str::to_owned),
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens
            .zip(completion_tokens)
            .map(|(left, right)| left + right),
        cost_usd_micros: None,
    }))
}

fn complete_stream_tool_calls(
    calls: &BTreeMap<usize, StreamingToolCall>,
) -> Result<Vec<ToolCall>, ProviderError> {
    calls
        .values()
        .map(|call| {
            let arguments = serde_json::from_str::<Value>(&call.arguments)
                .map_err(|_| ProviderError::StructuredOutputInvalid)?;
            let call = ToolCall {
                id: call.id.clone(),
                name: call.name.clone(),
                arguments,
            };
            validate_tool_call(&call)?;
            Ok(call)
        })
        .collect()
}

fn fixed_smoke_profile(profile: &ProviderProfile) -> ProviderProfile {
    profile
        .clone()
        .with_reasoning(ReasoningEffort::Off, None)
        .unwrap_or_else(|_| profile.clone())
}

struct DiagnosticSuccess {
    request_id: Option<String>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
    connection_checked: bool,
    model_available: Option<bool>,
}

/// Build a vendor-scoped request. Vendor-only fields must never leak into the
/// shared OpenAI-compatible request shape.
pub fn build_openai_chat_request(
    profile: &ProviderProfile,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<Value, ProviderError> {
    build_openai_chat_request_with_options(
        profile,
        messages,
        max_tokens,
        &ChatOptions::default(),
        false,
    )
}

pub fn build_openai_chat_request_with_options(
    profile: &ProviderProfile,
    messages: &[ChatMessage],
    max_tokens: u32,
    options: &ChatOptions,
    stream: bool,
) -> Result<Value, ProviderError> {
    if !matches!(
        profile.kind().definition().protocol,
        ProviderProtocol::OpenAiChatCompletions
    ) {
        return Err(ProviderError::Configuration);
    }
    validate_chat_request(profile, messages, max_tokens, options)?;
    let mut body = json!({
        "model": profile.model(),
        "messages": encode_openai_messages(profile, messages)?,
        "max_tokens": max_tokens,
        "stream": stream
    });
    apply_chat_options(&mut body, options)?;
    match profile.kind().definition().request_adapter {
        ProviderRequestAdapter::DeepSeek => {
            apply_toggle_and_effort(&mut body, profile.reasoning());
        }
        ProviderRequestAdapter::Glm => {
            apply_toggle_and_effort(&mut body, profile.reasoning());
        }
        ProviderRequestAdapter::Kimi => match profile.reasoning().effort() {
            ReasoningEffort::Auto => {}
            ReasoningEffort::Off => body["thinking"] = json!({"type": "disabled"}),
            _ => return Err(ProviderError::Configuration),
        },
        ProviderRequestAdapter::Qwen => {
            let reasoning = profile.reasoning();
            match reasoning.effort() {
                ReasoningEffort::Auto => {}
                ReasoningEffort::Off => body["enable_thinking"] = Value::Bool(false),
                effort => {
                    body["enable_thinking"] = Value::Bool(true);
                    body["reasoning_effort"] = Value::String(effort.as_wire_value().to_owned());
                }
            }
            if let Some(max_tokens) = reasoning.max_tokens() {
                body["thinking_budget"] = json!(max_tokens);
            }
        }
        ProviderRequestAdapter::OpenRouter => {
            let reasoning = profile.reasoning();
            if reasoning.effort() != ReasoningEffort::Auto {
                body["reasoning"] = json!({
                    "effort": reasoning.effort().as_wire_value(),
                    "exclude": true
                });
                if let Some(max_tokens) = reasoning.max_tokens() {
                    body["reasoning"]["max_tokens"] = json!(max_tokens);
                }
            }
        }
        ProviderRequestAdapter::StandardOpenAi => {
            let effort = profile.reasoning().effort();
            if effort != ReasoningEffort::Auto {
                body["reasoning_effort"] = Value::String(effort.as_wire_value().to_owned());
            }
        }
        ProviderRequestAdapter::Ollama => return Err(ProviderError::Configuration),
    }
    Ok(body)
}

pub fn build_ollama_chat_request(
    profile: &ProviderProfile,
    messages: &[ChatMessage],
    max_tokens: u32,
) -> Result<Value, ProviderError> {
    build_ollama_chat_request_with_options(
        profile,
        messages,
        max_tokens,
        &ChatOptions::default(),
        false,
    )
}

pub fn build_ollama_chat_request_with_options(
    profile: &ProviderProfile,
    messages: &[ChatMessage],
    max_tokens: u32,
    options: &ChatOptions,
    stream: bool,
) -> Result<Value, ProviderError> {
    if !matches!(
        profile.kind().definition().protocol,
        ProviderProtocol::OllamaChat
    ) {
        return Err(ProviderError::Configuration);
    }
    validate_chat_request(profile, messages, max_tokens, options)?;
    let mut body = json!({
        "model": profile.model(),
        "messages": encode_ollama_messages(messages)?,
        "stream": stream,
        "options": {"num_predict": max_tokens}
    });
    if !options.tools.is_empty() {
        body["tools"] = encode_tools(&options.tools)?;
    }
    apply_sampling_options(&mut body["options"], &options.sampling)?;
    match profile.reasoning().effort() {
        ReasoningEffort::Auto => {}
        ReasoningEffort::Off => body["think"] = Value::Bool(false),
        ReasoningEffort::Low | ReasoningEffort::Medium | ReasoningEffort::High => {
            body["think"] = Value::String(profile.reasoning().effort().as_wire_value().to_owned());
        }
        _ => return Err(ProviderError::Configuration),
    }
    Ok(body)
}

fn validate_chat_request(
    // Kept for per-vendor validation rules (e.g. the DeepSeek reasoning
    // contract is handled at encode time, future quirks belong here).
    _profile: &ProviderProfile,
    messages: &[ChatMessage],
    max_tokens: u32,
    options: &ChatOptions,
) -> Result<(), ProviderError> {
    if messages.is_empty()
        || messages.len() > 256
        || max_tokens == 0
        || max_tokens > 131_072
        || estimate_chat_tokens(messages)? > 1_000_000
    {
        return Err(ProviderError::PolicyDenied);
    }
    for message in messages {
        if !matches!(
            message.role.as_str(),
            "system" | "user" | "assistant" | "tool"
        ) || message.content.len() > 2_000_000
            || message.content.contains('\0')
            || message
                .reasoning_content
                .as_ref()
                .is_some_and(|value| value.len() > 2_000_000 || value.contains('\0'))
        {
            return Err(ProviderError::PolicyDenied);
        }
        match message.role.as_str() {
            "assistant" => {
                if message.content.is_empty() && message.tool_calls.is_empty() {
                    return Err(ProviderError::PolicyDenied);
                }
            }
            "tool" => {
                if message.tool_call_id.as_deref().is_none_or(str::is_empty)
                    || !message.tool_calls.is_empty()
                {
                    return Err(ProviderError::PolicyDenied);
                }
            }
            _ => {
                if message.content.is_empty()
                    || message.tool_call_id.is_some()
                    || !message.tool_calls.is_empty()
                {
                    return Err(ProviderError::PolicyDenied);
                }
            }
        }
        for call in &message.tool_calls {
            validate_tool_call(call)?;
        }
    }
    let mut names = BTreeSet::new();
    for tool in &options.tools {
        if !valid_identifier(&tool.name)
            || tool.description.is_empty()
            || tool.description.len() > 8_192
            || !tool.parameters.is_object()
            || !names.insert(tool.name.as_str())
        {
            return Err(ProviderError::Configuration);
        }
    }
    if let ChatToolChoice::Function(name) = &options.tool_choice
        && (!valid_identifier(name) || !names.contains(name.as_str()))
    {
        return Err(ProviderError::Configuration);
    }
    if options.tools.is_empty()
        && (!matches!(
            options.tool_choice,
            ChatToolChoice::Auto | ChatToolChoice::None
        ) || options.parallel_tool_calls.is_some())
    {
        return Err(ProviderError::Configuration);
    }
    validate_sampling(&options.sampling)
}

fn validate_sampling(sampling: &SamplingControls) -> Result<(), ProviderError> {
    if sampling
        .temperature
        .is_some_and(|value| !value.is_finite() || !(0.0..=2.0).contains(&value))
        || sampling
            .top_p
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        || sampling.stop.len() > 8
        || sampling
            .stop
            .iter()
            .any(|value| value.is_empty() || value.len() > 256 || value.contains('\0'))
    {
        return Err(ProviderError::Configuration);
    }
    Ok(())
}

fn validate_tool_call(call: &ToolCall) -> Result<(), ProviderError> {
    if call.id.is_empty()
        || call.id.len() > 256
        || call.id.contains('\0')
        || !valid_identifier(&call.name)
        || !call.arguments.is_object()
    {
        return Err(ProviderError::StructuredOutputInvalid);
    }
    Ok(())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

pub fn estimate_chat_tokens(messages: &[ChatMessage]) -> Result<u64, ProviderError> {
    let tokenizer = tiktoken_rs::cl100k_base().map_err(|_| ProviderError::Configuration)?;
    messages.iter().try_fold(2_u64, |total, message| {
        let content = tokenizer.encode_with_special_tokens(&message.content);
        let reasoning = message
            .reasoning_content
            .as_deref()
            .map(|value| tokenizer.encode_with_special_tokens(value).len())
            .unwrap_or_default();
        let tool_bytes = message.tool_calls.iter().try_fold(0_usize, |size, call| {
            serde_json::to_vec(call)
                .map(|encoded| size.saturating_add(encoded.len()))
                .map_err(|_| ProviderError::Configuration)
        })?;
        let tool_tokens = tool_bytes.div_ceil(3);
        let count = content
            .len()
            .saturating_add(reasoning)
            .saturating_add(tool_tokens)
            .saturating_add(4);
        total
            .checked_add(u64::try_from(count).map_err(|_| ProviderError::PolicyDenied)?)
            .ok_or(ProviderError::PolicyDenied)
    })
}

fn encode_tools(tools: &[ChatTool]) -> Result<Value, ProviderError> {
    let tools = tools
        .iter()
        .map(|tool| {
            Ok(json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": true,
                }
            }))
        })
        .collect::<Result<Vec<_>, ProviderError>>()?;
    Ok(Value::Array(tools))
}

fn encode_openai_messages(
    profile: &ProviderProfile,
    messages: &[ChatMessage],
) -> Result<Value, ProviderError> {
    let mut encoded = Vec::with_capacity(messages.len());
    for message in messages {
        let mut value = json!({"role": message.role, "content": message.content});
        if let Some(tool_call_id) = &message.tool_call_id {
            value["tool_call_id"] = Value::String(tool_call_id.clone());
        }
        if !message.tool_calls.is_empty() {
            value["tool_calls"] = Value::Array(
                message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        validate_tool_call(call)?;
                        Ok(json!({
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": serde_json::to_string(&call.arguments)
                                    .map_err(|_| ProviderError::Configuration)?,
                            }
                        }))
                    })
                    .collect::<Result<Vec<_>, ProviderError>>()?,
            );
        }
        if profile.kind() == ProviderKind::DeepSeek {
            match &message.reasoning_content {
                Some(reasoning_content) => {
                    value["reasoning_content"] = Value::String(reasoning_content.clone());
                }
                // DeepSeek thinking mode rejects multi-turn tool-call history
                // whose assistant messages lack the `reasoning_content` field
                // (HTTP 400); an empty string satisfies the wire contract.
                // Restork strips reasoning at rest per the retention policy, so
                // a checkpoint resumed after a pause, retry, or restart no
                // longer carries the original reasoning. Emitting the
                // placeholder keeps the run resumable instead of failing it
                // deterministically as `provider_configuration`.
                None if profile.reasoning().effort() != ReasoningEffort::Off
                    && !message.tool_calls.is_empty() =>
                {
                    value["reasoning_content"] = Value::String(String::new());
                }
                _ => {}
            }
        }
        encoded.push(value);
    }
    Ok(Value::Array(encoded))
}

fn encode_ollama_messages(messages: &[ChatMessage]) -> Result<Value, ProviderError> {
    let mut encoded = Vec::with_capacity(messages.len());
    for message in messages {
        let mut value = json!({"role": message.role, "content": message.content});
        if !message.tool_calls.is_empty() {
            value["tool_calls"] = Value::Array(
                message
                    .tool_calls
                    .iter()
                    .map(|call| {
                        validate_tool_call(call)?;
                        Ok(json!({
                            "function": {"name": call.name, "arguments": call.arguments}
                        }))
                    })
                    .collect::<Result<Vec<_>, ProviderError>>()?,
            );
        }
        encoded.push(value);
    }
    Ok(Value::Array(encoded))
}

fn apply_chat_options(body: &mut Value, options: &ChatOptions) -> Result<(), ProviderError> {
    if !options.tools.is_empty() {
        body["tools"] = encode_tools(&options.tools)?;
        body["tool_choice"] = match &options.tool_choice {
            ChatToolChoice::Auto => Value::String("auto".to_owned()),
            ChatToolChoice::None => Value::String("none".to_owned()),
            ChatToolChoice::Required => Value::String("required".to_owned()),
            ChatToolChoice::Function(name) => json!({
                "type": "function",
                "function": {"name": name},
            }),
        };
        if let Some(parallel) = options.parallel_tool_calls {
            body["parallel_tool_calls"] = Value::Bool(parallel);
        }
    }
    apply_sampling_options(body, &options.sampling)
}

fn apply_sampling_options(
    body: &mut Value,
    sampling: &SamplingControls,
) -> Result<(), ProviderError> {
    validate_sampling(sampling)?;
    if let Some(temperature) = sampling.temperature {
        body["temperature"] = json!(temperature);
    }
    if let Some(top_p) = sampling.top_p {
        body["top_p"] = json!(top_p);
    }
    if let Some(seed) = sampling.seed {
        body["seed"] = json!(seed);
    }
    if sampling.stop.len() == 1 {
        body["stop"] = Value::String(sampling.stop[0].clone());
    } else if !sampling.stop.is_empty() {
        body["stop"] =
            serde_json::to_value(&sampling.stop).map_err(|_| ProviderError::Configuration)?;
    }
    Ok(())
}

fn apply_toggle_and_effort(body: &mut Value, reasoning: restork_personal::ReasoningConfig) {
    match reasoning.effort() {
        ReasoningEffort::Auto => {}
        ReasoningEffort::Off => body["thinking"] = json!({"type": "disabled"}),
        effort => {
            body["thinking"] = json!({"type": "enabled"});
            body["reasoning_effort"] = Value::String(effort.as_wire_value().to_owned());
        }
    }
}

fn parse_openai_models(payload: &Value) -> Result<Vec<ProviderModel>, ProviderError> {
    let items = payload["data"]
        .as_array()
        .ok_or(ProviderError::InvalidResponse)?;
    let mut models = items
        .iter()
        .filter_map(|model| model["id"].as_str())
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains('\0'))
        .map(|id| ProviderModel { id: id.to_owned() })
        .take(10_000)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup();
    Ok(models)
}

fn parse_ollama_models(payload: &Value) -> Result<Vec<ProviderModel>, ProviderError> {
    let items = payload["models"]
        .as_array()
        .ok_or(ProviderError::InvalidResponse)?;
    let mut models = items
        .iter()
        .filter_map(|model| model["name"].as_str().or_else(|| model["model"].as_str()))
        .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains('\0'))
        .map(|id| ProviderModel { id: id.to_owned() })
        .take(10_000)
        .collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    models.dedup();
    Ok(models)
}

fn web_search_response_model(payload: &Value) -> Option<String> {
    const ALIAS: &str = "deepseek-v4-flash";
    let model = payload["model"].as_str()?;
    if model == ALIAS {
        return Some(model.to_owned());
    }
    let suffix = model.strip_prefix("deepseek-v4-flash-")?;
    (!suffix.is_empty()
        && suffix.len() <= 64
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.')))
    .then(|| model.to_owned())
}

/// Extract only final assistant text from bounded Responses-compatible envelopes.
///
/// Some compatible gateways expose the final value as `output_text`, while others
/// place a string or `{ value }` object inside a message content part. Reasoning and
/// tool payloads are deliberately ignored; callers still require one JSON object and
/// run the schema and public-evidence gates afterwards.
fn web_search_output_text(payload: &Value) -> Option<String> {
    let mut completed_assistant = None;
    let mut compatible_statusless = None;
    if let Some(output) = payload["output"].as_array() {
        for message in output
            .iter()
            .filter(|item| item["type"].as_str() == Some("message"))
        {
            let selected = match (message["role"].as_str(), message["status"].as_str()) {
                (Some("assistant"), Some("completed")) => &mut completed_assistant,
                (None, None) => &mut compatible_statusless,
                _ => continue,
            };
            let Some(content) = message["content"].as_array() else {
                continue;
            };
            let mut parts = Vec::new();
            for part in content
                .iter()
                .filter(|part| matches!(part["type"].as_str(), Some("output_text" | "text")))
            {
                let text = part["text"]
                    .as_str()
                    .or_else(|| part["text"]["value"].as_str())
                    .or_else(|| part["output_text"].as_str());
                if let Some(text) = text.filter(|text| !text.trim().is_empty()) {
                    parts.push(text);
                }
            }
            let joined = parts.join("\n");
            if !joined.is_empty() && joined.len() <= 100_000 {
                *selected = Some(joined);
            }
        }
    }
    let mut selected = completed_assistant.or(compatible_statusless);
    if selected.is_none()
        && let Some(text) = payload["output_text"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
    {
        selected = (text.len() <= 100_000).then(|| text.to_owned());
    }
    selected
}

/// Canonicalize the provider's structured text before schema-specific decoding.
///
/// DeepSeek can occasionally emit an otherwise valid strict-schema object with an
/// unescaped quotation mark or raw control character inside a prose field. The
/// repair is deliberately narrow: it never adds fields or values, and the result
/// must still parse as one JSON object before callers perform their typed schema
/// and evidence validation.
fn normalize_structured_json(output: &str) -> Option<String> {
    let candidate = structured_json_candidate(output.trim());
    if let Ok(value) = serde_json::from_str::<Value>(candidate) {
        return value
            .is_object()
            .then(|| serde_json::to_string(&value).ok())
            .flatten();
    }
    // Models sometimes wrap the requested object in prose despite strict
    // instructions. Extract the first balanced {...} before giving up.
    if let Some(extracted) = extract_first_json_object(candidate)
        && let Ok(value) = serde_json::from_str::<Value>(&extracted)
        && value.is_object()
    {
        return serde_json::to_string(&value).ok();
    }
    let repaired = repair_json_prose_strings(candidate)?;
    let value = serde_json::from_str::<Value>(&repaired).ok()?;
    value
        .is_object()
        .then(|| serde_json::to_string(&value).ok())
        .flatten()
}

/** Byte-slice of the first balanced JSON object, strings and escapes aware. */
fn extract_first_json_object(value: &str) -> Option<String> {
    let start = value.find('{')?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in value[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(value[start..=start + offset].to_owned());
                }
            }
            _ => {}
        }
    }
    None
}

fn structured_json_candidate(value: &str) -> &str {
    let Some(opening) = value.find("```") else {
        return value;
    };
    let after_ticks = &value[opening + 3..];
    let Some((language, fenced)) = after_ticks.split_once('\n') else {
        return value;
    };
    if !matches!(language.trim(), "" | "json" | "JSON") {
        return value;
    }
    let Some(closing) = fenced.find("```") else {
        return value;
    };
    fenced[..closing].trim()
}

fn repair_json_prose_strings(value: &str) -> Option<String> {
    let characters = value.chars().collect::<Vec<_>>();
    let mut repaired = String::with_capacity(value.len() + 32);
    let mut in_string = false;
    let mut escaped = false;
    for (index, character) in characters.iter().copied().enumerate() {
        if !in_string {
            repaired.push(character);
            if character == '"' {
                in_string = true;
            }
            continue;
        }
        if escaped {
            repaired.push(character);
            escaped = false;
            continue;
        }
        match character {
            '\\' => {
                repaired.push(character);
                escaped = true;
            }
            '"' if json_quote_closes_string(&characters, index) => {
                repaired.push(character);
                in_string = false;
            }
            '"' => repaired.push_str("\\\""),
            '\n' => repaired.push_str("\\n"),
            '\r' => repaired.push_str("\\r"),
            '\t' => repaired.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                write!(&mut repaired, "\\u{:04x}", u32::from(character)).ok()?;
            }
            _ => repaired.push(character),
        }
    }
    (!in_string && !escaped).then_some(repaired)
}

fn json_quote_closes_string(characters: &[char], quote_index: usize) -> bool {
    let Some((next_index, next)) = next_non_whitespace(characters, quote_index + 1) else {
        return true;
    };
    match next {
        ':' | '}' | ']' => true,
        ',' => next_non_whitespace(characters, next_index + 1).is_none_or(
            |(following_index, following)| {
                matches!(following, '"' | '{' | '[' | '}' | ']' | '-' | '0'..='9')
                    || json_literal_starts_at(characters, following_index, "true")
                    || json_literal_starts_at(characters, following_index, "false")
                    || json_literal_starts_at(characters, following_index, "null")
            },
        ),
        _ => false,
    }
}

fn json_literal_starts_at(characters: &[char], start: usize, literal: &str) -> bool {
    let literal = literal.chars().collect::<Vec<_>>();
    if characters.get(start..start + literal.len()) != Some(literal.as_slice()) {
        return false;
    }
    characters
        .get(start + literal.len())
        .is_none_or(|character| character.is_whitespace() || matches!(character, ',' | '}' | ']'))
}

fn next_non_whitespace(characters: &[char], start: usize) -> Option<(usize, char)> {
    characters
        .iter()
        .copied()
        .enumerate()
        .skip(start)
        .find(|(_, character)| !character.is_whitespace())
}

fn response_citations(output: &[Value]) -> Vec<WebCitation> {
    let mut candidates = Vec::new();
    for item in output {
        if item["type"].as_str() == Some("web_search_call")
            && item["status"].as_str() == Some("completed")
        {
            collect_citation_values(&item["action"], &mut candidates);
        }
        if item["type"].as_str() != Some("message")
            || item["role"].as_str() != Some("assistant")
            || item["status"].as_str() != Some("completed")
        {
            continue;
        }
        let Some(parts) = item["content"].as_array() else {
            continue;
        };
        for part in parts {
            let Some(annotations) = part["annotations"].as_array() else {
                continue;
            };
            for annotation in annotations {
                if let Some(url) = annotation["url"].as_str() {
                    candidates.push((
                        annotation["title"].as_str().unwrap_or_default().to_owned(),
                        url.to_owned(),
                    ));
                }
            }
        }
    }
    // Structured output is model-authored and cannot establish its own evidence.
    // Only URLs observed in the provider's search action or message annotations
    // are eligible citations; the API later cross-checks draft sources against them.
    let mut seen = BTreeSet::new();
    candidates
        .into_iter()
        .filter_map(|(title, value)| {
            let url = public_https_url(&value)?;
            if !seen.insert(url.clone()) {
                return None;
            }
            let fallback = url::Url::parse(&url).ok()?.host_str()?.to_owned();
            Some(WebCitation {
                title: normalized_web_text(&title, 300).unwrap_or(fallback),
                url,
            })
        })
        .take(12)
        .collect()
}

fn collect_citation_values(value: &Value, output: &mut Vec<(String, String)>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_citation_values(item, output);
            }
        }
        Value::Object(object) => {
            if let Some(url) = object.get("url").and_then(Value::as_str) {
                output.push((
                    object
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    url.to_owned(),
                ));
            }
            for (key, item) in object {
                if !matches!(key.as_str(), "url" | "title") {
                    collect_citation_values(item, output);
                }
            }
        }
        _ => {}
    }
}

fn public_https_url(value: &str) -> Option<String> {
    if value.is_empty() || value.len() > 1_000 || value.chars().any(char::is_control) {
        return None;
    }
    let mut parsed = url::Url::parse(value).ok()?;
    let hostname = parsed.host_str()?.to_ascii_lowercase();
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.port(), None | Some(443))
        || hostname == "localhost"
        || hostname.ends_with('.')
        || hostname.ends_with(".local")
        || hostname.ends_with(".localhost")
        || hostname.ends_with(".internal")
        || hostname.ends_with(".home.arpa")
        || hostname.ends_with(".example")
        || hostname.ends_with(".invalid")
        || hostname.ends_with(".test")
        || hostname == "example.com"
        || hostname.ends_with(".example.com")
        || hostname == "example.net"
        || hostname.ends_with(".example.net")
        || hostname == "example.org"
        || hostname.ends_with(".example.org")
        || hostname.parse::<IpAddr>().is_ok()
    {
        return None;
    }
    parsed.set_fragment(None);
    Some(parsed.to_string())
}

fn normalized_web_text(value: &str, maximum: usize) -> Option<String> {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!normalized.is_empty() && normalized.len() <= maximum && !normalized.contains('\0'))
        .then_some(normalized)
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn request_id(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 256)
        .map(str::to_owned)
}

async fn read_bounded_json(
    response: reqwest::Response,
    maximum_bytes: usize,
) -> Result<Value, ProviderError> {
    let maximum_length = u64::try_from(maximum_bytes).unwrap_or(u64::MAX);
    if response
        .content_length()
        .is_some_and(|length| length > maximum_length)
    {
        return Err(ProviderError::InvalidResponse);
    }
    let mut body = Vec::with_capacity(
        response
            .content_length()
            .and_then(|length| usize::try_from(length).ok())
            .unwrap_or(0)
            .min(maximum_bytes),
    );
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(map_transport)?;
        if body
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > maximum_bytes)
        {
            return Err(ProviderError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| ProviderError::InvalidResponse)
}

fn map_transport(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Unavailable
    }
}

fn retryable_discovery_status(status: StatusCode) -> bool {
    status == StatusCode::TOO_MANY_REQUESTS || matches!(status.as_u16(), 502..=504)
}

async fn send_chat_request(
    request: RequestBuilder,
    policy: ChatRetryPolicy,
) -> Result<reqwest::Response, ProviderError> {
    match policy {
        ChatRetryPolicy::Disabled => request.send().await.map_err(map_transport),
        ChatRetryPolicy::Bounded => send_with_bounded_retry(request, 2, true).await,
    }
}

async fn send_with_bounded_retry(
    request: RequestBuilder,
    maximum_retries: u8,
    retry_connect_errors: bool,
) -> Result<reqwest::Response, ProviderError> {
    let mut next = Some(request);
    for attempt in 0..=maximum_retries {
        let current = next.take().ok_or(ProviderError::Unavailable)?;
        let retry = current.try_clone();
        match current.send().await {
            Ok(response)
                if attempt < maximum_retries && retryable_discovery_status(response.status()) =>
            {
                let Some(retry) = retry else {
                    return Ok(response);
                };
                tokio::time::sleep(retry_delay(response.headers(), attempt)).await;
                next = Some(retry);
            }
            Ok(response) => return Ok(response),
            Err(error)
                if attempt < maximum_retries
                    && retry_connect_errors
                    && (error.is_connect() || error.is_timeout()) =>
            {
                let Some(retry) = retry else {
                    return Err(map_transport(error));
                };
                tokio::time::sleep(retry_delay(&HeaderMap::new(), attempt)).await;
                next = Some(retry);
            }
            Err(error) => return Err(map_transport(error)),
        }
    }
    Err(ProviderError::Unavailable)
}

fn retry_delay(headers: &HeaderMap, attempt: u8) -> Duration {
    const MAXIMUM: Duration = Duration::from_secs(30);
    if let Some(value) = headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
    {
        let parsed = value
            .parse::<u64>()
            .ok()
            .map(Duration::from_secs)
            .or_else(|| {
                httpdate::parse_http_date(value)
                    .ok()
                    .and_then(|deadline| deadline.duration_since(std::time::SystemTime::now()).ok())
            });
        if let Some(parsed) = parsed {
            return parsed.min(MAXIMUM);
        }
    }
    let base = 200_u64.saturating_mul(1_u64 << attempt.min(7));
    let mut entropy = [0_u8; 2];
    let jitter = if getrandom::fill(&mut entropy).is_ok() {
        u64::from(u16::from_le_bytes(entropy)) % (base / 2 + 1)
    } else {
        0
    };
    Duration::from_millis(base.saturating_add(jitter)).min(MAXIMUM)
}

fn map_status(status: StatusCode, payload: &Value) -> Result<(), ProviderError> {
    if status.is_success() {
        return Ok(());
    }
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    Err(match status.as_u16() {
        401 | 403 => ProviderError::Authentication,
        402 => ProviderError::InsufficientBalance,
        404 if message.contains("model") => ProviderError::ModelUnavailable,
        429 => ProviderError::RateLimited,
        500..=599 => ProviderError::Unavailable,
        _ => ProviderError::InvalidResponse,
    })
}

fn parse_openai_tool_calls(value: &Value) -> Result<Vec<ToolCall>, ProviderError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let calls = value.as_array().ok_or(ProviderError::InvalidResponse)?;
    calls
        .iter()
        .map(|call| {
            let arguments = call["function"]["arguments"]
                .as_str()
                .ok_or(ProviderError::StructuredOutputInvalid)
                .and_then(|value| {
                    serde_json::from_str::<Value>(value)
                        .map_err(|_| ProviderError::StructuredOutputInvalid)
                })?;
            let parsed = ToolCall {
                id: call["id"]
                    .as_str()
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned(),
                name: call["function"]["name"]
                    .as_str()
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned(),
                arguments,
            };
            validate_tool_call(&parsed)?;
            Ok(parsed)
        })
        .collect()
}

fn parse_ollama_tool_calls(value: &Value) -> Result<Vec<ToolCall>, ProviderError> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let calls = value.as_array().ok_or(ProviderError::InvalidResponse)?;
    calls
        .iter()
        .enumerate()
        .map(|(index, call)| {
            let arguments = call["function"]["arguments"].clone();
            let parsed = ToolCall {
                id: call["id"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("ollama-call-{index}")),
                name: call["function"]["name"]
                    .as_str()
                    .ok_or(ProviderError::InvalidResponse)?
                    .to_owned(),
                arguments,
            };
            validate_tool_call(&parsed)?;
            Ok(parsed)
        })
        .collect()
}

fn response_cost_usd_micros(usage: &Value) -> Option<u64> {
    let cost = usage["cost"]
        .as_f64()
        .or_else(|| usage["cost_details"]["total_cost"].as_f64())?;
    (cost.is_finite() && cost >= 0.0).then(|| (cost * 1_000_000.0).round() as u64)
}

pub fn model_cost_usd_micros(
    model: &str,
    prompt_tokens: u64,
    completion_tokens: u64,
) -> Option<u64> {
    let (input_millimicros, output_millimicros) = match model {
        value if value == "deepseek-v4-flash" || value.starts_with("deepseek-v4-flash-") => {
            (140_u64, 280_u64)
        }
        value if value == "deepseek-v4-pro" || value.starts_with("deepseek-v4-pro-") => {
            (435_u64, 870_u64)
        }
        _ => return None,
    };
    let total = u128::from(prompt_tokens)
        .saturating_mul(u128::from(input_millimicros))
        .saturating_add(
            u128::from(completion_tokens).saturating_mul(u128::from(output_millimicros)),
        )
        .div_ceil(1_000);
    u64::try_from(total).ok()
}

fn safe_message(error: &ProviderError) -> &'static str {
    match error {
        ProviderError::Configuration => "The non-secret provider configuration is invalid.",
        ProviderError::CredentialMissing => "The native secret is unavailable.",
        ProviderError::Authentication => "The provider rejected the credential.",
        ProviderError::InsufficientBalance => "The provider account has insufficient balance.",
        ProviderError::RateLimited => "The provider rate limited this bounded request.",
        ProviderError::Timeout => "The bounded provider request timed out.",
        ProviderError::Unavailable => "The provider is temporarily unavailable.",
        ProviderError::ModelUnavailable => "The configured model is unavailable.",
        ProviderError::InvalidResponse => "The provider returned an invalid response.",
        ProviderError::Incomplete => {
            "V4 Flash hit the bounded output budget before the structured result completed."
        }
        ProviderError::WebSearchNotExecuted => {
            "V4 Flash responded, but the required server-side web search did not run."
        }
        ProviderError::StructuredOutputInvalid => {
            "V4 Flash completed web search, but its structured result was invalid."
        }
        ProviderError::SourcesMissing => {
            "V4 Flash completed web search, but returned no valid public HTTPS sources."
        }
        ProviderError::PolicyDenied => "The provider request was denied by local policy.",
    }
}

/// The command that configures a credential, addressed so the user can actually
/// run it.
///
/// A bare `restorkd` only works when the binary is on `PATH`, which it is not for
/// a packaged install: the desktop bundle keeps it at
/// `Restork.app/Contents/Resources/core/restorkd`. Reporting the bare name left
/// every DMG user unable to configure a model at all. The running executable's
/// own path is correct for both a source checkout and a bundle.
#[must_use]
pub fn credential_setup_command(kind: ProviderKind) -> String {
    if kind == ProviderKind::Ollama {
        return "ollama serve".to_owned();
    }
    format!(
        "{} provider configure {}",
        core_executable_argument(),
        kind.definition().id
    )
}

/// The current executable as a shell argument, quoted when it needs to be.
///
/// Falls back to the bare name only if the path is unavailable, which keeps the
/// message useful rather than empty.
fn core_executable_argument() -> String {
    let Ok(path) = std::env::current_exe() else {
        return "restorkd".to_owned();
    };
    let display = path.to_string_lossy();
    if display.is_empty() {
        return "restorkd".to_owned();
    }
    native_shell_argument(&display)
}

#[cfg(not(windows))]
fn native_shell_argument(display: &str) -> String {
    if display
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || "/._-".contains(character))
    {
        return display.to_owned();
    }
    // Single quotes are the only shell quoting that needs no other escaping,
    // and an embedded quote is closed, escaped, and reopened.
    format!("'{}'", display.replace('\'', "'\\''"))
}

#[cfg(windows)]
fn native_shell_argument(display: &str) -> String {
    // Windows paths cannot contain a double quote, so quoting a bundle path for
    // Command Prompt and PowerShell does not need an escape sequence.
    format!("\"{display}\"")
}

fn provider_setup_command(profile: &ProviderProfile) -> String {
    credential_setup_command(profile.kind())
}

#[cfg(test)]
mod tests {
    use super::*;
    use restork_personal::{FallbackPolicy, ProviderKind, ReasoningEffort};

    fn profile(kind: ProviderKind) -> ProviderProfile {
        let definition = kind.definition();
        ProviderProfile::try_new(
            definition.id,
            1,
            definition.display_name,
            kind,
            definition.default_base_url,
            "fixture-model",
            Some("keychain:restork/provider/fixture"),
            FallbackPolicy::Disabled,
        )
        .expect("valid cloud fixture")
    }

    fn reasoning_profile(
        kind: ProviderKind,
        effort: ReasoningEffort,
        budget: Option<u32>,
    ) -> ProviderProfile {
        profile(kind)
            .with_reasoning(effort, budget)
            .expect("supported reasoning fixture")
    }

    #[test]
    fn reasoning_fields_are_provider_scoped_and_auto_is_not_overridden() {
        let messages = [ChatMessage::text("user", "hello")];
        let automatic = build_openai_chat_request(&profile(ProviderKind::DeepSeek), &messages, 32)
            .expect("automatic deepseek request");
        assert!(automatic.get("thinking").is_none());

        let deepseek = build_openai_chat_request(
            &reasoning_profile(ProviderKind::DeepSeek, ReasoningEffort::Max, None),
            &messages,
            32,
        )
        .expect("deepseek request");
        assert_eq!(deepseek["thinking"]["type"], "enabled");
        assert_eq!(deepseek["reasoning_effort"], "max");

        let glm = build_openai_chat_request(
            &reasoning_profile(ProviderKind::Glm, ReasoningEffort::High, None),
            &messages,
            32,
        )
        .expect("GLM request");
        assert_eq!(glm["thinking"]["type"], "enabled");
        assert_eq!(glm["reasoning_effort"], "high");

        let qwen = build_openai_chat_request(
            &reasoning_profile(ProviderKind::Qwen, ReasoningEffort::Medium, Some(2_048)),
            &messages,
            32,
        )
        .expect("Qwen request");
        assert_eq!(qwen["enable_thinking"], true);
        assert_eq!(qwen["reasoning_effort"], "medium");
        assert_eq!(qwen["thinking_budget"], 2_048);

        let openrouter = build_openai_chat_request(
            &reasoning_profile(ProviderKind::OpenRouter, ReasoningEffort::Low, Some(1_024)),
            &messages,
            32,
        )
        .expect("OpenRouter request");
        assert_eq!(openrouter["reasoning"]["effort"], "low");
        assert_eq!(openrouter["reasoning"]["max_tokens"], 1_024);
        assert_eq!(openrouter["reasoning"]["exclude"], true);

        for kind in [
            ProviderKind::Glm,
            ProviderKind::Kimi,
            ProviderKind::Qwen,
            ProviderKind::OpenAiCompatible,
            ProviderKind::OpenRouter,
        ] {
            let request = build_openai_chat_request(&profile(kind), &messages, 32)
                .expect("OpenAI-compatible request");
            assert!(request.get("thinking").is_none());
            assert!(request.get("reasoning_effort").is_none());
            assert_eq!(request["model"], "fixture-model");
            assert_eq!(request["max_tokens"], 32);
        }

        let ollama_profile = ProviderProfile::try_new(
            "ollama",
            1,
            "Ollama",
            ProviderKind::Ollama,
            "http://127.0.0.1:11434",
            "gpt-oss",
            None,
            FallbackPolicy::Disabled,
        )
        .expect("Ollama profile")
        .with_reasoning(ReasoningEffort::High, None)
        .expect("Ollama reasoning");
        let ollama =
            build_ollama_chat_request(&ollama_profile, &messages, 32).expect("Ollama request");
        assert_eq!(ollama["think"], "high");
    }

    #[test]
    fn fixed_smoke_disables_reasoning_and_discovery_retries_transient_statuses() {
        let messages = [ChatMessage::text("user", "Reply with exactly OK.")];
        let smoke = fixed_smoke_profile(&profile(ProviderKind::DeepSeek));
        let request =
            build_openai_chat_request(&smoke, &messages, 16).expect("fixed smoke request");
        assert_eq!(request["thinking"]["type"], "disabled");
        assert!(retryable_discovery_status(StatusCode::BAD_GATEWAY));
        assert!(retryable_discovery_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(retryable_discovery_status(StatusCode::GATEWAY_TIMEOUT));
        assert!(retryable_discovery_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(!retryable_discovery_status(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn setup_commands_follow_the_selected_provider_without_exposing_secrets() {
        let qwen = provider_setup_command(&profile(ProviderKind::Qwen));
        assert!(qwen.ends_with(" provider configure qwen"));
        assert!(!qwen.contains("secret"));
        let ollama = ProviderProfile::try_new(
            "ollama",
            1,
            "Ollama",
            ProviderKind::Ollama,
            "http://127.0.0.1:11434",
            "qwen3",
            None,
            FallbackPolicy::Disabled,
        )
        .expect("valid local profile");
        assert_eq!(provider_setup_command(&ollama), "ollama serve");
    }

    #[cfg(not(windows))]
    #[test]
    fn native_setup_command_quotes_bundle_paths_for_the_host_shell() {
        assert_eq!(
            native_shell_argument("/Applications/Restork Preview.app/Contents/restorkd"),
            "'/Applications/Restork Preview.app/Contents/restorkd'"
        );
    }

    #[test]
    fn model_payloads_are_bounded_sorted_and_deduplicated() {
        let payload = json!({"data": [
            {"id": "z-model"},
            {"id": "a-model"},
            {"id": "a-model"},
            {"id": "bad\0model"}
        ]});
        assert_eq!(
            parse_openai_models(&payload).expect("model catalog"),
            vec![
                ProviderModel {
                    id: "a-model".to_owned()
                },
                ProviderModel {
                    id: "z-model".to_owned()
                },
            ]
        );
    }

    #[test]
    fn web_search_accepts_only_the_flash_alias_or_a_bounded_version_suffix() {
        assert_eq!(
            web_search_response_model(&json!({"model": "deepseek-v4-flash"})).as_deref(),
            Some("deepseek-v4-flash")
        );
        assert_eq!(
            web_search_response_model(&json!({"model": "deepseek-v4-flash-20260804"})).as_deref(),
            Some("deepseek-v4-flash-20260804")
        );
        assert!(web_search_response_model(&json!({"model": "deepseek-v4-pro"})).is_none());
        assert!(
            web_search_response_model(&json!({"model": "deepseek-v4-flash-../other"})).is_none()
        );
    }

    #[test]
    fn responses_citations_keep_only_public_https_sources() {
        let output = vec![
            json!({
                "type": "web_search_call",
                "status": "completed",
                "action": {
                    "sources": [
                        {"title": "Public", "url": "https://musicbrainz.org/release/test"},
                        {"title": "Reserved", "url": "https://docs.example.test/song"},
                        {"title": "Reserved subdomain", "url": "https://www.example.com/song"},
                        {"title": "Local", "url": "https://127.0.0.1/private"},
                        {"title": "Credential", "url": "https://token@example.test/private"}
                    ]
                }
            }),
            json!({
                "type": "web_search_call",
                "status": "incomplete",
                "action": {"sources": [{"title": "Incomplete", "url": "https://www.officialcharts.com/songs/example"}]}
            }),
        ];

        assert_eq!(
            response_citations(&output),
            vec![WebCitation {
                title: "Public".to_owned(),
                url: "https://musicbrainz.org/release/test".to_owned(),
            }]
        );
    }

    #[test]
    fn responses_citations_reject_model_authored_sources_without_provider_observation() {
        let output = vec![
            json!({
                "type": "web_search_call",
                "status": "completed",
                "action": {"type": "search", "queries": ["fixture"]}
            }),
            json!({
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{
                    "type": "output_text",
                    "text": "{\"sources\":[{\"title\":\"Self reported\",\"url\":\"https://musicbrainz.org/release/test\"}]}"
                }]
            }),
        ];

        assert_eq!(response_citations(&output), Vec::<WebCitation>::new());
    }

    #[test]
    fn structured_output_normalization_repairs_only_prose_string_boundaries() {
        let repaired = normalize_structured_json(
            r#"{"song_analysis":"The review calls it "enduring", not nostalgic.","sources":[{"title":"Official","url":"https://docs.example.test/song"}]}"#,
        )
        .expect("repairable object");
        let value: Value = serde_json::from_str(&repaired).expect("canonical JSON");
        assert_eq!(
            value["song_analysis"],
            "The review calls it \"enduring\", not nostalgic."
        );
        assert_eq!(value["sources"][0]["url"], "https://docs.example.test/song");

        let newline = normalize_structured_json("{\"text\":\"line one\nline two\"}")
            .expect("raw newline is escaped");
        assert_eq!(
            serde_json::from_str::<Value>(&newline).expect("newline JSON")["text"],
            "line one\nline two"
        );
    }

    #[test]
    fn structured_output_normalization_accepts_one_fence_but_never_invents_an_object() {
        assert_eq!(
            normalize_structured_json("```json\n{\"result\":\"ok\"}\n```").as_deref(),
            Some(r#"{"result":"ok"}"#)
        );
        assert_eq!(
            normalize_structured_json(
                "Based on public research, here is the object:\n\n```json\n{\"result\":\"ok\"}\n```"
            )
            .as_deref(),
            Some(r#"{"result":"ok"}"#)
        );
        assert!(normalize_structured_json("[\"not\",\"an\",\"object\"]").is_none());
        assert!(normalize_structured_json("{\"unfinished\":\"value").is_none());
    }

    #[test]
    fn structured_output_normalization_extracts_an_object_wrapped_in_prose() {
        let wrapped = "以下是整理结果：{\"answer\":\"答案\",\"sources\":[{\"title\":\"A\",\"url\":\"https://a.test\"}]} 以上。";
        let value = normalize_structured_json(wrapped).expect("extracted object");
        let parsed: Value = serde_json::from_str(&value).expect("canonical JSON");
        assert_eq!(parsed["answer"], "答案");
        assert_eq!(parsed["sources"][0]["url"], "https://a.test");

        // Braces and escaped quotes inside strings must not break balancing.
        let tricky = "note: {\"answer\":\"use {curly} and \\\"quotes\\\" freely\"}";
        let parsed: Value =
            serde_json::from_str(&normalize_structured_json(tricky).expect("balanced strings"))
                .expect("tricky JSON");
        assert_eq!(parsed["answer"], "use {curly} and \"quotes\" freely");

        assert!(normalize_structured_json("纯散文，没有对象。").is_none());
    }

    #[test]
    fn responses_output_text_accepts_bounded_compatible_message_shapes() {
        let nested_object = json!({
            "output": [{
                "type": "message",
                "content": [{
                    "type": "text",
                    "text": {"value": "{\"answer\":\"ok\"}"}
                }]
            }]
        });
        assert_eq!(
            web_search_output_text(&nested_object),
            Some("{\"answer\":\"ok\"}".to_owned())
        );

        let top_level = json!({
            "output": [],
            "output_text": "{\"answer\":\"fallback\"}"
        });
        assert_eq!(
            web_search_output_text(&top_level),
            Some("{\"answer\":\"fallback\"}".to_owned())
        );

        let multiple_messages = json!({
            "output": [
                {"type": "message", "role": "user", "status": "completed", "content": [{"type": "output_text", "text": "ignore user"}]},
                {"type": "message", "role": "assistant", "status": "incomplete", "content": [{"type": "output_text", "text": "ignore incomplete"}]},
                {"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "{\"answer\":\"first\"}"}]},
                {"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "{\"answer\":\"final\"}"}]}
            ]
        });
        assert_eq!(
            web_search_output_text(&multiple_messages),
            Some("{\"answer\":\"final\"}".to_owned())
        );

        let completed_beats_later_statusless = json!({
            "output": [
                {"type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "{\"answer\":\"reviewed\"}"}]},
                {"type": "message", "content": [{"type": "output_text", "text": "{\"answer\":\"ambiguous\"}"}]}
            ]
        });
        assert_eq!(
            web_search_output_text(&completed_beats_later_statusless),
            Some("{\"answer\":\"reviewed\"}".to_owned())
        );
    }

    #[test]
    fn incomplete_has_its_own_status_so_budget_truncation_is_visible() {
        assert_eq!(ProviderError::Incomplete.status(), "incomplete");
        assert_eq!(
            ProviderError::StructuredOutputInvalid.status(),
            "structured_output_invalid"
        );
    }

    fn tool_options() -> ChatOptions {
        ChatOptions {
            tools: vec![ChatTool {
                name: "vault.search".to_owned(),
                description: "Search the explicitly connected local vault.".to_owned(),
                parameters: json!({
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                    "additionalProperties": false,
                }),
            }],
            tool_choice: ChatToolChoice::Auto,
            parallel_tool_calls: Some(false),
            sampling: SamplingControls {
                temperature: Some(0.2),
                top_p: Some(0.9),
                seed: Some(7),
                stop: vec!["<END>".to_owned()],
            },
            retry: ChatRetryPolicy::Bounded,
        }
    }

    #[test]
    fn tool_requests_round_trip_through_every_protocol_adapter() {
        let messages = [ChatMessage::text(
            "user",
            "Find the note about Rust ownership.",
        )];
        for kind in [
            ProviderKind::DeepSeek,
            ProviderKind::Glm,
            ProviderKind::Kimi,
            ProviderKind::Qwen,
            ProviderKind::OpenAiCompatible,
            ProviderKind::OpenRouter,
        ] {
            let body = build_openai_chat_request_with_options(
                &profile(kind),
                &messages,
                256,
                &tool_options(),
                false,
            )
            .expect("tool request");
            assert_eq!(body["tools"][0]["function"]["name"], "vault.search");
            assert_eq!(body["parallel_tool_calls"], false);
            assert_eq!(body["temperature"], 0.2);
            assert_eq!(body["top_p"], 0.9);
            assert_eq!(body["seed"], 7);
            assert_eq!(body["stop"], "<END>");
        }

        let ollama = ProviderProfile::try_new(
            "ollama",
            1,
            "Ollama",
            ProviderKind::Ollama,
            "http://127.0.0.1:11434",
            "qwen3",
            None,
            FallbackPolicy::Disabled,
        )
        .expect("Ollama profile");
        let body =
            build_ollama_chat_request_with_options(&ollama, &messages, 256, &tool_options(), false)
                .expect("Ollama tool request");
        assert_eq!(body["tools"][0]["function"]["name"], "vault.search");
        assert_eq!(body["options"]["temperature"], 0.2);
    }

    #[test]
    fn tool_call_arguments_must_decode_to_an_object() {
        let parsed = parse_openai_tool_calls(&json!([{
            "id": "call-1",
            "type": "function",
            "function": {"name": "vault.search", "arguments": "{\"query\":\"Rust\"}"}
        }]))
        .expect("valid call");
        assert_eq!(parsed[0].arguments, json!({"query": "Rust"}));

        assert_eq!(
            parse_openai_tool_calls(&json!([{
                "id": "call-1",
                "function": {"name": "vault.search", "arguments": "[]"}
            }])),
            Err(ProviderError::StructuredOutputInvalid),
        );
    }

    #[test]
    fn deepseek_thinking_tool_continuation_carries_reasoning_content() {
        let mut assistant = ChatMessage::text("assistant", "");
        assistant.tool_calls.push(ToolCall {
            id: "call-1".to_owned(),
            name: "vault.search".to_owned(),
            arguments: json!({"query": "ownership"}),
        });
        // A checkpoint resumed after a pause, retry, or restart no longer
        // carries reasoning (retention policy strips it at rest). The encoder
        // emits an empty placeholder so the run stays resumable instead of
        // dying deterministically as `provider_configuration`.
        let body = build_openai_chat_request_with_options(
            &profile(ProviderKind::DeepSeek),
            &[assistant.clone()],
            128,
            &tool_options(),
            false,
        )
        .expect("DeepSeek continuation without persisted reasoning");
        assert_eq!(body["messages"][0]["reasoning_content"], "");
        assistant.reasoning_content = Some("I should inspect the connected vault.".to_owned());
        let body = build_openai_chat_request_with_options(
            &profile(ProviderKind::DeepSeek),
            &[assistant],
            128,
            &tool_options(),
            false,
        )
        .expect("DeepSeek continuation");
        assert_eq!(
            body["messages"][0]["reasoning_content"],
            "I should inspect the connected vault."
        );
    }

    #[test]
    fn deepseek_reasoning_off_skips_the_placeholder() {
        let mut assistant = ChatMessage::text("assistant", "");
        assistant.tool_calls.push(ToolCall {
            id: "call-1".to_owned(),
            name: "vault.search".to_owned(),
            arguments: json!({"query": "ownership"}),
        });
        let body = build_openai_chat_request_with_options(
            &reasoning_profile(ProviderKind::DeepSeek, ReasoningEffort::Off, None),
            &[assistant],
            128,
            &tool_options(),
            false,
        )
        .expect("DeepSeek non-thinking continuation");
        assert!(body["messages"][0].get("reasoning_content").is_none());
    }

    #[test]
    fn accounting_uses_a_real_tokenizer_and_records_priced_models() {
        let messages = [ChatMessage::text(
            "user",
            "你好，Restork。研究一下这个问题。",
        )];
        let tokens = estimate_chat_tokens(&messages).expect("token estimate");
        assert!(tokens > 4);
        assert_eq!(
            model_cost_usd_micros("deepseek-v4-pro", 1_000, 500),
            Some(870)
        );
        assert_eq!(model_cost_usd_micros("unknown-model", 1_000, 500), None);
    }

    #[test]
    fn retry_after_overrides_exponential_jitter_and_429_is_retryable() {
        let mut headers = HeaderMap::new();
        headers.insert(RETRY_AFTER, "3".parse().expect("header"));
        assert_eq!(retry_delay(&headers, 0), Duration::from_secs(3));
        let jittered = retry_delay(&HeaderMap::new(), 0);
        assert!((Duration::from_millis(200)..=Duration::from_millis(300)).contains(&jittered));
        assert!(retryable_discovery_status(StatusCode::TOO_MANY_REQUESTS));
    }

    #[tokio::test]
    async fn streaming_yields_the_first_chunk_before_the_body_finishes() {
        use axum::{Router, body::Body, routing::post};
        use std::convert::Infallible;

        let app = Router::new().route(
            "/api/chat",
            post(|| async {
                let chunks = futures_util::stream::unfold(0_u8, |state| async move {
                    match state {
                        0 => Some((
                            Ok::<_, Infallible>(bytes::Bytes::from_static(
                                b"{\"message\":{\"content\":\"hel\"},\"done\":false}\n",
                            )),
                            1,
                        )),
                        1 => {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            Some((
                                Ok(bytes::Bytes::from_static(
                                    b"{\"message\":{\"content\":\"lo\"},\"done\":true,\"done_reason\":\"stop\",\"prompt_eval_count\":3,\"eval_count\":2}\n",
                                )),
                                2,
                            ))
                        }
                        _ => None,
                    }
                });
                Body::from_stream(chunks)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        let profile = ProviderProfile::try_new(
            "ollama-stream",
            1,
            "Ollama stream",
            ProviderKind::Ollama,
            &format!("http://{address}"),
            "fixture",
            None,
            FallbackPolicy::Disabled,
        )
        .expect("stream profile");
        let client = ProviderClient::new().expect("provider client");
        let mut stream = client
            .chat_stream(
                &profile,
                &[ChatMessage::text("user", "hello")],
                32,
                &ChatOptions::default(),
            )
            .await
            .expect("stream");
        let first = tokio::time::timeout(Duration::from_millis(150), stream.next())
            .await
            .expect("first chunk before completion")
            .expect("first item")
            .expect("valid chunk");
        assert_eq!(first.content, "hel");
        let second = stream
            .next()
            .await
            .expect("second item")
            .expect("valid chunk");
        assert_eq!(second.content, "lo");
        assert_eq!(second.total_tokens, Some(5));
        server.abort();
    }

    #[tokio::test]
    async fn bounded_json_reader_preserves_body_timeout_classification() {
        use axum::{Router, body::Body, routing::get};
        use std::convert::Infallible;

        let app = Router::new().route(
            "/slow-json",
            get(|| async {
                let chunks = futures_util::stream::unfold(0_u8, |state| async move {
                    match state {
                        0 => Some((
                            Ok::<_, Infallible>(bytes::Bytes::from_static(b"{\"status\":")),
                            1,
                        )),
                        1 => {
                            tokio::time::sleep(Duration::from_millis(200)).await;
                            Some((Ok(bytes::Bytes::from_static(b"\"completed\"}")), 2))
                        }
                        _ => None,
                    }
                });
                Body::from_stream(chunks)
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        let client = Client::builder()
            .timeout(Duration::from_millis(75))
            .build()
            .expect("test client");
        let response = client
            .get(format!("http://{address}/slow-json"))
            .send()
            .await
            .expect("response headers");

        assert_eq!(
            read_bounded_json(response, WEB_SEARCH_RESPONSE_MAX_BYTES)
                .await
                .expect_err("body deadline must remain a timeout"),
            ProviderError::Timeout
        );
        server.abort();
    }

    #[tokio::test]
    async fn bounded_json_reader_rejects_malformed_and_oversized_bodies() {
        use axum::{
            Router, body::Body, http::header::CONTENT_LENGTH, response::Response, routing::get,
        };

        let app = Router::new()
            .route("/malformed", get(|| async { "not-json" }))
            .route(
                "/oversized",
                get(|| async {
                    let body = vec![b'x'; WEB_SEARCH_RESPONSE_MAX_BYTES + 1];
                    Response::builder()
                        .header(CONTENT_LENGTH, body.len())
                        .body(Body::from(body))
                        .expect("oversized fixture")
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("mock server");
        });
        let client = Client::new();

        for path in ["malformed", "oversized"] {
            let response = client
                .get(format!("http://{address}/{path}"))
                .send()
                .await
                .expect("fixture response");
            assert_eq!(
                read_bounded_json(response, WEB_SEARCH_RESPONSE_MAX_BYTES)
                    .await
                    .expect_err("invalid fixture must be rejected"),
                ProviderError::InvalidResponse
            );
        }
        server.abort();
    }
}
