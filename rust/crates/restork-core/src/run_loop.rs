//! A deterministic state machine with explicit limits for one Restork run.

use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode {
    Research,
    Study,
    Work,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum DataClass {
    Public,
    Personal,
    Confidential,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunPhase {
    Intake,
    Proposed,
    Model,
    Policy,
    AwaitingApproval,
    Tool,
    Validation,
    Completed,
    Stopped,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LimitKind {
    ModelTurns,
    ToolCalls,
    Retries,
    WallTime,
    OutputBytes,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolEffect {
    ReadOnly,
    Effect,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolRequest {
    name: String,
    effect: ToolEffect,
}

impl ToolRequest {
    #[must_use]
    pub fn new(name: impl Into<String>, effect: ToolEffect) -> Self {
        Self {
            name: name.into(),
            effect,
        }
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub const fn effect(&self) -> ToolEffect {
        self.effect
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelOutcome {
    Artifact { output_bytes: u64 },
    Tool(ToolRequest),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PolicyDecision {
    AllowReadOnly,
    RequireApproval,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactValidation {
    Valid,
    Repairable,
    Invalid,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StopReason {
    Cancelled,
    CapabilityDenied(String),
    PolicyDenied,
    PolicyMismatch,
    ApprovalRejected,
    InvalidArtifact,
    LimitExceeded(LimitKind),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransitionError {
    InvalidLimits,
    InvalidManifest,
    InvalidPhase {
        expected: &'static str,
        actual: RunPhase,
    },
    CapabilityDenied(String),
    PolicyDenied,
    PolicyMismatch,
    InvalidArtifact,
    LimitExceeded(LimitKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RunLimits {
    pub max_model_turns: u32,
    pub max_tool_calls: u32,
    pub max_retries: u32,
    pub max_wall_time_ms: u64,
    pub max_output_bytes: u64,
}

impl RunLimits {
    fn is_valid(self) -> bool {
        self.max_model_turns > 0 && self.max_wall_time_ms > 0 && self.max_output_bytes > 0
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct RunUsage {
    pub model_turns: u32,
    pub tool_calls: u32,
    pub retries: u32,
    pub output_bytes: u64,
    pub observed_wall_time_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FrozenRunManifest {
    mode: Mode,
    data_class: DataClass,
    provider: String,
    model: String,
    allowed_tools: BTreeSet<String>,
}

impl FrozenRunManifest {
    pub fn new(
        mode: Mode,
        data_class: DataClass,
        provider: impl Into<String>,
        model: impl Into<String>,
        allowed_tools: BTreeSet<String>,
    ) -> Result<Self, TransitionError> {
        let provider = provider.into();
        let model = model.into();
        if provider.trim().is_empty()
            || model.trim().is_empty()
            || allowed_tools
                .iter()
                .any(|tool| tool.trim().is_empty() || tool.len() > 128)
        {
            return Err(TransitionError::InvalidManifest);
        }
        Ok(Self {
            mode,
            data_class,
            provider,
            model,
            allowed_tools,
        })
    }

    #[must_use]
    pub const fn mode(&self) -> Mode {
        self.mode
    }

    #[must_use]
    pub const fn data_class(&self) -> DataClass {
        self.data_class
    }

    #[must_use]
    pub fn provider(&self) -> &str {
        &self.provider
    }

    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }

    #[must_use]
    pub const fn allowed_tools(&self) -> &BTreeSet<String> {
        &self.allowed_tools
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunMachine {
    phase: RunPhase,
    limits: RunLimits,
    usage: RunUsage,
    manifest: Option<FrozenRunManifest>,
    pending_tool: Option<ToolRequest>,
    stop_reason: Option<StopReason>,
}

impl RunMachine {
    pub fn new(limits: RunLimits) -> Result<Self, TransitionError> {
        if !limits.is_valid() {
            return Err(TransitionError::InvalidLimits);
        }
        Ok(Self {
            phase: RunPhase::Intake,
            limits,
            usage: RunUsage::default(),
            manifest: None,
            pending_tool: None,
            stop_reason: None,
        })
    }

    #[must_use]
    pub const fn phase(&self) -> RunPhase {
        self.phase
    }

    #[must_use]
    pub const fn usage(&self) -> RunUsage {
        self.usage
    }

    #[must_use]
    pub const fn manifest(&self) -> Option<&FrozenRunManifest> {
        self.manifest.as_ref()
    }

    #[must_use]
    pub const fn pending_tool(&self) -> Option<&ToolRequest> {
        self.pending_tool.as_ref()
    }

    #[must_use]
    pub const fn stop_reason(&self) -> Option<&StopReason> {
        self.stop_reason.as_ref()
    }

    pub fn propose(&mut self) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Intake, "intake")?;
        self.phase = RunPhase::Proposed;
        Ok(())
    }

    pub fn confirm(&mut self, manifest: FrozenRunManifest) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Proposed, "proposed")?;
        self.manifest = Some(manifest);
        self.phase = RunPhase::Model;
        Ok(())
    }

    pub fn complete_model_step(
        &mut self,
        outcome: ModelOutcome,
        elapsed_ms: u64,
    ) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Model, "model")?;
        self.observe_elapsed(elapsed_ms)?;
        if self.usage.model_turns >= self.limits.max_model_turns {
            return self.stop_for_limit(LimitKind::ModelTurns);
        }
        self.usage.model_turns += 1;

        match outcome {
            ModelOutcome::Artifact { output_bytes } => {
                let total = self.usage.output_bytes.saturating_add(output_bytes);
                self.usage.output_bytes = total;
                if total > self.limits.max_output_bytes {
                    return self.stop_for_limit(LimitKind::OutputBytes);
                }
                self.phase = RunPhase::Validation;
            }
            ModelOutcome::Tool(request) => {
                let allowed = self
                    .manifest
                    .as_ref()
                    .is_some_and(|manifest| manifest.allowed_tools.contains(request.name()));
                if !allowed {
                    let name = request.name;
                    self.stop(StopReason::CapabilityDenied(name.clone()));
                    return Err(TransitionError::CapabilityDenied(name));
                }
                if self.usage.tool_calls >= self.limits.max_tool_calls {
                    return self.stop_for_limit(LimitKind::ToolCalls);
                }
                self.pending_tool = Some(request);
                self.phase = RunPhase::Policy;
            }
        }
        Ok(())
    }

    pub fn apply_policy(
        &mut self,
        decision: PolicyDecision,
        elapsed_ms: u64,
    ) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Policy, "policy")?;
        self.observe_elapsed(elapsed_ms)?;
        let effect = self
            .pending_tool
            .as_ref()
            .map(ToolRequest::effect)
            .ok_or(TransitionError::PolicyMismatch)?;
        match decision {
            PolicyDecision::AllowReadOnly if effect == ToolEffect::ReadOnly => {
                self.phase = RunPhase::Tool;
                Ok(())
            }
            PolicyDecision::RequireApproval => {
                self.phase = RunPhase::AwaitingApproval;
                Ok(())
            }
            PolicyDecision::Deny => {
                self.stop(StopReason::PolicyDenied);
                Err(TransitionError::PolicyDenied)
            }
            PolicyDecision::AllowReadOnly => {
                self.stop(StopReason::PolicyMismatch);
                Err(TransitionError::PolicyMismatch)
            }
        }
    }

    pub fn approve_effect(&mut self, elapsed_ms: u64) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::AwaitingApproval, "awaiting_approval")?;
        self.observe_elapsed(elapsed_ms)?;
        self.phase = RunPhase::Tool;
        Ok(())
    }

    pub fn reject_effect(&mut self, elapsed_ms: u64) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::AwaitingApproval, "awaiting_approval")?;
        self.observe_elapsed(elapsed_ms)?;
        self.stop(StopReason::ApprovalRejected);
        Ok(())
    }

    pub fn complete_tool(&mut self, elapsed_ms: u64) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Tool, "tool")?;
        self.observe_elapsed(elapsed_ms)?;
        if self.usage.tool_calls >= self.limits.max_tool_calls {
            return self.stop_for_limit(LimitKind::ToolCalls);
        }
        self.usage.tool_calls += 1;
        self.pending_tool = None;
        self.phase = RunPhase::Model;
        Ok(())
    }

    pub fn validate_artifact(
        &mut self,
        validation: ArtifactValidation,
        elapsed_ms: u64,
    ) -> Result<(), TransitionError> {
        self.require_phase(RunPhase::Validation, "validation")?;
        self.observe_elapsed(elapsed_ms)?;
        match validation {
            ArtifactValidation::Valid => {
                self.phase = RunPhase::Completed;
                Ok(())
            }
            ArtifactValidation::Repairable => {
                if self.usage.retries >= self.limits.max_retries {
                    return self.stop_for_limit(LimitKind::Retries);
                }
                self.usage.retries += 1;
                self.phase = RunPhase::Model;
                Ok(())
            }
            ArtifactValidation::Invalid => {
                self.stop(StopReason::InvalidArtifact);
                Err(TransitionError::InvalidArtifact)
            }
        }
    }

    pub fn cancel(&mut self) {
        if !matches!(self.phase, RunPhase::Completed | RunPhase::Stopped) {
            self.stop(StopReason::Cancelled);
        }
    }

    fn require_phase(
        &self,
        expected_phase: RunPhase,
        expected_name: &'static str,
    ) -> Result<(), TransitionError> {
        if self.phase == expected_phase {
            return Ok(());
        }
        Err(TransitionError::InvalidPhase {
            expected: expected_name,
            actual: self.phase,
        })
    }

    fn observe_elapsed(&mut self, elapsed_ms: u64) -> Result<(), TransitionError> {
        self.usage.observed_wall_time_ms = self.usage.observed_wall_time_ms.max(elapsed_ms);
        if elapsed_ms > self.limits.max_wall_time_ms {
            return self.stop_for_limit(LimitKind::WallTime);
        }
        Ok(())
    }

    fn stop_for_limit(&mut self, limit: LimitKind) -> Result<(), TransitionError> {
        self.stop(StopReason::LimitExceeded(limit));
        Err(TransitionError::LimitExceeded(limit))
    }

    fn stop(&mut self, reason: StopReason) {
        self.phase = RunPhase::Stopped;
        self.pending_tool = None;
        self.stop_reason = Some(reason);
    }
}
