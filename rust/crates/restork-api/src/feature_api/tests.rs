use super::*;

#[test]
fn study_note_slug_keeps_cjk_and_collapses_separators() {
    assert_eq!(
        study_note_slug("Agent Harness 总览", "run-1"),
        "Agent-Harness-总览"
    );
    assert_eq!(
        study_note_slug("a/b\\c:d*e?f\"g<h>i|j", "run-1"),
        "a-b-c-d-e-f-g-h-i-j"
    );
}

#[test]
fn study_note_slug_falls_back_and_caps_length() {
    assert!(study_note_slug("///...", "run-abc").starts_with("run-"));
    let long = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz";
    assert!(study_note_slug(long, "run-1").chars().count() <= 48);
    assert!(!study_note_slug(long, "run-1").ends_with('-'));
}

#[test]
fn research_note_path_uses_the_question_instead_of_the_run_id() {
    let path = research_note_path("RAG 精确召回：订单号与价格", "run-secret-internal-id");
    assert_eq!(path, "Restork Research - RAG-精确召回-订单号与价格.md");
    assert!(!path.contains("run-secret-internal-id"));
}

#[test]
fn legacy_research_artifact_is_migrated_when_it_is_read_or_retried() {
    let mut artifact = json!({
        "title": "Pi 与 DeepSeek Harness 对比",
        "question": "Pi 与 DeepSeek Harness 对比",
        "note_preview": {
            "relative_path": "Restork Research - run-b74d7d07a6960ae2a3ad6191bc5b5061.md"
        }
    });
    normalize_research_note_path(&mut artifact, "run-b74d7d07a6960ae2a3ad6191bc5b5061");
    assert_eq!(
        artifact["note_preview"]["relative_path"],
        "Restork Research - Pi-与-DeepSeek-Harness-对比.md"
    );
}

#[test]
fn study_note_markdown_renders_grounded_sections() {
    let note = study_note_markdown(
        "Agent Harness 总览",
        "ready",
        &json!(["能说出 harness 的职责"]),
        &[
            json!({"title": "学习-Agent Harness 总览", "relative_path": "学习-Agent Harness 总览.md", "rationale": "基础概念"}),
        ],
        &[
            json!({"order": 1, "title": "Harness 是什么", "outcome": "说清控制层", "note_refs": ["学习-Agent Harness 总览.md"]}),
        ],
        &[
            json!({"kind": "active_recall", "prompt": "harness 和 loop 的区别", "concept": "harness", "hints": ["从职责边界想"]}),
        ],
        &[
            json!({"title": "学习-Agent Loop与Loop Engineering", "relative_path": "学习-Agent Loop与Loop Engineering.md"}),
        ],
    );
    assert!(note.starts_with("# Restork Study: Agent Harness 总览\n"));
    assert!(note.contains("Readiness: ready"));
    assert!(note.contains("- 能说出 harness 的职责"));
    assert!(note.contains("[[学习-Agent Harness 总览]] (`学习-Agent Harness 总览.md`) — 基础概念"));
    assert!(note.contains("1. **Harness 是什么** — 说清控制层"));
    assert!(note.contains("- [active_recall] harness 和 loop 的区别 — concept: harness"));
    assert!(note.contains("  - Hint: 从职责边界想"));
    assert!(note.contains("[[学习-Agent Loop与Loop Engineering]]"));
    // Answer keys / rubrics must never leak into the note.
    assert!(!note.contains("grading_rubric"));
}

#[test]
fn work_folder_grant_resolves_without_exposing_the_path_in_the_request() {
    let grant_dir = tempfile::tempdir().expect("grant directory");
    let workspace = tempfile::tempdir().expect("workspace");
    let grant_id = "0123456789abcdef0123456789abcdef";
    fs::write(
        grant_dir.path().join(format!("{grant_id}.grant")),
        workspace.path().to_string_lossy().as_bytes(),
    )
    .expect("grant fixture");
    let payload = WorkStart {
        goal: "prepare the release".to_owned(),
        workspace_root: None,
        workspace_grant_id: Some(grant_id.to_owned()),
        target_files: Vec::new(),
        context_files: Vec::new(),
        constraints: Vec::new(),
        non_goals: Vec::new(),
        completion_criteria: Vec::new(),
        verification_commands: Vec::new(),
        context_data_class: "public".to_owned(),
    };

    assert!(validate_work_start(&payload).is_ok());
    let (resolved, consumed) =
        resolve_work_root_with_grant_dir(&payload, Some(grant_dir.path())).expect("resolved grant");
    assert_eq!(resolved, workspace.path());
    assert_eq!(
        consumed,
        Some(grant_dir.path().join(format!("{grant_id}.grant")))
    );
}
