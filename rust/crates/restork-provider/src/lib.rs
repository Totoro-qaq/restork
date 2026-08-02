//! Bounded provider transport and native secret resolution.
//!
//! Provider configuration contains only a native secret reference. Secret
//! values are resolved just-in-time, never serialized, and zeroized on drop.

mod secrets;

use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, redirect::Policy};
use restork_personal::{ProviderKind, ProviderProfile};
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

pub struct ProviderClient {
    client: Client,
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
        Ok(Self {
            client,
            secrets: NativeSecretStore,
        })
    }

    pub async fn diagnose(&self, profile: &ProviderProfile, smoke: bool) -> ProviderDiagnostic {
        let started = Instant::now();
        let result = if smoke {
            self.chat(
                profile,
                &[ChatMessage {
                    role: "user".to_owned(),
                    content: "Reply with exactly OK.".to_owned(),
                }],
                16,
            )
            .await
            .map(|completion| DiagnosticSuccess {
                request_id: completion.request_id,
                prompt_tokens: completion.prompt_tokens,
                completion_tokens: completion.completion_tokens,
                total_tokens: completion.total_tokens,
            })
        } else {
            self.check_models(profile).await
        };
        match result {
            Ok(success) => ProviderDiagnostic {
                schema_version: 1,
                provider: profile.profile_id().to_owned(),
                model: profile.model().to_owned(),
                status: if smoke { "smoke_passed" } else { "connected" }.to_owned(),
                message: if smoke {
                    "The fixed public low-token completion passed."
                } else {
                    "Authentication succeeded and the configured model is available."
                }
                .to_owned(),
                setup_command: "restorkd provider configure".to_owned(),
                config_present: true,
                config_valid: true,
                credential_present: profile.secret_ref().is_some(),
                connection_checked: true,
                connection_ok: Some(true),
                model_available: Some(true),
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
                setup_command: "restorkd provider configure".to_owned(),
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

    /// Check native credential availability without exposing the credential to callers.
    pub async fn credential_present(&self, profile: &ProviderProfile) -> bool {
        match profile.kind() {
            ProviderKind::Ollama => true,
            ProviderKind::DeepSeek | ProviderKind::OpenAiCompatible => {
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
        match profile.kind() {
            ProviderKind::Ollama => self.chat_ollama(profile, messages, max_tokens).await,
            ProviderKind::DeepSeek | ProviderKind::OpenAiCompatible => {
                self.chat_openai(profile, messages, max_tokens).await
            }
        }
    }

    async fn check_models(
        &self,
        profile: &ProviderProfile,
    ) -> Result<DiagnosticSuccess, ProviderError> {
        let request = match profile.kind() {
            ProviderKind::Ollama => self.client.get(format!("{}/api/tags", profile.base_url())),
            ProviderKind::DeepSeek | ProviderKind::OpenAiCompatible => {
                let secret = self.resolve_secret(profile).await?;
                self.client
                    .get(format!("{}/models", profile.base_url()))
                    .bearer_auth(secret.expose())
            }
        };
        let response = request.send().await.map_err(map_transport)?;
        let request_id = request_id(&response);
        let status = response.status();
        let payload: Value = response
            .json()
            .await
            .map_err(|_| ProviderError::InvalidResponse)?;
        map_status(status, &payload)?;
        let available = match profile.kind() {
            ProviderKind::Ollama => payload["models"].as_array().is_some_and(|models| {
                models.iter().any(|model| {
                    model["name"].as_str() == Some(profile.model())
                        || model["model"].as_str() == Some(profile.model())
                })
            }),
            ProviderKind::DeepSeek | ProviderKind::OpenAiCompatible => {
                payload["data"].as_array().is_some_and(|models| {
                    models
                        .iter()
                        .any(|model| model["id"].as_str() == Some(profile.model()))
                })
            }
        };
        if !available {
            return Err(ProviderError::ModelUnavailable);
        }
        Ok(DiagnosticSuccess {
            request_id,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
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
            .json(&json!({
                "model": profile.model(),
                "messages": messages,
                "max_tokens": max_tokens,
                "stream": false,
                // DeepSeek V4 enables thinking by default. Restork's standard
                // bounded chat profile prefers predictable first-response latency;
                // an explicit future profile may opt into governed thinking.
                "thinking": {"type": "disabled"}
            }))
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
            .json(&json!({
                "model": profile.model(),
                "messages": messages,
                "stream": false,
                "options": {"num_predict": max_tokens}
            }))
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

struct DiagnosticSuccess {
    request_id: Option<String>,
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
    total_tokens: Option<u64>,
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
        ProviderError::PolicyDenied => "The provider request was denied by local policy.",
    }
}
