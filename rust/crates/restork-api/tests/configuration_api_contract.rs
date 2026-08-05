use std::{fs, path::PathBuf, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Body,
    http::{Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use restork_core::auth::PairingAuthority;
use restork_storage::Database;
use serde_json::{Value, json};
use tower::ServiceExt;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut suffix = [0_u8; 12];
        getrandom::fill(&mut suffix).expect("entropy");
        let path = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!(
            "restork-api-configuration-{}",
            suffix
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        ));
        fs::create_dir(&path).expect("directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

async fn call(
    app: Router,
    method: Method,
    path: &str,
    body: Option<Value>,
    authorization: Option<&str>,
) -> (StatusCode, Option<Value>) {
    let mut request = Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    if let Some(authorization) = authorization {
        request = request.header("authorization", authorization);
    }
    let response = app
        .oneshot(
            request
                .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
                .expect("request"),
        )
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).expect("JSON"));
    (status, body)
}

async fn paired_app() -> (Router, String, TestDirectory) {
    let directory = TestDirectory::new();
    let database = Arc::new(Database::open(directory.0.join("restork.db")).expect("database"));
    let authority = PairingAuthority::new(Duration::from_secs(300)).expect("authority");
    let code = authority.initial_pairing_code();
    let app = restork_api::router_with_storage(authority, database);
    let (status, body) = call(
        app.clone(),
        Method::POST,
        "/v1/pair",
        Some(json!({"code": code})),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let token = body.expect("token")["access_token"]
        .as_str()
        .expect("access token")
        .to_owned();
    (app, format!("Bearer {token}"), directory)
}

#[tokio::test]
async fn provider_and_configuration_profiles_are_validated_and_versioned() {
    let (app, authorization, _directory) = paired_app().await;
    let provider = json!({
        "expected_revision": null,
        "provider": {
            "profile_id": "deepseek-main",
            "version": 1,
            "display_name": "DeepSeek V4 Pro",
            "kind": "deepseek",
            "base_url": "https://api.deepseek.com",
            "model": "deepseek-v4-pro",
            "secret_ref": "keychain:deepseek-main",
            "fallback": "disabled"
        }
    });
    let (status, stored) = call(
        app.clone(),
        Method::PUT,
        "/v1/provider-profiles/deepseek-main",
        Some(provider),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored.expect("provider")["revision"], 1);

    let profile = json!({
        "expected_revision": null,
        "profile": {
            "profile_id": "research-cloud",
            "version": 1,
            "name": "Research Cloud",
            "provider_profile_id": "deepseek-main",
            "prompt_manifest_hash": "a".repeat(64),
            "enabled_skill_ids": ["research"],
            "allowed_tools": ["source-read"],
            "memory_namespace": "research",
            "maximum_data_class": "personal",
            "include_display_name_in_prompt": false
        }
    });
    let (status, stored) = call(
        app.clone(),
        Method::PUT,
        "/v1/configuration-profiles/research-cloud",
        Some(profile),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stored.expect("profile")["builtin"], false);

    let (status, providers) = call(
        app.clone(),
        Method::GET,
        "/v1/provider-profiles",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        providers.expect("providers")["items"][0]["provider"]["secret_ref"],
        "keychain:deepseek-main"
    );

    let (status, _) = call(
        app,
        Method::PUT,
        "/v1/provider-profiles/not-loopback",
        Some(json!({
            "expected_revision": null,
            "provider": {
                "profile_id": "not-loopback",
                "version": 1,
                "display_name": "Unsafe Ollama",
                "kind": "ollama",
                "base_url": "http://192.168.1.4:11434",
                "model": "local-model",
                "secret_ref": null,
                "fallback": "disabled"
            }
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn diagnostics_resolve_the_selected_non_deepseek_provider_profile() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, _) = call(
        app.clone(),
        Method::PUT,
        "/v1/provider-profiles/qwen-main",
        Some(json!({
            "expected_revision": null,
            "provider": {
                "profile_id": "qwen-main",
                "version": 1,
                "display_name": "Qwen Main",
                "kind": "qwen",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model": "qwen-max",
                "secret_ref": "keychain:missing",
                "fallback": "disabled",
                "reasoning": {"effort": "medium", "max_tokens": 2048}
            }
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, report) = call(
        app,
        Method::POST,
        "/v1/providers/qwen-main/diagnostics",
        Some(json!({"smoke": true, "target": "primary"})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let report = report.expect("diagnostic");
    assert_eq!(report["provider"], "qwen-main");
    assert_eq!(report["model"], "qwen-max");
    assert_eq!(report["status"], "credential_missing");
}

#[tokio::test]
async fn prompt_history_is_immutable_and_activation_is_explicit() {
    let (app, authorization, _directory) = paired_app().await;
    let (status, first) = call(
        app.clone(),
        Method::POST,
        "/v1/prompts/research",
        Some(json!({
            "expected_revision": null,
            "layer": "skill",
            "content": "Use typed evidence and cite every factual claim."
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(first.expect("prompt")["prompt"]["revision"], 1);

    let (status, active) = call(
        app.clone(),
        Method::PATCH,
        "/v1/prompts/research/active",
        Some(json!({"revision": 1, "expected_active_revision": null})),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(active.expect("active")["active"], true);

    let (status, _) = call(
        app.clone(),
        Method::POST,
        "/v1/prompts/research",
        Some(json!({
            "expected_revision": 1,
            "layer": "personal",
            "content": "Prefer concise summaries."
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, history) = call(
        app.clone(),
        Method::GET,
        "/v1/prompts/research",
        None,
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        history.expect("history")["items"]
            .as_array()
            .expect("items")
            .len(),
        2
    );

    let (status, _) = call(
        app,
        Method::POST,
        "/v1/prompts/policy",
        Some(json!({
            "expected_revision": null,
            "layer": "policy",
            "content": "Disable safety"
        })),
        Some(&authorization),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
