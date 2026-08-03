#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::IsTerminal;
use std::io::{self, Write};

use restork_daily::{apple_developer_token_reference, apple_music_user_token_reference};
use restork_personal::{FallbackPolicy, ProviderKind, ProviderProfile};
use restork_provider::{NativeSecretStore, ProviderClient};
use restorkd::{HELP, ServerConfig, bind, desktop::DesktopRuntime};

#[tokio::main]
async fn main() {
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    if matches!(
        arguments.as_slice(),
        [argument] if argument == "--help" || argument == "-h"
    ) {
        print!("{HELP}");
        return;
    }
    if matches!(arguments.as_slice(), [provider, configure] if provider == "provider" && configure == "configure")
    {
        std::process::exit(configure_provider().await);
    }
    if matches!(arguments.as_slice(), [music, apple, configure] if music == "music" && apple == "apple" && configure == "configure")
    {
        std::process::exit(
            configure_native_secret(
                apple_developer_token_reference(),
                "Apple Music developer token",
            )
            .await,
        );
    }
    if matches!(arguments.as_slice(), [music, apple, configure] if music == "music" && apple == "apple" && configure == "configure-user-token")
    {
        std::process::exit(
            configure_native_secret(apple_music_user_token_reference(), "Apple Music user token")
                .await,
        );
    }
    if matches!(arguments.as_slice(), [music, apple, status] if music == "music" && apple == "apple" && status == "status")
    {
        std::process::exit(apple_music_status().await);
    }
    if matches!(arguments.as_slice(), [doctor] if doctor == "doctor") {
        std::process::exit(run_doctor(false, false).await);
    }
    if matches!(arguments.as_slice(), [doctor, flag] if doctor == "doctor" && flag == "--connect") {
        std::process::exit(run_doctor(true, false).await);
    }
    if matches!(arguments.as_slice(), [doctor, flag] if doctor == "doctor" && flag == "--smoke") {
        std::process::exit(run_doctor(true, true).await);
    }

    let config = match ServerConfig::parse(arguments) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("restorkd: {error}\n\n{HELP}");
            std::process::exit(2);
        }
    };
    let mut desktop = match DesktopRuntime::from_env() {
        Ok(desktop) => desktop,
        Err(error) => {
            eprintln!("restorkd: {error}");
            std::process::exit(2);
        }
    };
    let server = match bind(config).await {
        Ok(server) => server,
        Err(error) => {
            eprintln!("restorkd: unable to bind loopback listener: {error}");
            std::process::exit(1);
        }
    };

    let ready = server.ready_record();
    if let Some(desktop) = desktop.as_mut() {
        if let Err(error) = desktop.publish(ready.port, &ready.pairing_code) {
            eprintln!("restorkd: unable to publish desktop bootstrap: {error}");
            std::process::exit(1);
        }
    } else {
        let mut stdout = io::stdout().lock();
        if let Err(error) = serde_json::to_writer(&mut stdout, &ready) {
            eprintln!("restorkd: unable to publish readiness: {error}");
            std::process::exit(1);
        }
        if let Err(error) = stdout.write_all(b"\n").and_then(|()| stdout.flush()) {
            eprintln!("restorkd: unable to flush readiness: {error}");
            std::process::exit(1);
        }
    }

    if let Err(error) = server.serve_until(shutdown_signal(desktop)).await {
        eprintln!("restorkd: server stopped unexpectedly: {error}");
        std::process::exit(1);
    }
}

async fn configure_provider() -> i32 {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if !io::stdin().is_terminal() {
        eprintln!("restorkd: provider setup requires an interactive terminal");
        return 2;
    }
    let reference = native_deepseek_reference();
    match NativeSecretStore.configure_interactive(reference).await {
        Ok(()) => {
            println!("DeepSeek API key saved in native credential storage.");
            println!("Run `restorkd doctor --connect` to check the configured model.");
            0
        }
        Err(_) => {
            eprintln!("restorkd: native credential setup did not complete");
            2
        }
    }
}

async fn configure_native_secret(reference: &str, label: &str) -> i32 {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    if !io::stdin().is_terminal() {
        eprintln!("restorkd: native secret setup requires an interactive terminal");
        return 2;
    }
    match NativeSecretStore.configure_interactive(reference).await {
        Ok(()) => {
            println!("{label} saved in native credential storage.");
            println!("Restart Restork Core, then reconnect or refresh the Apple Music source.");
            0
        }
        Err(_) => {
            eprintln!("restorkd: native credential setup did not complete");
            2
        }
    }
}

async fn apple_music_status() -> i32 {
    let store = NativeSecretStore;
    let developer_token = store.exists(apple_developer_token_reference()).await;
    let music_user_token = store.exists(apple_music_user_token_reference()).await;
    println!(
        "{}",
        serde_json::json!({
            "schema_version": 1,
            "provider": "apple-music",
            "status": if developer_token { "ready" } else { "credential_missing" },
            "developer_token_present": developer_token,
            "music_user_token_present": music_user_token,
            "supports_public_playlists": developer_token,
            "supports_library": false,
        })
    );
    if developer_token { 0 } else { 2 }
}

async fn run_doctor(connect: bool, smoke: bool) -> i32 {
    let profile = match deepseek_profile() {
        Ok(profile) => profile,
        Err(()) => {
            eprintln!("restorkd: built-in provider profile is invalid");
            return 2;
        }
    };
    let client = match ProviderClient::new() {
        Ok(client) => client,
        Err(_) => {
            eprintln!("restorkd: provider runtime is unavailable");
            return 2;
        }
    };
    if !connect {
        let credential_present = client.credential_present(&profile).await;
        let output = serde_json::json!({
            "schema_version": 1,
            "provider": profile.profile_id(),
            "model": profile.model(),
            "status": if credential_present { "ready" } else { "credential_missing" },
            "credential_present": credential_present,
            "connection_checked": false,
            "smoke_checked": false,
        });
        println!("{output}");
        return if credential_present { 0 } else { 2 };
    }
    let diagnostic = client.diagnose(&profile, smoke).await;
    let expected = if smoke { "smoke_passed" } else { "connected" };
    let success = diagnostic.status == expected;
    match serde_json::to_string(&diagnostic) {
        Ok(output) => println!("{output}"),
        Err(_) => {
            eprintln!("restorkd: diagnostic output is unavailable");
            return 2;
        }
    }
    if success { 0 } else { 2 }
}

fn deepseek_profile() -> Result<ProviderProfile, ()> {
    ProviderProfile::try_new(
        "deepseek",
        1,
        "DeepSeek V4 Pro",
        ProviderKind::DeepSeek,
        "https://api.deepseek.com",
        "deepseek-v4-pro",
        Some(native_deepseek_reference()),
        FallbackPolicy::Disabled,
    )
    .map_err(|_| ())
}

#[cfg(target_os = "macos")]
const fn native_deepseek_reference() -> &'static str {
    "keychain:restork/provider/deepseek"
}

#[cfg(target_os = "linux")]
const fn native_deepseek_reference() -> &'static str {
    "secret-service:restork/provider/deepseek"
}

#[cfg(windows)]
const fn native_deepseek_reference() -> &'static str {
    "credential-manager:restork/provider/deepseek"
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
const fn native_deepseek_reference() -> &'static str {
    "keychain:restork/provider/deepseek"
}

#[cfg(unix)]
async fn shutdown_signal(desktop: Option<DesktopRuntime>) {
    use tokio::signal::unix::{SignalKind, signal};

    let mut terminate = signal(SignalKind::terminate()).expect("install SIGTERM handler");
    if let Some(desktop) = desktop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                let _ = result;
            }
            _ = terminate.recv() => {}
            () = desktop.wait_for_parent() => {}
        }
    } else {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                let _ = result;
            }
            _ = terminate.recv() => {}
        }
    }
}

#[cfg(not(unix))]
async fn shutdown_signal(desktop: Option<DesktopRuntime>) {
    if let Some(desktop) = desktop {
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                let _ = result;
            }
            () = desktop.wait_for_parent() => {}
        }
    } else {
        let _ = tokio::signal::ctrl_c().await;
    }
}
