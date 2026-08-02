use restork_storage::Database;
use serde_json::json;

struct TestDirectory(tempfile::TempDir);

impl TestDirectory {
    fn new() -> Self {
        Self(tempfile::tempdir().expect("temporary directory"))
    }
}

#[test]
fn provider_and_configuration_profiles_use_optimistic_revisions() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let provider = json!({
        "profile_id": "deepseek-main",
        "version": 1,
        "display_name": "DeepSeek",
        "kind": "deepseek",
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-pro",
        "secret_ref": "keychain:deepseek-main",
        "fallback": "disabled"
    });
    let stored = database
        .put_provider_profile("deepseek-main", &provider, None, "2026-08-02T08:00:00Z")
        .expect("create provider");
    assert_eq!(stored.revision, 1);
    assert!(
        database
            .put_provider_profile("deepseek-main", &provider, Some(0), "2026-08-02T08:01:00Z",)
            .is_err()
    );

    let profile = json!({"profile_id": "safe-mode", "version": 1});
    database
        .put_configuration_profile("safe-mode", &profile, None, true, "2026-08-02T08:02:00Z")
        .expect("create profile");
    assert!(
        database
            .put_configuration_profile(
                "safe-mode",
                &profile,
                Some(1),
                false,
                "2026-08-02T08:03:00Z",
            )
            .is_err()
    );
    assert_eq!(database.provider_profiles().expect("providers").len(), 1);
    assert!(
        database
            .configuration_profiles()
            .expect("configuration profiles")[0]
            .builtin
    );
}

#[test]
fn prompt_revisions_are_immutable_and_activation_can_roll_back() {
    let directory = TestDirectory::new();
    let database = Database::open(directory.0.path().join("restork.db")).expect("database");
    let first = json!({"prompt_id": "research", "revision": 1, "content": "Evidence first"});
    database
        .append_prompt_revision(
            "research",
            1,
            &first,
            &"a".repeat(64),
            None,
            "2026-08-02T08:00:00Z",
        )
        .expect("first prompt revision");
    let active = database
        .activate_prompt("research", 1, None, "2026-08-02T08:01:00Z")
        .expect("activate first revision");
    assert!(active.active);

    let second = json!({"prompt_id": "research", "revision": 2, "content": "Cite evidence"});
    database
        .append_prompt_revision(
            "research",
            2,
            &second,
            &"b".repeat(64),
            Some(1),
            "2026-08-02T08:02:00Z",
        )
        .expect("second prompt revision");
    database
        .activate_prompt("research", 2, Some(1), "2026-08-02T08:03:00Z")
        .expect("activate second revision");
    let rolled_back = database
        .activate_prompt("research", 1, Some(2), "2026-08-02T08:04:00Z")
        .expect("roll back activation");
    assert_eq!(rolled_back.prompt["revision"], 1);
    assert_eq!(
        database
            .prompt_revisions("research")
            .expect("history")
            .len(),
        2
    );
}
