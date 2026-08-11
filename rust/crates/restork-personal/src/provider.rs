use serde::{Deserialize, Serialize};

use crate::{
    error::{ContractError, ContractResult},
    validation::{hash_parts, normalize_id, normalize_text, validate_version},
};

pub const PROVIDER_REGISTRY_VERSION: u16 = 2;

/// Provider identity. Transport, endpoint, credential, and capability behavior
/// are resolved through the central registry instead of scattered matches.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub enum ProviderKind {
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "openai")]
    OpenAi,
    #[serde(rename = "anthropic")]
    Anthropic,
    #[serde(rename = "minimax")]
    MiniMax,
    #[serde(rename = "mimo")]
    MiMo,
    #[serde(rename = "glm")]
    Glm,
    #[serde(rename = "kimi")]
    Kimi,
    #[serde(rename = "qwen")]
    Qwen,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "open_ai_compatible")]
    OpenAiCompatible,
    #[serde(rename = "openrouter")]
    OpenRouter,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderProtocol {
    OpenAiChatCompletions,
    AnthropicMessages,
    OllamaChat,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderAuthKind {
    None,
    Bearer,
    ApiKeyHeader,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelDiscovery {
    OpenAiModels,
    AnthropicModels,
    OllamaTags,
    ManualOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderRequestAdapter {
    StandardOpenAi,
    Anthropic,
    DeepSeek,
    Glm,
    Kimi,
    Qwen,
    Ollama,
    OpenRouter,
    MiMo,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningEffort {
    #[default]
    Auto,
    #[serde(rename = "none")]
    Off,
    Minimal,
    Low,
    Medium,
    High,
    Xhigh,
    Max,
}

impl ReasoningEffort {
    #[must_use]
    pub const fn as_wire_value(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Off => "none",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
            Self::Max => "max",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ReasoningCapabilities {
    pub can_disable: bool,
    pub supported_efforts: &'static [ReasoningEffort],
    pub supports_token_budget: bool,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReasoningConfig {
    #[serde(default)]
    effort: ReasoningEffort,
    #[serde(default)]
    max_tokens: Option<u32>,
}

impl ReasoningConfig {
    pub fn try_new(
        kind: ProviderKind,
        effort: ReasoningEffort,
        max_tokens: Option<u32>,
    ) -> ContractResult<Self> {
        let capabilities = kind.definition().reasoning;
        if effort == ReasoningEffort::Off && !capabilities.can_disable {
            return Err(ContractError::new(
                "provider.reasoning.effort",
                "this provider cannot disable reasoning",
            ));
        }
        if !matches!(effort, ReasoningEffort::Auto | ReasoningEffort::Off)
            && !capabilities.supported_efforts.contains(&effort)
        {
            return Err(ContractError::new(
                "provider.reasoning.effort",
                "this provider does not support the selected reasoning effort",
            ));
        }
        if let Some(max_tokens) = max_tokens {
            if !capabilities.supports_token_budget {
                return Err(ContractError::new(
                    "provider.reasoning.max_tokens",
                    "this provider does not support a reasoning token budget",
                ));
            }
            if !(256..=128_000).contains(&max_tokens) {
                return Err(ContractError::new(
                    "provider.reasoning.max_tokens",
                    "reasoning token budget must be between 256 and 128000",
                ));
            }
            if matches!(effort, ReasoningEffort::Auto | ReasoningEffort::Off) {
                return Err(ContractError::new(
                    "provider.reasoning.max_tokens",
                    "a token budget requires an enabled explicit effort",
                ));
            }
        }
        Ok(Self { effort, max_tokens })
    }

    #[must_use]
    pub const fn effort(self) -> ReasoningEffort {
        self.effort
    }

    #[must_use]
    pub const fn max_tokens(self) -> Option<u32> {
        self.max_tokens
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndpointPolicy {
    ExactOfficial,
    PublicHttps,
    LoopbackOnly,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub tool_calls: bool,
    pub json_output: bool,
    pub reasoning: bool,
    pub vision: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderDefinition {
    pub registry_version: u16,
    pub kind: ProviderKind,
    pub id: &'static str,
    pub display_name: &'static str,
    pub protocol: ProviderProtocol,
    pub default_base_url: &'static str,
    pub default_model: &'static str,
    pub recommended_models: &'static [&'static str],
    pub endpoint_policy: EndpointPolicy,
    pub auth_kind: ProviderAuthKind,
    pub model_discovery: ModelDiscovery,
    pub request_adapter: ProviderRequestAdapter,
    pub capabilities: ProviderCapabilities,
    pub reasoning: ReasoningCapabilities,
    pub docs_url: &'static str,
}

const STANDARD_CLOUD: ProviderCapabilities = ProviderCapabilities {
    streaming: true,
    tool_calls: true,
    json_output: true,
    reasoning: false,
    vision: false,
};

const HIGH_MAX: [ReasoningEffort; 2] = [ReasoningEffort::High, ReasoningEffort::Max];
const THREE_LEVELS: [ReasoningEffort; 3] = [
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
];
const ALL_EFFORTS: [ReasoningEffort; 6] = [
    ReasoningEffort::Minimal,
    ReasoningEffort::Low,
    ReasoningEffort::Medium,
    ReasoningEffort::High,
    ReasoningEffort::Xhigh,
    ReasoningEffort::Max,
];
const TOGGLE_ONLY: ReasoningCapabilities = ReasoningCapabilities {
    can_disable: true,
    supported_efforts: &[],
    supports_token_budget: false,
};
const AUTO_ONLY: ReasoningCapabilities = ReasoningCapabilities {
    can_disable: false,
    supported_efforts: &[],
    supports_token_budget: false,
};

const PROVIDER_DEFINITIONS: [ProviderDefinition; 11] = [
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::DeepSeek,
        id: "deepseek",
        display_name: "DeepSeek",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.deepseek.com",
        default_model: "deepseek-v4-pro",
        recommended_models: &["deepseek-v4-pro", "deepseek-v4-flash"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::DeepSeek,
        capabilities: ProviderCapabilities {
            reasoning: true,
            ..STANDARD_CLOUD
        },
        reasoning: ReasoningCapabilities {
            can_disable: true,
            supported_efforts: &HIGH_MAX,
            supports_token_budget: false,
        },
        docs_url: "https://api-docs.deepseek.com/",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::OpenAi,
        id: "openai",
        display_name: "OpenAI",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.openai.com/v1",
        default_model: "gpt-5.6",
        recommended_models: &["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::StandardOpenAi,
        capabilities: STANDARD_CLOUD,
        reasoning: AUTO_ONLY,
        docs_url: "https://platform.openai.com/docs/api-reference",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::Anthropic,
        id: "anthropic",
        display_name: "Anthropic",
        protocol: ProviderProtocol::AnthropicMessages,
        default_base_url: "https://api.anthropic.com/v1",
        default_model: "claude-sonnet-5",
        recommended_models: &[
            "claude-sonnet-5",
            "claude-opus-5",
            "claude-fable-5",
            "claude-haiku-4-5",
        ],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::ApiKeyHeader,
        model_discovery: ModelDiscovery::AnthropicModels,
        request_adapter: ProviderRequestAdapter::Anthropic,
        capabilities: ProviderCapabilities {
            streaming: false,
            tool_calls: true,
            json_output: true,
            reasoning: false,
            vision: false,
        },
        reasoning: AUTO_ONLY,
        docs_url: "https://platform.claude.com/docs/en/api/messages",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::MiniMax,
        id: "minimax",
        display_name: "MiniMax",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.minimaxi.com/v1",
        default_model: "MiniMax-M2.7",
        recommended_models: &[
            "MiniMax-M2.7",
            "MiniMax-M2.7-highspeed",
            "MiniMax-M2.5",
            "MiniMax-M2.5-highspeed",
        ],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::ManualOnly,
        request_adapter: ProviderRequestAdapter::StandardOpenAi,
        capabilities: STANDARD_CLOUD,
        reasoning: AUTO_ONLY,
        docs_url: "https://platform.minimaxi.com/docs/guides/text-chat",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::MiMo,
        id: "mimo",
        display_name: "MiMo",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.xiaomimimo.com/v1",
        default_model: "mimo-v2.5-pro",
        recommended_models: &["mimo-v2.5-pro", "mimo-v2.5"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::MiMo,
        capabilities: ProviderCapabilities {
            reasoning: true,
            ..STANDARD_CLOUD
        },
        reasoning: TOGGLE_ONLY,
        docs_url: "https://mimo.mi.com/docs/zh-CN/api/chat/openai-api",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::Glm,
        id: "glm",
        display_name: "GLM",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://open.bigmodel.cn/api/paas/v4",
        default_model: "glm-5.2",
        recommended_models: &["glm-5.2"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::ManualOnly,
        request_adapter: ProviderRequestAdapter::Glm,
        capabilities: STANDARD_CLOUD,
        reasoning: ReasoningCapabilities {
            can_disable: true,
            supported_efforts: &HIGH_MAX,
            supports_token_budget: false,
        },
        docs_url: "https://docs.bigmodel.cn/",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::Kimi,
        id: "kimi",
        display_name: "Kimi",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.moonshot.cn/v1",
        default_model: "kimi-k2.5",
        recommended_models: &["kimi-k2.5"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::Kimi,
        capabilities: STANDARD_CLOUD,
        reasoning: TOGGLE_ONLY,
        docs_url: "https://platform.kimi.com/docs/",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::Qwen,
        id: "qwen",
        display_name: "Qwen",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        default_model: "qwen-max",
        recommended_models: &["qwen-max", "qwen-plus", "qwen-turbo"],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::ManualOnly,
        request_adapter: ProviderRequestAdapter::Qwen,
        capabilities: ProviderCapabilities {
            vision: true,
            ..STANDARD_CLOUD
        },
        reasoning: ReasoningCapabilities {
            can_disable: true,
            supported_efforts: &ALL_EFFORTS,
            supports_token_budget: true,
        },
        docs_url: "https://help.aliyun.com/zh/model-studio/",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::Ollama,
        id: "ollama",
        display_name: "Ollama",
        protocol: ProviderProtocol::OllamaChat,
        default_base_url: "http://127.0.0.1:11434",
        default_model: "",
        recommended_models: &[],
        endpoint_policy: EndpointPolicy::LoopbackOnly,
        auth_kind: ProviderAuthKind::None,
        model_discovery: ModelDiscovery::OllamaTags,
        request_adapter: ProviderRequestAdapter::Ollama,
        capabilities: ProviderCapabilities {
            streaming: true,
            tool_calls: true,
            json_output: true,
            reasoning: true,
            vision: true,
        },
        reasoning: ReasoningCapabilities {
            can_disable: true,
            supported_efforts: &THREE_LEVELS,
            supports_token_budget: false,
        },
        docs_url: "https://docs.ollama.com/api/introduction",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::OpenAiCompatible,
        id: "open_ai_compatible",
        display_name: "OpenAI-compatible",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://api.example.invalid/v1",
        default_model: "",
        recommended_models: &[],
        endpoint_policy: EndpointPolicy::PublicHttps,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::StandardOpenAi,
        capabilities: STANDARD_CLOUD,
        reasoning: AUTO_ONLY,
        docs_url: "https://github.com/Totoro-qaq/restork/blob/main/docs/providers.md",
    },
    ProviderDefinition {
        registry_version: PROVIDER_REGISTRY_VERSION,
        kind: ProviderKind::OpenRouter,
        id: "openrouter",
        display_name: "OpenRouter",
        protocol: ProviderProtocol::OpenAiChatCompletions,
        default_base_url: "https://openrouter.ai/api/v1",
        default_model: "",
        recommended_models: &[],
        endpoint_policy: EndpointPolicy::ExactOfficial,
        auth_kind: ProviderAuthKind::Bearer,
        model_discovery: ModelDiscovery::OpenAiModels,
        request_adapter: ProviderRequestAdapter::OpenRouter,
        capabilities: STANDARD_CLOUD,
        reasoning: ReasoningCapabilities {
            can_disable: true,
            supported_efforts: &ALL_EFFORTS,
            supports_token_budget: true,
        },
        docs_url: "https://openrouter.ai/docs/quickstart",
    },
];

impl ProviderKind {
    #[must_use]
    pub fn definition(self) -> &'static ProviderDefinition {
        PROVIDER_DEFINITIONS
            .iter()
            .find(|definition| definition.kind == self)
            .expect("every ProviderKind must have one registry definition")
    }
}

#[must_use]
pub const fn provider_definitions() -> &'static [ProviderDefinition] {
    &PROVIDER_DEFINITIONS
}

/// An explicitly named fallback that still requires a user confirmation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ExplicitFallback {
    provider_profile_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExplicitFallbackWire {
    provider_profile_id: String,
}

impl ExplicitFallback {
    pub fn try_new(provider_profile_id: &str) -> ContractResult<Self> {
        Ok(Self {
            provider_profile_id: normalize_id(provider_profile_id, "fallback.provider_profile_id")?,
        })
    }

    #[must_use]
    pub fn provider_profile_id(&self) -> &str {
        &self.provider_profile_id
    }
}

impl<'de> Deserialize<'de> for ExplicitFallback {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ExplicitFallbackWire::deserialize(deserializer)?;
        Self::try_new(&wire.provider_profile_id).map_err(serde::de::Error::custom)
    }
}

/// Restork never performs an invisible provider fallback.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FallbackPolicy {
    Disabled,
    RequireConfirmation(ExplicitFallback),
}

impl FallbackPolicy {
    #[must_use]
    pub const fn requires_confirmation(&self) -> bool {
        matches!(self, Self::RequireConfirmation(_))
    }
}

/// A non-secret provider profile. Credential values cannot be represented.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProviderProfile {
    profile_id: String,
    version: u64,
    display_name: String,
    kind: ProviderKind,
    base_url: String,
    model: String,
    secret_ref: Option<String>,
    fallback: FallbackPolicy,
    reasoning: ReasoningConfig,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderProfileWire {
    profile_id: String,
    version: u64,
    display_name: String,
    kind: ProviderKind,
    base_url: String,
    model: String,
    secret_ref: Option<String>,
    fallback: FallbackPolicy,
    #[serde(default)]
    reasoning: ReasoningConfig,
}

impl ProviderProfile {
    #[allow(clippy::too_many_arguments)]
    pub fn try_new(
        profile_id: &str,
        version: u64,
        display_name: &str,
        kind: ProviderKind,
        base_url: &str,
        model: &str,
        secret_ref: Option<&str>,
        fallback: FallbackPolicy,
    ) -> ContractResult<Self> {
        let profile_id = normalize_id(profile_id, "provider.profile_id")?;
        let base_url = normalize_endpoint(kind, base_url)?;
        let secret_ref = secret_ref.map(validate_secret_ref).transpose()?;
        match kind.definition().auth_kind {
            ProviderAuthKind::Bearer | ProviderAuthKind::ApiKeyHeader if secret_ref.is_none() => {
                return Err(ContractError::new(
                    "provider.secret_ref",
                    "cloud providers require a native secret reference",
                ));
            }
            ProviderAuthKind::None if secret_ref.is_some() => {
                return Err(ContractError::new(
                    "provider.secret_ref",
                    "this local provider does not accept a credential",
                ));
            }
            _ => {}
        }
        if let FallbackPolicy::RequireConfirmation(explicit) = &fallback
            && explicit.provider_profile_id() == profile_id.as_str()
        {
            return Err(ContractError::new(
                "provider.fallback",
                "cannot reference the same provider profile",
            ));
        }
        Ok(Self {
            profile_id,
            version: validate_version(version, "provider.version")?,
            display_name: normalize_text(display_name, "provider.display_name", 120)?,
            kind,
            base_url,
            model: normalize_text(model, "provider.model", 256)?,
            secret_ref,
            fallback,
            reasoning: ReasoningConfig::default(),
        })
    }

    pub fn with_reasoning(
        mut self,
        effort: ReasoningEffort,
        max_tokens: Option<u32>,
    ) -> ContractResult<Self> {
        self.reasoning = ReasoningConfig::try_new(self.kind, effort, max_tokens)?;
        Ok(self)
    }

    #[must_use]
    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }

    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }

    #[must_use]
    pub const fn kind(&self) -> ProviderKind {
        self.kind
    }

    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    #[must_use]
    pub fn secret_ref(&self) -> Option<&str> {
        self.secret_ref.as_deref()
    }

    #[must_use]
    pub const fn fallback(&self) -> &FallbackPolicy {
        &self.fallback
    }

    #[must_use]
    pub const fn reasoning(&self) -> ReasoningConfig {
        self.reasoning
    }

    #[must_use]
    pub fn content_hash(&self) -> String {
        let version = self.version.to_string();
        let kind = format!("{:?}", self.kind);
        let registry_version = PROVIDER_REGISTRY_VERSION.to_string();
        let adapter = format!("{:?}", self.kind.definition().request_adapter);
        let fallback = match &self.fallback {
            FallbackPolicy::Disabled => "disabled".to_owned(),
            FallbackPolicy::RequireConfirmation(explicit) => {
                format!("confirm:{}", explicit.provider_profile_id())
            }
        };
        let reasoning_effort = self.reasoning.effort().as_wire_value();
        let reasoning_budget = self
            .reasoning
            .max_tokens()
            .map(|value| value.to_string())
            .unwrap_or_default();
        hash_parts([
            self.profile_id.as_str(),
            version.as_str(),
            registry_version.as_str(),
            self.display_name.as_str(),
            kind.as_str(),
            adapter.as_str(),
            self.base_url.as_str(),
            self.model.as_str(),
            self.secret_ref.as_deref().unwrap_or(""),
            fallback.as_str(),
            reasoning_effort,
            reasoning_budget.as_str(),
        ])
    }
}

impl<'de> Deserialize<'de> for ProviderProfile {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let wire = ProviderProfileWire::deserialize(deserializer)?;
        Self::try_new(
            &wire.profile_id,
            wire.version,
            &wire.display_name,
            wire.kind,
            &wire.base_url,
            &wire.model,
            wire.secret_ref.as_deref(),
            wire.fallback,
        )
        .and_then(|profile| {
            profile.with_reasoning(wire.reasoning.effort(), wire.reasoning.max_tokens())
        })
        .map_err(serde::de::Error::custom)
    }
}

fn normalize_endpoint(kind: ProviderKind, value: &str) -> ContractResult<String> {
    let endpoint = normalize_text(value, "provider.base_url", 2_048)?
        .trim_end_matches('/')
        .to_owned();
    let definition = kind.definition();
    match definition.endpoint_policy {
        EndpointPolicy::ExactOfficial => {
            if endpoint != definition.default_base_url {
                return Err(ContractError::new(
                    "provider.base_url",
                    "the built-in provider requires its exact official base URL",
                ));
            }
        }
        EndpointPolicy::LoopbackOnly => validate_loopback_origin(&endpoint)?,
        EndpointPolicy::PublicHttps => validate_public_https_endpoint(&endpoint)?,
    }
    Ok(endpoint)
}

fn validate_loopback_origin(endpoint: &str) -> ContractResult<()> {
    let Some(authority) = endpoint
        .strip_prefix("http://")
        .or_else(|| endpoint.strip_prefix("https://"))
    else {
        return Err(ContractError::new(
            "provider.base_url",
            "Ollama requires an HTTP(S) loopback origin",
        ));
    };
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority
        .chars()
        .any(|character| matches!(character, '/' | '?' | '#' | '@'))
    {
        return Err(ContractError::new(
            "provider.base_url",
            "Ollama requires an origin without credentials or a path",
        ));
    }
    let valid = if let Some(rest) = authority.strip_prefix("[::1]") {
        rest.is_empty() || valid_port_suffix(rest)
    } else if let Some(rest) = authority.strip_prefix("127.0.0.1") {
        rest.is_empty() || valid_port_suffix(rest)
    } else if let Some(rest) = authority.strip_prefix("localhost") {
        rest.is_empty() || valid_port_suffix(rest)
    } else {
        false
    };
    if !valid {
        return Err(ContractError::new(
            "provider.base_url",
            "Ollama endpoint must be exact loopback",
        ));
    }
    Ok(())
}

fn valid_port_suffix(value: &str) -> bool {
    value
        .strip_prefix(':')
        .is_some_and(|port| !port.is_empty() && port.parse::<u16>().is_ok())
}

fn validate_public_https_endpoint(endpoint: &str) -> ContractResult<()> {
    let Some(remainder) = endpoint.strip_prefix("https://") else {
        return Err(ContractError::new(
            "provider.base_url",
            "OpenAI-compatible endpoints require HTTPS",
        ));
    };
    if remainder
        .chars()
        .any(|character| matches!(character, '?' | '#' | '@'))
    {
        return Err(ContractError::new(
            "provider.base_url",
            "endpoint credentials, query strings, and fragments are forbidden",
        ));
    }
    let authority = remainder.split('/').next().unwrap_or_default();
    let host = authority
        .strip_prefix('[')
        .and_then(|value| value.split_once(']').map(|(host, _)| host))
        .unwrap_or_else(|| authority.split(':').next().unwrap_or_default())
        .to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host == "::1"
        || host == "0.0.0.0"
        || host.starts_with("127.")
        || is_private_ipv4_literal(&host)
    {
        return Err(ContractError::new(
            "provider.base_url",
            "endpoint is not an explicit public HTTPS destination",
        ));
    }
    Ok(())
}

fn is_private_ipv4_literal(host: &str) -> bool {
    let octets = host
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok(octets) = octets else {
        return false;
    };
    if octets.len() != 4 {
        return false;
    }
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
        || (octets[0] == 169 && octets[1] == 254)
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn validate_secret_ref(value: &str) -> ContractResult<String> {
    let reference = normalize_text(value, "provider.secret_ref", 256)?;
    let supported = ["keychain:", "credential-manager:", "secret-service:"]
        .into_iter()
        .find_map(|prefix| reference.strip_prefix(prefix));
    let Some(identifier) = supported else {
        return Err(ContractError::new(
            "provider.secret_ref",
            "must reference a supported native secret store",
        ));
    };
    if identifier.is_empty()
        || !identifier.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return Err(ContractError::new(
            "provider.secret_ref",
            "contains an invalid native secret identifier",
        ));
    }
    Ok(reference)
}
