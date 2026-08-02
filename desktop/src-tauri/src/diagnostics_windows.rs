use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const MAX_DIAGNOSTIC_BYTES: u64 = 1_000_000;

pub(crate) struct Diagnostics {
    path: PathBuf,
}

#[derive(Serialize)]
struct DiagnosticEvent {
    schema_version: u8,
    timestamp_unix_ms: u128,
    event: &'static str,
}

impl Diagnostics {
    pub(crate) fn create(app: &AppHandle) -> Result<Self, ()> {
        let directory = app.path().app_log_dir().map_err(|_| ())?;
        fs::create_dir_all(&directory).map_err(|_| ())?;
        let metadata = directory.symlink_metadata().map_err(|_| ())?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            return Err(());
        }
        let path = directory.join("desktop-events.jsonl");
        if let Ok(metadata) = path.symlink_metadata() {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                return Err(());
            }
            if metadata.len() > MAX_DIAGNOSTIC_BYTES {
                fs::remove_file(&path).map_err(|_| ())?;
            }
        }
        Ok(Self { path })
    }

    pub(crate) fn record(&self, event: &'static str) {
        let payload = DiagnosticEvent {
            schema_version: 1,
            timestamp_unix_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |duration| duration.as_millis()),
            event,
        };
        let Ok(mut line) = serde_json::to_vec(&payload) else {
            return;
        };
        line.push(b'\n');
        let Ok(mut file) = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
        else {
            return;
        };
        let _ = file.write_all(&line);
    }
}
