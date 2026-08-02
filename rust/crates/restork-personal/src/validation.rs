use sha2::{Digest, Sha256};

use crate::error::{ContractError, ContractResult};

/// Return a lowercase SHA-256 content digest.
#[must_use]
pub fn content_hash(payload: &[u8]) -> String {
    lower_hex(&Sha256::digest(payload))
}

pub(crate) fn hash_parts<I, S>(parts: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut digest = Sha256::new();
    for part in parts {
        let part = part.as_ref();
        digest.update(part.len().to_be_bytes());
        digest.update(part.as_bytes());
    }
    lower_hex(&digest.finalize())
}

fn lower_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

pub(crate) fn normalize_optional_text(
    value: Option<&str>,
    field: &'static str,
    maximum: usize,
) -> ContractResult<Option<String>> {
    value
        .map(|candidate| normalize_text(candidate, field, maximum))
        .transpose()
}

pub(crate) fn normalize_text(
    value: &str,
    field: &'static str,
    maximum: usize,
) -> ContractResult<String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(ContractError::new(field, "must not be empty"));
    }
    if normalized.len() > maximum {
        return Err(ContractError::new(field, "exceeds its byte limit"));
    }
    if normalized.chars().any(char::is_control) {
        return Err(ContractError::new(field, "contains a control character"));
    }
    Ok(normalized.to_owned())
}

pub(crate) fn normalize_id(value: &str, field: &'static str) -> ContractResult<String> {
    let normalized = normalize_text(value, field, 256)?;
    if !normalized.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | ':' | '/')
    }) {
        return Err(ContractError::new(
            field,
            "contains a character outside the identifier alphabet",
        ));
    }
    if normalized.contains("..") || normalized.starts_with('/') || normalized.ends_with('/') {
        return Err(ContractError::new(field, "is not a canonical identifier"));
    }
    Ok(normalized)
}

pub(crate) fn normalize_many<I, S>(
    values: I,
    field: &'static str,
    maximum_items: usize,
) -> ContractResult<std::collections::BTreeSet<String>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut normalized = std::collections::BTreeSet::new();
    for value in values {
        let value = normalize_id(value.as_ref(), field)?;
        if !normalized.insert(value) {
            return Err(ContractError::new(field, "contains a duplicate value"));
        }
        if normalized.len() > maximum_items {
            return Err(ContractError::new(field, "contains too many values"));
        }
    }
    Ok(normalized)
}

pub(crate) fn validate_hash(value: &str, field: &'static str) -> ContractResult<String> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ContractError::new(
            field,
            "must be a lowercase SHA-256 digest",
        ));
    }
    Ok(value.to_owned())
}

pub(crate) fn validate_version(version: u64, field: &'static str) -> ContractResult<u64> {
    if version == 0 {
        return Err(ContractError::new(field, "must be positive"));
    }
    Ok(version)
}

pub(crate) fn validate_locale(value: &str) -> ContractResult<String> {
    let normalized = normalize_text(value, "locale", 35)?;
    let mut parts = normalized.split('-');
    let Some(first) = parts.next() else {
        return Err(ContractError::new("locale", "is invalid"));
    };
    if !(2..=8).contains(&first.len()) || !first.bytes().all(|byte| byte.is_ascii_alphabetic()) {
        return Err(ContractError::new("locale", "is invalid"));
    }
    if parts.any(|part| {
        part.is_empty() || part.len() > 8 || !part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    }) {
        return Err(ContractError::new("locale", "is invalid"));
    }
    Ok(normalized)
}

pub(crate) fn validate_timezone(value: &str) -> ContractResult<String> {
    let normalized = normalize_text(value, "timezone", 128)?;
    if normalized == "system" || normalized == "UTC" {
        return Ok(normalized);
    }
    if normalized.starts_with('/')
        || normalized.ends_with('/')
        || normalized.contains("..")
        || normalized.contains("//")
        || !normalized.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '/' | '_' | '-' | '+')
        })
    {
        return Err(ContractError::new(
            "timezone",
            "is not a canonical time-zone name",
        ));
    }
    if !normalized.contains('/') {
        return Err(ContractError::new(
            "timezone",
            "must be UTC, system, or an IANA-style zone name",
        ));
    }
    Ok(normalized)
}
