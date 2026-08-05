//! Bounded provider transport and native secret resolution.
//!
//! Provider configuration contains only a native secret reference. Secret
//! values are resolved just-in-time, never serialized, and zeroized on drop.

mod secrets;

use std::{
    collections::BTreeSet,
    net::IpAddr,
    time::{Duration, Instant},
};

use reqwest::{Client, RequestBuilder, StatusCode, redirect::Policy};
use restork_personal::{
    ModelDiscovery, ProviderAuthKind, ProviderKind, ProviderProfile, ProviderProtocol,
    ProviderRequestAdapter, ReasoningEffort,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub use secrets::{NativeSecretStore, SecretError};

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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatCompletion {
    pub content: String,
    pub latency_ms: u64,
    pub request_id: Option<String>,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

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
            .timeout(Duration::from_secs(90))
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
                &[ChatMessage {
                    role: "user".to_owned(),
                    content: "Reply with exactly OK.".to_owned(),
                }],
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
        if messages.is_empty()
            || messages.len() > 64
            || max_tokens == 0
            || max_tokens > 8_192
            || messages.iter().any(|message| {
                !matches!(message.role.as_str(), "system" | "user" | "assistant")
                    || message.content.len() > 128_000
                    || message.content.contains('\0')
            })
        {
            return Err(ProviderError::PolicyDenied);
        }
        match profile.kind().definition().protocol {
            ProviderProtocol::OllamaChat => self.chat_ollama(profile, messages, max_tokens).await,
            ProviderProtocol::OpenAiChatCompletions => {
                self.chat_openai(profile, messages, max_tokens).await
            }
        }
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
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ProviderError::InvalidResponse)?;
        map_status(status, &payload)?;
        if payload["status"].as_str() == Some("incomplete") {
            return Err(ProviderError::StructuredOutputInvalid);
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
        let raw_content = output
            .iter()
            .filter(|item| item["type"].as_str() == Some("message"))
            .filter_map(|item| item["content"].as_array())
            .flatten()
            .filter(|item| item["type"].as_str() == Some("output_text"))
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if raw_content.is_empty() || raw_content.len() > 100_000 {
            return Err(ProviderError::StructuredOutputInvalid);
        }
        let content = normalize_structured_json(&raw_content)
            .ok_or(ProviderError::StructuredOutputInvalid)?;
        let citations = response_citations(output, &content);
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
        let retry = request.try_clone();
        match request.send().await {
            Ok(response) if retryable_discovery_status(response.status()) => {
                let Some(retry) = retry else {
                    return Ok(response);
                };
                tokio::time::sleep(Duration::from_millis(250)).await;
                retry.send().await.map_err(map_transport)
            }
            Ok(response) => Ok(response),
            Err(error) if error.is_connect() && !error.is_timeout() => {
                let Some(retry) = retry else {
                    return Err(map_transport(error));
                };
                tokio::time::sleep(Duration::from_millis(250)).await;
                retry.send().await.map_err(map_transport)
            }
            Err(error) => Err(map_transport(error)),
        }
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
    ) -> Result<ChatCompletion, ProviderError> {
        let secret = self.resolve_secret(profile).await?;
        let started = Instant::now();
        let response = self
            .client
            .post(format!("{}/chat/completions", profile.base_url()))
            .bearer_auth(secret.expose())
            .json(&build_openai_chat_request(profile, messages, max_tokens)?)
            .send()
            .await
            .map_err(map_transport)?;
        let request_id = request_id(&response);
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ProviderError::InvalidResponse)?;
        map_status(status, &payload)?;
        let content = payload["choices"][0]["message"]["content"]
            .as_str()
            .filter(|content| !content.is_empty() && content.len() <= 2_000_000)
            .ok_or(ProviderError::InvalidResponse)?
            .to_owned();
        let usage = &payload["usage"];
        Ok(ChatCompletion {
            content,
            latency_ms: elapsed_ms(started),
            request_id,
            prompt_tokens: usage["prompt_tokens"].as_u64(),
            completion_tokens: usage["completion_tokens"].as_u64(),
            total_tokens: usage["total_tokens"].as_u64(),
        })
    }

    async fn chat_ollama(
        &self,
        profile: &ProviderProfile,
        messages: &[ChatMessage],
        max_tokens: u32,
    ) -> Result<ChatCompletion, ProviderError> {
        let started = Instant::now();
        let response = self
            .client
            .post(format!("{}/api/chat", profile.base_url()))
            .json(&build_ollama_chat_request(profile, messages, max_tokens)?)
            .send()
            .await
            .map_err(map_transport)?;
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ProviderError::InvalidResponse)?;
        map_status(status, &payload)?;
        let content = payload["message"]["content"]
            .as_str()
            .filter(|content| !content.is_empty() && content.len() <= 2_000_000)
            .ok_or(ProviderError::InvalidResponse)?
            .to_owned();
        let prompt_tokens = payload["prompt_eval_count"].as_u64();
        let completion_tokens = payload["eval_count"].as_u64();
        Ok(ChatCompletion {
            content,
            latency_ms: elapsed_ms(started),
            request_id: None,
            prompt_tokens,
            completion_tokens,
            total_tokens: prompt_tokens
                .zip(completion_tokens)
                .map(|(left, right)| left + right),
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
    if !matches!(
        profile.kind().definition().protocol,
        ProviderProtocol::OpenAiChatCompletions
    ) {
        return Err(ProviderError::Configuration);
    }
    let mut body = json!({
        "model": profile.model(),
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false
    });
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
    if !matches!(
        profile.kind().definition().protocol,
        ProviderProtocol::OllamaChat
    ) {
        return Err(ProviderError::Configuration);
    }
    let mut body = json!({
        "model": profile.model(),
        "messages": messages,
        "stream": false,
        "options": {"num_predict": max_tokens}
    });
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
    let repaired = repair_json_prose_strings(candidate)?;
    let value = serde_json::from_str::<Value>(&repaired).ok()?;
    value
        .is_object()
        .then(|| serde_json::to_string(&value).ok())
        .flatten()
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

fn response_citations(output: &[Value], output_text: &str) -> Vec<WebCitation> {
    let mut candidates = Vec::new();
    for item in output {
        if item["type"].as_str() == Some("web_search_call") {
            collect_citation_values(&item["action"], &mut candidates);
        }
        if item["type"].as_str() != Some("message") {
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
    // DeepSeek currently reports the completed query in the web-search action,
    // but may omit output_text annotations. Restork requires a top-level
    // `sources` array in its response schema, then treats every returned value
    // as untrusted until the same public-HTTPS gate below accepts it.
    if let Ok(structured) = serde_json::from_str::<Value>(output_text)
        && let Some(sources) = structured["sources"].as_array()
    {
        for source in sources.iter().take(12) {
            if let Some(url) = source["url"].as_str() {
                candidates.push((
                    source["title"].as_str().unwrap_or_default().to_owned(),
                    url.to_owned(),
                ));
            }
        }
    }
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

fn map_transport(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Unavailable
    }
}

fn retryable_discovery_status(status: StatusCode) -> bool {
    matches!(status.as_u16(), 502..=504)
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

fn provider_setup_command(profile: &ProviderProfile) -> String {
    if profile.kind() == ProviderKind::Ollama {
        "ollama serve".to_owned()
    } else {
        format!(
            "restorkd provider configure {}",
            profile.kind().definition().id
        )
    }
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
        let messages = [ChatMessage {
            role: "user".to_owned(),
            content: "hello".to_owned(),
        }];
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
    fn fixed_smoke_disables_reasoning_and_retries_only_transient_discovery_statuses() {
        let messages = [ChatMessage {
            role: "user".to_owned(),
            content: "Reply with exactly OK.".to_owned(),
        }];
        let smoke = fixed_smoke_profile(&profile(ProviderKind::DeepSeek));
        let request =
            build_openai_chat_request(&smoke, &messages, 16).expect("fixed smoke request");
        assert_eq!(request["thinking"]["type"], "disabled");
        assert!(retryable_discovery_status(StatusCode::BAD_GATEWAY));
        assert!(retryable_discovery_status(StatusCode::SERVICE_UNAVAILABLE));
        assert!(retryable_discovery_status(StatusCode::GATEWAY_TIMEOUT));
        assert!(!retryable_discovery_status(StatusCode::TOO_MANY_REQUESTS));
        assert!(!retryable_discovery_status(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn setup_commands_follow_the_selected_provider_without_exposing_secrets() {
        assert_eq!(
            provider_setup_command(&profile(ProviderKind::Qwen)),
            "restorkd provider configure qwen"
        );
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
        let output = vec![json!({
            "type": "web_search_call",
            "status": "completed",
            "action": {
                "sources": [
                    {"title": "Public", "url": "https://docs.example.test/song"},
                    {"title": "Local", "url": "https://127.0.0.1/private"},
                    {"title": "Credential", "url": "https://token@example.test/private"}
                ]
            }
        })];

        assert_eq!(
            response_citations(&output, "{}"),
            vec![WebCitation {
                title: "Public".to_owned(),
                url: "https://docs.example.test/song".to_owned(),
            }]
        );
    }

    #[test]
    fn responses_citations_accept_validated_structured_sources_without_annotations() {
        let output = vec![json!({
            "type": "web_search_call",
            "status": "completed",
            "action": {"type": "search", "queries": ["fixture"]}
        })];

        assert_eq!(
            response_citations(
                &output,
                r#"{"sources":[{"title":"Official","url":"https://docs.example.test/song"}]}"#,
            ),
            vec![WebCitation {
                title: "Official".to_owned(),
                url: "https://docs.example.test/song".to_owned(),
            }]
        );
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
}
