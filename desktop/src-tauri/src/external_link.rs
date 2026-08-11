//! Validated external links opened by the native desktop shell.

use super::*;

#[tauri::command]
pub(super) fn desktop_open_external(
    window: WebviewWindow,
    state: State<'_, DesktopState>,
    url: String,
) -> Result<(), String> {
    let external = validated_external_url(&url)?;
    let inner = state
        .inner
        .lock()
        .map_err(|_| "desktop_state_unavailable")?;
    commands::require_dashboard_window(&window, inner.origin.as_deref())?;
    inner.record("external_link_opened");
    drop(inner);
    launch_external_url(external.as_str()).map_err(|_| "external_link_unavailable".to_owned())
}

fn validated_external_url(value: &str) -> Result<tauri::Url, String> {
    if value.is_empty() || value.len() > 2_048 {
        return Err("external_link_invalid".to_owned());
    }
    let parsed = tauri::Url::parse(value).map_err(|_| "external_link_invalid".to_owned())?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("external_link_invalid".to_owned());
    }
    Ok(parsed)
}

fn launch_external_url(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open")
            .arg("--")
            .arg(url)
            .spawn()?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(url)
            .spawn()?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if std::process::Command::new("xdg-open")
            .arg(url)
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
        std::process::Command::new("gio")
            .arg("open")
            .arg(url)
            .spawn()?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "external links are unavailable on this platform",
    ))
}

#[cfg(test)]
mod tests {
    use super::validated_external_url;

    #[test]
    fn accepts_only_public_https_urls_without_credentials() {
        assert!(validated_external_url("https://github.com/Totoro-qaq/restork").is_ok());
        for value in [
            "http://github.com/Totoro-qaq/restork",
            "http://127.0.0.1:49152/v1/health",
            "https://user:secret@example.com/private",
            "file:///tmp/private",
            "javascript:alert(1)",
            "not-a-url",
        ] {
            assert_eq!(
                validated_external_url(value).unwrap_err(),
                "external_link_invalid"
            );
        }
    }
}
