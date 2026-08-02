use std::io::{self, Write};

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
