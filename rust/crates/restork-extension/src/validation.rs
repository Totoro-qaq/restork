use url::Url;

use crate::ExtensionError;

pub(crate) fn validate_identifier(value: &str) -> Result<(), ExtensionError> {
    let valid = (1..=160).contains(&value.len())
        && value.is_ascii()
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'-' | b'_' | b'.' | b':' | b'/')
        })
        && !value.contains("..")
        && !value.contains("//");
    if valid {
        Ok(())
    } else {
        Err(ExtensionError::InvalidIdentifier(value.to_owned()))
    }
}

pub(crate) fn version_tuple(value: &str, allow_v_prefix: bool) -> Option<(u64, u64, u64)> {
    let selected = if allow_v_prefix {
        value.strip_prefix('v').unwrap_or(value)
    } else {
        value
    };
    let core = selected
        .split_once(['-', '+'])
        .map_or(selected, |(core, _)| core);
    let mut parts = core.split('.');
    let tuple = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    if parts.next().is_some()
        || selected.is_empty()
        || selected.len() > 96
        || !selected
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return None;
    }
    Some(tuple)
}

pub(crate) fn validate_version(value: &str) -> Result<(), ExtensionError> {
    version_tuple(value, false)
        .map(|_| ())
        .ok_or_else(|| ExtensionError::InvalidVersion(value.to_owned()))
}

pub(crate) fn validate_https_endpoint(value: &str) -> Result<Url, ExtensionError> {
    let parsed = Url::parse(value).map_err(|_| ExtensionError::InvalidRemoteEndpoint)?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(ExtensionError::InvalidRemoteEndpoint);
    }
    Ok(parsed)
}

pub(crate) fn is_absolute_executable(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'/' | b'\\'))
}

pub(crate) fn contains_interpolation(value: &str) -> bool {
    value.contains('$')
        || value.contains('`')
        || value.contains("{{")
        || value.contains("}}")
        || value.contains('\0')
        || value.contains('\n')
        || value.contains('\r')
        || percent_interpolation(value)
}

fn percent_interpolation(value: &str) -> bool {
    let Some(start) = value.find('%') else {
        return false;
    };
    value[start + 1..].find('%').is_some()
}

pub(crate) fn validate_plain_text(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty() && value.len() <= maximum && !value.chars().any(char::is_control)
}
