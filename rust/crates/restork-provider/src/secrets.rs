use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SecretError {
    InvalidReference,
    UnsupportedStore,
    Unavailable,
    Empty,
}

pub struct ResolvedSecret(Zeroizing<String>);

impl ResolvedSecret {
    pub(crate) fn new(value: String) -> Result<Self, SecretError> {
        if value.is_empty() || value.len() > 16_384 || value.contains(['\0', '\n', '\r']) {
            return Err(SecretError::Empty);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    /// Borrow the zeroizing value for an outbound authenticated request.
    ///
    /// Callers must not serialize, log, clone, or persist this value.
    pub fn expose(&self) -> &str {
        self.0.as_str()
    }

    /// Transfer ownership into another zeroizing native-runtime boundary.
    ///
    /// This is used for short-lived MCP process environments; the value still
    /// cannot be cloned, serialized, logged, or persisted by the caller.
    pub fn into_zeroizing(self) -> Zeroizing<String> {
        self.0
    }
}

pub struct NativeSecretStore;

impl NativeSecretStore {
    pub async fn resolve(&self, reference: &str) -> Result<ResolvedSecret, SecretError> {
        resolve_native(reference).await
    }

    pub async fn exists(&self, reference: &str) -> bool {
        exists_native(reference).await
    }

    /// Ask the operating system's native secret UI/CLI to create or replace a secret.
    ///
    /// The secret is never accepted as a command-line argument. On macOS and Linux
    /// the platform tool owns the prompt; Windows uses Credential UI and writes the
    /// resulting bounded value directly to Credential Manager.
    pub async fn configure_interactive(&self, reference: &str) -> Result<(), SecretError> {
        configure_native(reference).await
    }
}

fn reference_parts<'a>(
    reference: &'a str,
    prefix: &str,
) -> Result<(&'a str, &'a str), SecretError> {
    let identifier = reference
        .strip_prefix(prefix)
        .ok_or(SecretError::UnsupportedStore)?;
    let (service, account) = identifier
        .rsplit_once('/')
        .ok_or(SecretError::InvalidReference)?;
    if service.is_empty()
        || account.is_empty()
        || !identifier.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return Err(SecretError::InvalidReference);
    }
    Ok((service, account))
}

#[cfg(target_os = "macos")]
async fn resolve_native(reference: &str) -> Result<ResolvedSecret, SecretError> {
    let (service, account) = reference_parts(reference, "keychain:")?;
    let output = tokio::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-w", "-s", service, "-a", account])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| SecretError::Unavailable)?;
    if !output.status.success() || !output.stderr.is_empty() && output.stdout.is_empty() {
        return Err(SecretError::Unavailable);
    }
    let secret = String::from_utf8(output.stdout).map_err(|_| SecretError::Unavailable)?;
    ResolvedSecret::new(secret.trim_end_matches(['\r', '\n']).to_owned())
}

#[cfg(target_os = "macos")]
async fn exists_native(reference: &str) -> bool {
    use std::process::Stdio;

    let Ok((service, account)) = reference_parts(reference, "keychain:") else {
        return false;
    };
    tokio::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", account])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .is_ok_and(|status| status.success())
}

#[cfg(target_os = "macos")]
async fn configure_native(reference: &str) -> Result<(), SecretError> {
    let (service, account) = reference_parts(reference, "keychain:")?;
    let status = tokio::process::Command::new("/usr/bin/security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            service,
            "-w",
        ])
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|_| SecretError::Unavailable)?;
    status
        .success()
        .then_some(())
        .ok_or(SecretError::Unavailable)
}

#[cfg(target_os = "linux")]
async fn resolve_native(reference: &str) -> Result<ResolvedSecret, SecretError> {
    let (service, account) = reference_parts(reference, "secret-service:")?;
    let output = tokio::process::Command::new("/usr/bin/secret-tool")
        .args(["lookup", "service", service, "account", account])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|_| SecretError::Unavailable)?;
    if !output.status.success() {
        return Err(SecretError::Unavailable);
    }
    let secret = String::from_utf8(output.stdout).map_err(|_| SecretError::Unavailable)?;
    ResolvedSecret::new(secret.trim_end_matches(['\r', '\n']).to_owned())
}

#[cfg(target_os = "linux")]
async fn exists_native(reference: &str) -> bool {
    resolve_native(reference).await.is_ok()
}

#[cfg(target_os = "linux")]
async fn configure_native(reference: &str) -> Result<(), SecretError> {
    let (service, account) = reference_parts(reference, "secret-service:")?;
    let status = tokio::process::Command::new("/usr/bin/secret-tool")
        .args([
            "store",
            "--label=Restork native secret",
            "service",
            service,
            "account",
            account,
        ])
        .kill_on_drop(true)
        .status()
        .await
        .map_err(|_| SecretError::Unavailable)?;
    status
        .success()
        .then_some(())
        .ok_or(SecretError::Unavailable)
}

#[cfg(windows)]
async fn resolve_native(reference: &str) -> Result<ResolvedSecret, SecretError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Security::Credentials::{
        CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW,
    };

    let identifier = reference
        .strip_prefix("credential-manager:")
        .ok_or(SecretError::UnsupportedStore)?;
    if identifier.is_empty()
        || !identifier.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return Err(SecretError::InvalidReference);
    }
    let mut target = std::ffi::OsStr::new(identifier)
        .encode_wide()
        .collect::<Vec<_>>();
    target.push(0);
    let mut credential = std::ptr::null_mut::<CREDENTIALW>();
    // SAFETY: target is NUL terminated and the output pointer is valid for CredReadW.
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) } == 0
        || credential.is_null()
    {
        return Err(SecretError::Unavailable);
    }
    // SAFETY: the successful CredReadW result owns a credential blob until CredFree.
    let bytes = unsafe {
        std::slice::from_raw_parts(
            (*credential).CredentialBlob,
            (*credential).CredentialBlobSize as usize,
        )
        .to_vec()
    };
    // SAFETY: CredReadW allocated this exact pointer.
    unsafe { CredFree(credential.cast()) };
    let secret = String::from_utf8(bytes).map_err(|_| SecretError::Unavailable)?;
    ResolvedSecret::new(secret)
}

#[cfg(windows)]
async fn exists_native(reference: &str) -> bool {
    resolve_native(reference).await.is_ok()
}

#[cfg(windows)]
async fn configure_native(reference: &str) -> Result<(), SecretError> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Security::Credentials::{
        CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC, CREDENTIALW, CREDUI_FLAGS_DO_NOT_PERSIST,
        CREDUI_FLAGS_EXCLUDE_CERTIFICATES, CREDUI_FLAGS_GENERIC_CREDENTIALS,
        CREDUI_FLAGS_KEEP_USERNAME, CREDUI_FLAGS_PASSWORD_ONLY_OK,
        CredUICmdLinePromptForCredentialsW, CredWriteW,
    };
    use zeroize::Zeroize;

    let identifier = reference
        .strip_prefix("credential-manager:")
        .ok_or(SecretError::UnsupportedStore)?;
    if identifier.is_empty()
        || !identifier.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return Err(SecretError::InvalidReference);
    }
    let mut target = std::ffi::OsStr::new(identifier)
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let mut username = "restork\0".encode_utf16().collect::<Vec<_>>();
    username.resize(256, 0);
    let mut password = vec![0_u16; 16_385];
    let mut save = 0;
    let flags = CREDUI_FLAGS_GENERIC_CREDENTIALS
        | CREDUI_FLAGS_KEEP_USERNAME
        | CREDUI_FLAGS_PASSWORD_ONLY_OK
        | CREDUI_FLAGS_EXCLUDE_CERTIFICATES
        | CREDUI_FLAGS_DO_NOT_PERSIST;
    // SAFETY: all buffers are writable, NUL-terminated, and their exact capacities
    // are passed to the native Credential UI function.
    let result = unsafe {
        CredUICmdLinePromptForCredentialsW(
            target.as_ptr(),
            std::ptr::null(),
            0,
            username.as_mut_ptr(),
            u32::try_from(username.len()).map_err(|_| SecretError::Unavailable)?,
            password.as_mut_ptr(),
            u32::try_from(password.len()).map_err(|_| SecretError::Unavailable)?,
            &mut save,
            flags,
        )
    };
    if result != 0 {
        password.zeroize();
        return Err(SecretError::Unavailable);
    }
    let length = password.iter().position(|value| *value == 0).unwrap_or(0);
    let mut secret = String::from_utf16(&password[..length]).map_err(|_| {
        password.zeroize();
        SecretError::Unavailable
    })?;
    password.zeroize();
    if secret.is_empty() || secret.len() > 16_384 || secret.contains(['\0', '\n', '\r']) {
        secret.zeroize();
        return Err(SecretError::Empty);
    }
    let mut blob = secret.as_bytes().to_vec();
    secret.zeroize();
    let mut credential = CREDENTIALW {
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_mut_ptr(),
        CredentialBlobSize: u32::try_from(blob.len()).map_err(|_| SecretError::Unavailable)?,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        UserName: username.as_mut_ptr(),
        ..CREDENTIALW::default()
    };
    // SAFETY: every pointer in `credential` refers to a live buffer for this call.
    let written = unsafe { CredWriteW(&mut credential, 0) } != 0;
    blob.zeroize();
    username.zeroize();
    target.zeroize();
    written.then_some(()).ok_or(SecretError::Unavailable)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn resolve_native(_reference: &str) -> Result<ResolvedSecret, SecretError> {
    Err(SecretError::UnsupportedStore)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn exists_native(_reference: &str) -> bool {
    false
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn configure_native(_reference: &str) -> Result<(), SecretError> {
    Err(SecretError::UnsupportedStore)
}

#[cfg(test)]
mod tests {
    use super::{SecretError, reference_parts};

    #[test]
    fn references_are_split_without_accepting_shell_text() {
        assert_eq!(
            reference_parts("keychain:restork/provider/deepseek", "keychain:"),
            Ok(("restork/provider", "deepseek"))
        );
        assert_eq!(
            reference_parts("keychain:restork/provider;rm/deepseek", "keychain:"),
            Err(SecretError::InvalidReference)
        );
    }
}
