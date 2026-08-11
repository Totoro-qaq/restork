use light_file_dialog::dialog::{Dialog, InputBox};
use zeroize::Zeroizing;

pub(crate) enum SecretPromptResult {
    Cancelled,
    Saved { secret_ref: String },
}

pub(crate) fn configure_provider_secret(
    provider_kind: &str,
) -> Result<SecretPromptResult, &'static str> {
    let reference = provider_secret_reference(provider_kind)?;
    let Some(raw) = InputBox::new(
        "Restork · API Key",
        "Enter the API Key for this provider. It will be saved only in your system credential store.\n输入该供应商的 API Key；它只会保存在系统凭据库中。",
    )
    .password()
    .show()
    else {
        return Ok(SecretPromptResult::Cancelled);
    };
    // The native dialog owns its own platform buffer. Zeroize the Rust copy as
    // soon as it crosses into our process, before validation or persistence.
    let raw = Zeroizing::new(raw);
    let secret = validate_secret_value(raw.as_str())?;
    store_native_secret(&reference, &secret)?;
    Ok(SecretPromptResult::Saved {
        secret_ref: reference,
    })
}

pub(crate) fn provider_secret_reference(provider_kind: &str) -> Result<String, &'static str> {
    if !matches!(
        provider_kind,
        "deepseek"
            | "openai"
            | "anthropic"
            | "minimax"
            | "mimo"
            | "glm"
            | "kimi"
            | "qwen"
            | "openrouter"
            | "open_ai_compatible"
    ) {
        return Err("native_secret_provider_invalid");
    }
    #[cfg(target_os = "macos")]
    let prefix = "keychain:";
    #[cfg(target_os = "linux")]
    let prefix = "secret-service:";
    #[cfg(windows)]
    let prefix = "credential-manager:";
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    let prefix = "unsupported:";
    Ok(format!("{prefix}restork/provider/{provider_kind}"))
}

pub(crate) fn validate_secret_value(raw: &str) -> Result<Zeroizing<String>, &'static str> {
    if raw.is_empty() {
        return Err("native_secret_empty");
    }
    if raw.len() > 16_384 {
        return Err("native_secret_too_large");
    }
    if raw.contains(['\0', '\n', '\r']) {
        return Err("native_secret_invalid");
    }
    Ok(Zeroizing::new(raw.to_owned()))
}

#[cfg(target_os = "macos")]
fn store_native_secret(reference: &str, secret: &Zeroizing<String>) -> Result<(), &'static str> {
    let (service, account) = reference_parts(reference, "keychain:")?;
    security_framework::passwords::set_generic_password(service, account, secret.as_bytes())
        .map_err(|_| "native_secret_store_unavailable")
}

#[cfg(target_os = "linux")]
fn store_native_secret(reference: &str, secret: &Zeroizing<String>) -> Result<(), &'static str> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let (service, account) = reference_parts(reference, "secret-service:")?;
    let mut child = Command::new("secret-tool")
        .args([
            "store",
            "--label=Restork native secret",
            "service",
            service,
            "account",
            account,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "native_secret_store_unavailable")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("native_secret_store_unavailable")?;
    stdin
        .write_all(secret.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .map_err(|_| "native_secret_store_unavailable")?;
    drop(stdin);
    child
        .wait()
        .map_err(|_| "native_secret_store_unavailable")?
        .success()
        .then_some(())
        .ok_or("native_secret_store_unavailable")
}

#[cfg(windows)]
fn store_native_secret(reference: &str, secret: &Zeroizing<String>) -> Result<(), &'static str> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CredWriteW,
    };
    use zeroize::Zeroize;

    let identifier = reference
        .strip_prefix("credential-manager:")
        .ok_or("native_secret_reference_invalid")?;
    let mut target = std::ffi::OsStr::new(identifier)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut username = "restork\0".encode_utf16().collect::<Vec<_>>();
    let mut blob = secret.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: u32::try_from(blob.len())
            .map_err(|_| "native_secret_store_unavailable")?,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..CREDENTIALW::default()
    };
    // SAFETY: every pointer in the credential refers to a live, bounded buffer.
    let written = unsafe { CredWriteW(&credential, 0) } != 0;
    blob.zeroize();
    username.zeroize();
    target.zeroize();
    written
        .then_some(())
        .ok_or("native_secret_store_unavailable")
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn store_native_secret(_reference: &str, _secret: &Zeroizing<String>) -> Result<(), &'static str> {
    Err("native_secret_store_unsupported")
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn reference_parts<'a>(
    reference: &'a str,
    prefix: &str,
) -> Result<(&'a str, &'a str), &'static str> {
    let identifier = reference
        .strip_prefix(prefix)
        .ok_or("native_secret_reference_invalid")?;
    let (service, account) = identifier
        .rsplit_once('/')
        .ok_or("native_secret_reference_invalid")?;
    if service.is_empty()
        || account.is_empty()
        || !identifier.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return Err("native_secret_reference_invalid");
    }
    Ok((service, account))
}

#[cfg(test)]
mod tests {
    use super::{provider_secret_reference, validate_secret_value};

    #[test]
    fn provider_references_are_fixed_and_unknown_kinds_are_rejected() {
        let reference = provider_secret_reference("deepseek").expect("known provider");
        assert!(reference.ends_with("restork/provider/deepseek"));
        for provider in ["openai", "anthropic", "minimax", "mimo"] {
            let reference = provider_secret_reference(provider).expect("known provider");
            assert!(reference.ends_with(&format!("restork/provider/{provider}")));
        }
        assert!(provider_secret_reference("ollama").is_err());
        assert!(provider_secret_reference("deepseek;rm").is_err());
    }

    #[test]
    fn native_secret_values_are_bounded_before_storage() {
        assert!(validate_secret_value("sk-valid").is_ok());
        assert_eq!(validate_secret_value(""), Err("native_secret_empty"));
        assert_eq!(
            validate_secret_value("line\nbreak"),
            Err("native_secret_invalid")
        );
        assert_eq!(
            validate_secret_value(&"x".repeat(16_385)),
            Err("native_secret_too_large"),
        );
    }
}
