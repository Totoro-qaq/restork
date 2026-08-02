use std::collections::BTreeSet;

use restork_core::run_loop::{
    ArtifactValidation, DataClass, FrozenRunManifest, LimitKind, Mode, ModelOutcome,
    PolicyDecision, RunLimits, RunMachine, RunPhase, StopReason, ToolEffect, ToolRequest,
    TransitionError,
};

fn limits() -> RunLimits {
    RunLimits {
        max_model_turns: 3,
        max_tool_calls: 2,
        max_retries: 1,
        max_wall_time_ms: 30_000,
        max_output_bytes: 32_000,
    }
}

fn manifest(tools: &[&str]) -> FrozenRunManifest {
    FrozenRunManifest::new(
        Mode::Research,
        DataClass::Public,
        "deepseek",
        "deepseek-v4-pro",
        tools.iter().map(|tool| (*tool).to_owned()).collect(),
    )
    .expect("fixture manifest is valid")
}

#[test]
fn a_confirmed_run_completes_only_after_artifact_validation() {
    let mut run = RunMachine::new(limits()).expect("valid limits");
    assert_eq!(run.phase(), RunPhase::Intake);

    run.propose().expect("intake can create a proposal");
    assert_eq!(run.phase(), RunPhase::Proposed);

    run.confirm(manifest(&[]))
        .expect("a proposal can be confirmed");
    assert_eq!(run.phase(), RunPhase::Model);

    run.complete_model_step(ModelOutcome::Artifact { output_bytes: 128 }, 25)
        .expect("the first bounded model step is allowed");
    assert_eq!(run.phase(), RunPhase::Validation);

    run.validate_artifact(ArtifactValidation::Valid, 30)
        .expect("a valid artifact completes the run");
    assert_eq!(run.phase(), RunPhase::Completed);
    assert_eq!(run.usage().model_turns, 1);
}

#[test]
fn an_effect_tool_cannot_execute_before_single_use_approval() {
    let mut run = RunMachine::new(limits()).expect("valid limits");
    run.propose().expect("proposal");
    run.confirm(manifest(&["vault.write"]))
        .expect("confirmation");
    run.complete_model_step(
        ModelOutcome::Tool(ToolRequest::new("vault.write", ToolEffect::Effect)),
        10,
    )
    .expect("approved tool is requestable");
    assert_eq!(run.phase(), RunPhase::Policy);

    run.apply_policy(PolicyDecision::RequireApproval, 11)
        .expect("effect enters approval");
    assert_eq!(run.phase(), RunPhase::AwaitingApproval);
    assert_eq!(
        run.complete_tool(12),
        Err(TransitionError::InvalidPhase {
            expected: "tool",
            actual: RunPhase::AwaitingApproval,
        })
    );

    run.approve_effect(13).expect("approval is consumed once");
    run.complete_tool(14).expect("approved effect may execute");
    assert_eq!(run.phase(), RunPhase::Model);
    assert_eq!(run.usage().tool_calls, 1);
    assert_eq!(
        run.approve_effect(15),
        Err(TransitionError::InvalidPhase {
            expected: "awaiting_approval",
            actual: RunPhase::Model,
        })
    );
}

#[test]
fn an_unknown_tool_fails_closed_and_cannot_expand_the_frozen_manifest() {
    let granted = BTreeSet::from(["web.search".to_owned()]);
    let mut run = RunMachine::new(limits()).expect("valid limits");
    run.propose().expect("proposal");
    run.confirm(
        FrozenRunManifest::new(
            Mode::Research,
            DataClass::Public,
            "deepseek",
            "deepseek-v4-pro",
            granted,
        )
        .expect("manifest"),
    )
    .expect("confirmation");

    assert_eq!(
        run.complete_model_step(
            ModelOutcome::Tool(ToolRequest::new("shell.exec", ToolEffect::Effect)),
            5,
        ),
        Err(TransitionError::CapabilityDenied("shell.exec".to_owned()))
    );
    assert_eq!(run.phase(), RunPhase::Stopped);
    assert_eq!(
        run.stop_reason(),
        Some(&StopReason::CapabilityDenied("shell.exec".to_owned()))
    );
    assert_eq!(
        run.manifest().expect("frozen manifest").allowed_tools(),
        &BTreeSet::from(["web.search".to_owned(),])
    );
}

#[test]
fn a_repair_loop_stops_when_its_retry_budget_is_exhausted() {
    let mut run = RunMachine::new(limits()).expect("valid limits");
    run.propose().expect("proposal");
    run.confirm(manifest(&[])).expect("confirmation");
    run.complete_model_step(ModelOutcome::Artifact { output_bytes: 64 }, 1)
        .expect("model step");
    run.validate_artifact(ArtifactValidation::Repairable, 2)
        .expect("first repair is within budget");
    assert_eq!(run.phase(), RunPhase::Model);
    assert_eq!(run.usage().retries, 1);

    run.complete_model_step(ModelOutcome::Artifact { output_bytes: 64 }, 3)
        .expect("second model step");
    assert_eq!(
        run.validate_artifact(ArtifactValidation::Repairable, 4),
        Err(TransitionError::LimitExceeded(LimitKind::Retries))
    );
    assert_eq!(run.phase(), RunPhase::Stopped);
    assert_eq!(
        run.stop_reason(),
        Some(&StopReason::LimitExceeded(LimitKind::Retries))
    );
}

#[test]
fn wall_time_output_and_turn_limits_stop_before_more_work() {
    let mut turn_limited = RunMachine::new(RunLimits {
        max_model_turns: 1,
        ..limits()
    })
    .expect("valid limits");
    turn_limited.propose().expect("proposal");
    turn_limited.confirm(manifest(&[])).expect("confirmation");
    turn_limited
        .complete_model_step(ModelOutcome::Artifact { output_bytes: 4 }, 1)
        .expect("first turn");
    turn_limited
        .validate_artifact(ArtifactValidation::Repairable, 2)
        .expect("repair request");
    assert_eq!(
        turn_limited.complete_model_step(ModelOutcome::Artifact { output_bytes: 4 }, 3),
        Err(TransitionError::LimitExceeded(LimitKind::ModelTurns))
    );

    let mut output_limited = RunMachine::new(RunLimits {
        max_output_bytes: 8,
        ..limits()
    })
    .expect("valid limits");
    output_limited.propose().expect("proposal");
    output_limited.confirm(manifest(&[])).expect("confirmation");
    assert_eq!(
        output_limited.complete_model_step(ModelOutcome::Artifact { output_bytes: 9 }, 1),
        Err(TransitionError::LimitExceeded(LimitKind::OutputBytes))
    );

    let mut time_limited = RunMachine::new(RunLimits {
        max_wall_time_ms: 10,
        ..limits()
    })
    .expect("valid limits");
    time_limited.propose().expect("proposal");
    time_limited.confirm(manifest(&[])).expect("confirmation");
    assert_eq!(
        time_limited.complete_model_step(ModelOutcome::Artifact { output_bytes: 1 }, 11),
        Err(TransitionError::LimitExceeded(LimitKind::WallTime))
    );
}

#[test]
fn invalid_limits_and_invalid_transitions_are_rejected() {
    assert_eq!(
        RunMachine::new(RunLimits {
            max_model_turns: 0,
            ..limits()
        }),
        Err(TransitionError::InvalidLimits)
    );

    let mut run = RunMachine::new(limits()).expect("valid limits");
    assert_eq!(
        run.confirm(manifest(&[])),
        Err(TransitionError::InvalidPhase {
            expected: "proposed",
            actual: RunPhase::Intake,
        })
    );
    run.cancel();
    assert_eq!(run.phase(), RunPhase::Stopped);
    assert_eq!(run.stop_reason(), Some(&StopReason::Cancelled));
}
