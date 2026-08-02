//! Bounded provider transport and native secret resolution.
//!
//! Provider configuration contains only a native secret reference. Secret
//! values are resolved just-in-time, never serialized, and zeroized on drop.

mod secrets;

use std::time::{Duration, Instant};

use reqwest::{Client, StatusCode, redirect::Policy};
use restork_personal::{
    ModelDiscovery, ProviderAuthKind, ProviderProfile, ProviderProtocol, ProviderRequestAdapter,
    ReasoningEffort,
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
                connection_checked: true,
                model_available: Some(true),
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
                setup_command: "restorkd provider configure".to_owned(),
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
                    .client
                    .get(format!("{}/api/tags", profile.base_url()))
                    .send()
                    .await
                    .map_err(map_transport)?;
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
                    .client
                    .get(format!("{}/models", profile.base_url()))
                    .bearer_auth(secret.expose())
                    .send()
                    .await
                    .map_err(map_transport)?;
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
}
