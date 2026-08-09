use std::collections::BTreeSet;

use chrono::{DateTime, Utc};
use restork_automation::{
    ArtifactResult, BudgetGrant, CheckpointFile, CheckpointSpec, ConcurrencyGate,
    EvaluationManifest, MissedRunPolicy, Recurrence, RestoreSelection, ScheduleJob, ScheduleSpec,
    SubtaskSpec,
};

fn instant(value: &str) -> DateTime<Utc> {
    value.parse().expect("RFC3339 timestamp")
}

#[test]
fn daily_schedule_is_dst_safe_and_period_keys_are_stable() {
    let schedule = ScheduleSpec::new(
        "schedule-daily",
        "America/New_York",
        Recurrence::Daily {
            hour: 2,
            minute: 30,
        },
        MissedRunPolicy::CreateDraft,
        ScheduleJob::Deterministic {
            job: "calendar.refresh".to_owned(),
        },
    )
    .expect("valid schedule");

    let occurrences = schedule
        .due_between(
            instant("2026-03-07T00:00:00Z"),
            instant("2026-03-10T12:00:00Z"),
        )
        .expect("DST-safe occurrences");

    assert_eq!(occurrences.len(), 4);
    assert!(
        occurrences
            .iter()
            .all(|item| item.period_key.starts_with("schedule-daily:"))
    );
    assert_eq!(
        occurrences
            .iter()
            .map(|item| item.period_key.as_str())
            .collect::<BTreeSet<_>>()
            .len(),
        4
    );
    assert!(occurrences.iter().any(|item| item.dst_adjusted));
}

#[test]
fn model_schedule_jobs_are_draft_only_and_reject_effect_requests() {
    let draft = serde_json::json!({
        "kind": "model_draft",
        "provider_profile_id": "deepseek-main",
        "report_kind": "weekly_report",
        "title": "本周复盘",
        "language": "zh-CN",
        "focus": "总结完成事项、阻塞和下一步",
        "network_access_confirmed": true
    });
    let job = serde_json::from_value::<ScheduleJob>(draft).expect("bounded model draft");
    assert!(matches!(job, ScheduleJob::ModelDraft { .. }));

    let unsupported = serde_json::json!({
        "kind": "model_draft",
        "provider_profile_id": "deepseek-main",
        "report_kind": "weekly_report",
        "title": "本周复盘",
        "language": "zh-CN",
        "focus": "总结完成事项",
        "network_access_confirmed": true,
        "requested_effect": "vault.write"
    });
    assert!(serde_json::from_value::<ScheduleJob>(unsupported).is_err());
}

#[test]
fn checkpoint_restore_is_bounded_and_requires_a_pre_rollback_snapshot() {
    let checkpoint = CheckpointSpec::new(
        "checkpoint-1",
        "run-1",
        vec![
            CheckpointFile::new("Notes/a.md", "a".repeat(64), 12).expect("file"),
            CheckpointFile::new("Notes/b.md", "b".repeat(64), 20).expect("file"),
        ],
        10,
        1_024,
    )
    .expect("checkpoint");

    let preview = checkpoint
        .preview_restore(
            RestoreSelection::Files(BTreeSet::from(["Notes/a.md".to_owned()])),
            Some("checkpoint-before-rollback"),
        )
        .expect("restore preview");
    assert_eq!(preview.files.len(), 1);
    assert_eq!(
        preview.pre_rollback_checkpoint,
        "checkpoint-before-rollback"
    );
    assert!(
        checkpoint
            .preview_restore(RestoreSelection::All, None)
            .is_err()
    );
}

#[test]
fn child_delegation_can_only_reduce_parent_authority_and_cannot_recurse() {
    let parent_budget = BudgetGrant {
        model_turns: 8,
        tool_calls: 6,
        tokens: 20_000,
        wall_time_ms: 60_000,
    };
    let child = SubtaskSpec::new(
        "subtask-1",
        "run-parent",
        1,
        BTreeSet::from(["source:a".to_owned()]),
        BTreeSet::from(["vault.search".to_owned()]),
        BudgetGrant {
            model_turns: 2,
            tool_calls: 1,
            tokens: 2_000,
            wall_time_ms: 10_000,
        },
        &BTreeSet::from(["source:a".to_owned(), "source:b".to_owned()]),
        &BTreeSet::from(["vault.search".to_owned(), "source.read".to_owned()]),
        parent_budget,
    )
    .expect("bounded child");
    assert!(!child.can_approve_effects);
    assert!(!child.can_write_memory);
    assert!(!child.can_delegate);
    assert!(
        SubtaskSpec::new(
            "subtask-recursive",
            "run-parent",
            2,
            BTreeSet::new(),
            BTreeSet::new(),
            parent_budget,
            &BTreeSet::new(),
            &BTreeSet::new(),
            parent_budget,
        )
        .is_err()
    );
}

#[test]
fn parent_accepts_only_a_structured_result_bound_to_the_frozen_subtask() {
    let parent_budget = BudgetGrant {
        model_turns: 2,
        tool_calls: 1,
        tokens: 2_000,
        wall_time_ms: 10_000,
    };
    let child = SubtaskSpec::new(
        "subtask-2",
        "run-parent",
        1,
        BTreeSet::new(),
        BTreeSet::new(),
        parent_budget,
        &BTreeSet::new(),
        &BTreeSet::new(),
        parent_budget,
    )
    .expect("child");

    assert!(
        child
            .validate_result(&ArtifactResult {
                subtask_id: "subtask-2".to_owned(),
                manifest_hash: child.manifest_hash.clone(),
                artifact_kind: "research".to_owned(),
                artifact_hash: "c".repeat(64),
                validated: true,
            })
            .is_ok()
    );
    assert!(
        child
            .validate_result(&ArtifactResult {
                subtask_id: "another".to_owned(),
                manifest_hash: child.manifest_hash.clone(),
                artifact_kind: "research".to_owned(),
                artifact_hash: "c".repeat(64),
                validated: true,
            })
            .is_err()
    );
}

#[test]
fn global_concurrency_gate_releases_capacity_with_the_lease() {
    let gate = ConcurrencyGate::new(2).expect("gate");
    let first = gate.try_acquire().expect("first lease");
    let second = gate.try_acquire().expect("second lease");
    assert!(gate.try_acquire().is_none());
    drop(first);
    assert!(gate.try_acquire().is_some());
    drop(second);
}

#[test]
fn evaluation_manifest_freezes_every_behavioral_version() {
    let manifest = EvaluationManifest::new(
        "suite-1",
        "model@sha256:aaaaaaaa",
        "prompt@sha256:bbbbbbbb",
        "skill@sha256:cccccccc",
        "tools@sha256:dddddddd",
        "policy@sha256:eeeeeeee",
        "fixtures@sha256:ffffffff",
    )
    .expect("manifest");
    assert_eq!(manifest.manifest_hash.len(), 64);
    assert!(!manifest.public_export_includes_private_trajectory);
}
