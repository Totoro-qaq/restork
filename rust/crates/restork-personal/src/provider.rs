use serde::{Deserialize, Serialize};

use crate::{
    error::{ContractError, ContractResult},
    validation::{hash_parts, normalize_id, normalize_text, validate_version},
};

/// Provider transport class. It determines endpoint and secret constraints.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum ProviderKind {
    #[serde(rename = "deepseek")]
    DeepSeek,
    #[serde(rename = "ollama")]
    Ollama,
    #[serde(rename = "open_ai_compatible")]
    OpenAiCompatible,
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
        match kind {
            ProviderKind::DeepSeek | ProviderKind::OpenAiCompatible if secret_ref.is_none() => {
                return Err(ContractError::new(
                    "provider.secret_ref",
                    "cloud providers require a native secret reference",
                ));
            }
            ProviderKind::Ollama if secret_ref.is_some() => {
                return Err(ContractError::new(
                    "provider.secret_ref",
                    "the loopback Ollama profile does not accept a credential",
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
        })
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
    pub fn content_hash(&self) -> String {
        let version = self.version.to_string();
        let kind = format!("{:?}", self.kind);
        let fallback = match &self.fallback {
            FallbackPolicy::Disabled => "disabled".to_owned(),
            FallbackPolicy::RequireConfirmation(explicit) => {
                format!("confirm:{}", explicit.provider_profile_id())
            }
        };
        hash_parts([
            self.profile_id.as_str(),
            version.as_str(),
            self.display_name.as_str(),
            kind.as_str(),
            self.base_url.as_str(),
            self.model.as_str(),
            self.secret_ref.as_deref().unwrap_or(""),
            fallback.as_str(),
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
        .map_err(serde::de::Error::custom)
    }
}

fn normalize_endpoint(kind: ProviderKind, value: &str) -> ContractResult<String> {
    let endpoint = normalize_text(value, "provider.base_url", 2_048)?;
    match kind {
        ProviderKind::DeepSeek => {
            if endpoint != "https://api.deepseek.com" {
                return Err(ContractError::new(
                    "provider.base_url",
                    "DeepSeek requires its exact official origin",
                ));
            }
        }
        ProviderKind::Ollama => validate_loopback_origin(&endpoint)?,
        ProviderKind::OpenAiCompatible => validate_public_https_endpoint(&endpoint)?,
    }
    Ok(endpoint.trim_end_matches('/').to_owned())
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
