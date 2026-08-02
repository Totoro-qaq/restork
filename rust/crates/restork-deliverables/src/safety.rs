use crate::{DeliverableError, Result};

pub(crate) const MAX_TEXT_BYTES: usize = 32 * 1024;

pub(crate) fn validate_id(field: &'static str, value: &str) -> Result<()> {
    if value.is_empty() {
        return Err(DeliverableError::EmptyField(field));
    }
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(DeliverableError::InvalidIdentifier {
            field,
            value: value.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_nonempty_text(field: &'static str, value: &str) -> Result<()> {
    if value.trim().is_empty() {
        return Err(DeliverableError::EmptyField(field));
    }
    if value.len() > MAX_TEXT_BYTES || value.chars().any(|character| character == '\0') {
        return Err(DeliverableError::InvalidIdentifier {
            field,
            value: "text exceeds the safe contract boundary".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_hash(field: &'static str, value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(DeliverableError::InvalidHash(field));
    }
    Ok(())
}

pub(crate) fn validate_language_tag(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 35
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(DeliverableError::InvalidIdentifier {
            field: "language",
            value: value.to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn validate_safe_relative_path(value: &str) -> Result<()> {
    if value.is_empty()
        || value.starts_with('/')
        || value.starts_with('\\')
        || value.contains('\0')
        || value.contains('\\')
        || value.contains("://")
        || value.contains('%')
        || value.contains('?')
        || value.contains('#')
    {
        return Err(DeliverableError::UnsafeLocalReference(value.to_owned()));
    }

    let mut parts = value.split('/');
    let first = parts
        .next()
        .ok_or_else(|| DeliverableError::UnsafeLocalReference(value.to_owned()))?;
    if first.contains(':') || first.is_empty() || matches!(first, "." | ".." | "~") {
        return Err(DeliverableError::UnsafeLocalReference(value.to_owned()));
    }
    if parts.any(|part| part.is_empty() || matches!(part, "." | "..")) {
        return Err(DeliverableError::UnsafeLocalReference(value.to_owned()));
    }
    Ok(())
}

pub(crate) fn markdown_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    let mut previous_space = false;
    for character in value.chars() {
        if character.is_control() || is_unsafe_format_control(character) {
            if matches!(character, '\n' | '\r' | '\t') && !previous_space {
                escaped.push(' ');
                previous_space = true;
            }
            continue;
        }

        if character.is_whitespace() {
            if !previous_space {
                escaped.push(' ');
                previous_space = true;
            }
            continue;
        }
        previous_space = false;

        if matches!(
            character,
            '\\' | '`'
                | '*'
                | '_'
                | '{'
                | '}'
                | '['
                | ']'
                | '('
                | ')'
                | '#'
                | '+'
                | '-'
                | '.'
                | '!'
                | '|'
                | '>'
                | '<'
                | '&'
        ) {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped.trim().to_owned()
}

fn is_unsafe_format_control(character: char) -> bool {
    matches!(
        character,
        '\u{200b}'..='\u{200f}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2060}'..='\u{206f}'
            | '\u{feff}'
    )
}
