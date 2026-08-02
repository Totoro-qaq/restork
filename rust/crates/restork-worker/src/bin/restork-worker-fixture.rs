use std::io::{Read, Write};

use restork_worker::{WorkerArtifact, WorkerRequest, WorkerResponse, json_hash};
use serde_json::json;

fn main() {
    let mut header = [0_u8; 4];
    if std::io::stdin().read_exact(&mut header).is_err() {
        std::process::exit(2);
    }
    let length = u32::from_be_bytes(header) as usize;
    let mut body = vec![0_u8; length];
    if std::io::stdin().read_exact(&mut body).is_err() {
        std::process::exit(2);
    }
    let request: WorkerRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => std::process::exit(2),
    };
    let behavior = request.input["behavior"].as_str().unwrap_or("echo");
    match behavior {
        "crash" => std::process::exit(7),
        "sleep" => std::thread::sleep(std::time::Duration::from_secs(10)),
        "malformed" => {
            let _ = std::io::stdout().write_all(&3_u32.to_be_bytes());
            let _ = std::io::stdout().write_all(b"bad");
            return;
        }
        "oversized" => {
            let _ = std::io::stdout().write_all(&u32::MAX.to_be_bytes());
            return;
        }
        _ => {}
    }
    let payload = json!({
        "echo": request.input,
        "home_inherited": std::env::var_os("HOME").is_some(),
        "database_inherited": std::env::var_os("RESTORK_DATABASE").is_some(),
    });
    let response = WorkerResponse {
        protocol_version: 1,
        request_id: request.request_id,
        status: "ok".to_owned(),
        artifact: Some(WorkerArtifact {
            kind: "synthetic".to_owned(),
            content_hash: json_hash(&payload),
            payload,
        }),
        error_code: None,
    };
    let body = serde_json::to_vec(&response).expect("fixture response");
    let mut stdout = std::io::stdout().lock();
    stdout
        .write_all(&(body.len() as u32).to_be_bytes())
        .expect("response header");
    stdout.write_all(&body).expect("response body");
    stdout.flush().expect("response flush");
}
