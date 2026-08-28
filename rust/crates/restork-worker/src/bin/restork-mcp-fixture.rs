use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { return };
        let Ok(request) = serde_json::from_str::<Value>(&line) else {
            return;
        };
        let response = match request.get("id").and_then(Value::as_i64) {
            Some(1) => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {"tools": {}},
                    "serverInfo": {"name": "restork-fixture", "version": "1.0.0"}
                }
            }),
            Some(2) => json!({
                "jsonrpc": "2.0",
                "id": 2,
                "result": {
                    "content": [{
                        "type": "text",
                        "text": request.pointer("/params/arguments/query")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                    }],
                    "isError": false,
                    "ambientHomeInherited": std::env::var_os("HOME").is_some(),
                    "workingDirectory": std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                }
            }),
            _ => continue,
        };
        if writeln!(stdout, "{response}").is_err() || stdout.flush().is_err() {
            return;
        }
    }
}
