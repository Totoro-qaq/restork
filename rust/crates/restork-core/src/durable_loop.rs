//! Durable, bounded agent execution over the Rust-owned event log.

use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use futures_util::StreamExt;
use restork_provider::{
    ChatCompletion, ChatEventStream, ChatMessage, ChatOptions, ChatTool, ProviderError, ToolCall,
    estimate_chat_tokens,
};
use restork_storage::{Database, NewEvent, RunRecord, StorageError};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use tokio::sync::watch;

pub type AgentFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait AgentModel: Send + Sync {
    fn complete<'a>(
        &'a self,
        messages: &'a [ChatMessage],
        maximum_output_tokens: u32,
        options: &'a ChatOptions,
    ) -> AgentFuture<'a, Result<ChatCompletion, ProviderError>>;

    fn stream<'a>(
        &'a self,
        _messages: &'a [ChatMessage],
        _maximum_output_tokens: u32,
        _options: &'a ChatOptions,
    ) -> AgentFuture<'a, Result<Option<ChatEventStream>, ProviderError>> {
        Box::pin(async { Ok(None) })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentToolEffect {
    ReadOnly,
    Effect,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolFailureKind {
    InvalidArguments,
    UnknownTool,
    ExecutionFailed,
    Timeout,
    Denied,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolFailure {
    pub kind: ToolFailureKind,
    pub message: String,
    pub retryable: bool,
}

pub trait AgentTool: Send + Sync {
    fn definition(&self) -> ChatTool;
    fn effect(&self) -> AgentToolEffect;
    fn normalize(&self, input: Value) -> Result<Value, ToolFailure> {
        if input.is_object() {
            Ok(input)
        } else {
            Err(ToolFailure {
                kind: ToolFailureKind::InvalidArguments,
                message: "Tool arguments must be one JSON object.".to_owned(),
                retryable: true,
            })
        }
    }
    fn invoke<'a>(
        &'a self,
        input: Value,
        cancellation: watch::Receiver<bool>,
    ) -> AgentFuture<'a, Result<Value, ToolFailure>>;
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentBounds {
    pub maximum_iterations: u32,
    pub maximum_repairs: u32,
    pub maximum_provider_retries: u32,
    pub maximum_wall_time_ms: u64,
    pub maximum_total_tokens: u64,
    pub maximum_cost_usd_micros: u64,
    pub maximum_output_tokens_per_request: u32,
    pub maximum_context_tokens: u64,
}

impl AgentBounds {
    #[must_use]
    pub const fn conservative() -> Self {
        Self {
            maximum_iterations: 16,
            maximum_repairs: 4,
            maximum_provider_retries: 2,
            maximum_wall_time_ms: 120_000,
            maximum_total_tokens: 64_000,
            maximum_cost_usd_micros: 100_000,
            maximum_output_tokens_per_request: 8_192,
            maximum_context_tokens: 64_000,
        }
    }

    fn validate(self) -> Result<Self, AgentError> {
        if self.maximum_iterations == 0
            || self.maximum_wall_time_ms == 0
            || self.maximum_total_tokens == 0
            || self.maximum_cost_usd_micros == 0
            || self.maximum_output_tokens_per_request == 0
            || self.maximum_context_tokens < 1_024
        {
            return Err(AgentError::InvalidBounds);
        }
        Ok(self)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PromptProvenance {
    pub prompt_id: String,
    pub version: String,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStopReason {
    Completed,
    Cancelled,
    IterationLimit,
    RepairLimit,
    WallTimeLimit,
    TokenLimit,
    CostLimit,
    ApprovalRequired,
    ApprovalDenied,
    ProviderAuthentication,
    ProviderConfiguration,
    ProviderUnavailable,
    CheckpointConflict,
}

impl AgentStopReason {
    #[must_use]
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::IterationLimit => "iteration_limit",
            Self::RepairLimit => "repair_limit",
            Self::WallTimeLimit => "wall_time_limit",
            Self::TokenLimit => "token_limit",
            Self::CostLimit => "cost_limit",
            Self::ApprovalRequired => "approval_required",
            Self::ApprovalDenied => "approval_denied",
            Self::ProviderAuthentication => "provider_authentication",
            Self::ProviderConfiguration => "provider_configuration",
            Self::ProviderUnavailable => "provider_unavailable",
            Self::CheckpointConflict => "checkpoint_conflict",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct AgentOutcome {
    pub run_id: String,
    pub state: String,
    pub stop_reason: AgentStopReason,
    pub output: Option<String>,
    pub iterations: u32,
    pub repairs: u32,
    pub total_tokens: u64,
    pub cost_usd_micros: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AgentError {
    InvalidBounds,
    RunNotFound,
    AlreadyAdvancing,
    InvalidCheckpoint,
    Storage,
}

enum ModelCallError {
    Provider(ProviderError),
    Storage,
}

impl From<StorageError> for AgentError {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Conflict(_) => Self::AlreadyAdvancing,
            _ => Self::Storage,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentAuthorization {
    #[serde(default)]
    pub approved_tool_calls: BTreeSet<String>,
    #[serde(default)]
    pub denied_tool_calls: BTreeSet<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct AgentCheckpoint {
    schema_version: u8,
    messages: Vec<ChatMessage>,
    iterations: u32,
    repairs: u32,
    provider_retries: u32,
    total_tokens: u64,
    cost_usd_micros: u64,
    pending_tool: Option<ToolCall>,
    #[serde(default)]
    pending_action_digest: Option<String>,
    #[serde(default)]
    pending_approval_expires_at: Option<String>,
    compactions: u32,
}

impl AgentCheckpoint {
    fn new(goal: &str, system_prompt: &str) -> Self {
        Self {
            schema_version: 1,
            messages: vec![
                ChatMessage::text("system", system_prompt),
                ChatMessage::text("user", goal),
            ],
            iterations: 0,
            repairs: 0,
            provider_retries: 0,
            total_tokens: 0,
            cost_usd_micros: 0,
            pending_tool: None,
            pending_action_digest: None,
            pending_approval_expires_at: None,
            compactions: 0,
        }
    }

    fn redacted(&self) -> Self {
        let mut redacted = self.clone();
        for message in &mut redacted.messages {
            message.reasoning_content = None;
        }
        redacted
    }
}

pub struct DurableAgent {
    storage: Arc<Database>,
    model: Arc<dyn AgentModel>,
    tools: BTreeMap<String, Arc<dyn AgentTool>>,
    bounds: AgentBounds,
    provenance: PromptProvenance,
    system_prompt: String,
}

impl DurableAgent {
    pub fn new(
        storage: Arc<Database>,
        model: Arc<dyn AgentModel>,
        tools: impl IntoIterator<Item = Arc<dyn AgentTool>>,
        bounds: AgentBounds,
        provenance: PromptProvenance,
        system_prompt: impl Into<String>,
    ) -> Result<Self, AgentError> {
        let bounds = bounds.validate()?;
        let mut registry = BTreeMap::new();
        for tool in tools {
            let definition = tool.definition();
            if definition.name.is_empty()
                || definition.description.is_empty()
                || !definition.parameters.is_object()
                || registry.insert(definition.name, tool).is_some()
            {
                return Err(AgentError::InvalidBounds);
            }
        }
        let system_prompt = system_prompt.into();
        if system_prompt.is_empty() || system_prompt.len() > 64_000 {
            return Err(AgentError::InvalidBounds);
        }
        Ok(Self {
            storage,
            model,
            tools: registry,
            bounds,
            provenance,
            system_prompt,
        })
    }

    pub async fn run(
        &self,
        run_id: &str,
        authorization: &AgentAuthorization,
        mut cancellation: watch::Receiver<bool>,
    ) -> Result<AgentOutcome, AgentError> {
        let started = Instant::now();
        let mut run = self.storage.run(run_id)?.ok_or(AgentError::RunNotFound)?;
        let replay = self.storage.replay_window(run_id, 0, 10_000)?;
        let mut expected_checkpoint_sequence = replay
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.covered_sequence);
        let mut last_sequence = replay
            .events
            .last()
            .map(|event| event.sequence)
            .or(expected_checkpoint_sequence)
            .unwrap_or_default();
        let mut checkpoint = replay.snapshot.map_or_else(
            || {
                let goal = run
                    .task_spec
                    .get("goal")
                    .and_then(Value::as_str)
                    .unwrap_or("Complete the confirmed Restork run.");
                Ok(AgentCheckpoint::new(goal, &self.system_prompt))
            },
            |snapshot| {
                serde_json::from_value::<AgentCheckpoint>(snapshot.snapshot)
                    .map_err(|_| AgentError::InvalidCheckpoint)
            },
        )?;

        if run.state == "awaiting_approval" {
            let Some(call) = checkpoint.pending_tool.clone() else {
                return Err(AgentError::InvalidCheckpoint);
            };
            let Some(expected_digest) = checkpoint.pending_action_digest.as_deref() else {
                return Err(AgentError::InvalidCheckpoint);
            };
            let tool = self
                .tools
                .get(&call.name)
                .ok_or(AgentError::InvalidCheckpoint)?;
            let normalized = tool
                .normalize(call.arguments.clone())
                .map_err(|_| AgentError::InvalidCheckpoint)?;
            if action_digest(&call.name, &normalized) != expected_digest {
                return Err(AgentError::InvalidCheckpoint);
            }
            if authorization.denied_tool_calls.contains(&call.id) {
                return self.finish(
                    &mut run,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    &mut last_sequence,
                    AgentStopReason::ApprovalDenied,
                    None,
                );
            }
            if !authorization.approved_tool_calls.contains(&call.id) {
                if checkpoint
                    .pending_approval_expires_at
                    .as_deref()
                    .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
                    .is_none_or(|expires_at| expires_at <= OffsetDateTime::now_utc())
                {
                    let expires_at = approval_expiry()?;
                    checkpoint.pending_approval_expires_at = Some(expires_at.clone());
                    let request = approval_request(&call, expected_digest, &expires_at);
                    self.storage
                        .save_approval(&call.id, run_id, &expires_at, &request)?;
                    last_sequence = self.append_event(
                        run_id,
                        "approval.requested",
                        json!({
                            "tool_call_id": call.id,
                            "tool": call.name,
                            "arguments": call.arguments,
                            "action_digest": expected_digest,
                            "expires_at": expires_at,
                            "reissued": true,
                        }),
                    )?;
                    self.save_checkpoint(
                        run_id,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        last_sequence,
                    )?;
                }
                return Ok(outcome(
                    &run,
                    &checkpoint,
                    AgentStopReason::ApprovalRequired,
                    None,
                ));
            }
        }
        run = self.claim_running(&run)?;
        last_sequence = self.append_event(
            run_id,
            "run.started",
            json!({"state_version": run.state_version}),
        )?;
        self.save_checkpoint(
            run_id,
            &checkpoint,
            &mut expected_checkpoint_sequence,
            last_sequence,
        )?;

        if let Some(call) = checkpoint.pending_tool.take() {
            let expected_digest = checkpoint
                .pending_action_digest
                .take()
                .ok_or(AgentError::InvalidCheckpoint)?;
            checkpoint.pending_approval_expires_at = None;
            let tool = self
                .tools
                .get(&call.name)
                .ok_or(AgentError::InvalidCheckpoint)?;
            let normalized_arguments = tool
                .normalize(call.arguments.clone())
                .map_err(|_| AgentError::InvalidCheckpoint)?;
            if action_digest(&call.name, &normalized_arguments) != expected_digest {
                return Err(AgentError::InvalidCheckpoint);
            }
            let call = ToolCall {
                arguments: normalized_arguments,
                ..call
            };
            let observation = self.invoke_tool(&call, cancellation.clone(), started).await;
            self.record_tool_observation(
                run_id,
                &call,
                Some(&expected_digest),
                observation,
                &mut checkpoint,
                &mut last_sequence,
            )?;
            self.save_checkpoint(
                run_id,
                &checkpoint,
                &mut expected_checkpoint_sequence,
                last_sequence,
            )?;
        }

        loop {
            if *cancellation.borrow() {
                return self.finish(
                    &mut run,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    &mut last_sequence,
                    AgentStopReason::Cancelled,
                    None,
                );
            }
            if let Some(reason) = self.bound_reason(&checkpoint, started) {
                return self.finish(
                    &mut run,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    &mut last_sequence,
                    reason,
                    None,
                );
            }
            self.compact_if_needed(run_id, &mut checkpoint, &mut last_sequence)?;
            self.save_checkpoint(
                run_id,
                &checkpoint,
                &mut expected_checkpoint_sequence,
                last_sequence,
            )?;

            let options = ChatOptions {
                tools: self.tools.values().map(|tool| tool.definition()).collect(),
                parallel_tool_calls: Some(false),
                ..ChatOptions::default()
            };
            last_sequence = self.append_event(
                run_id,
                "model.started",
                json!({
                    "iteration": checkpoint.iterations + 1,
                    "prompt_id": self.provenance.prompt_id,
                    "prompt_version": self.provenance.version,
                    "prompt_hash": self.provenance.hash,
                }),
            )?;
            let remaining = self
                .bounds
                .maximum_wall_time_ms
                .saturating_sub(elapsed_millis(started));
            let completion = tokio::select! {
                biased;
                changed = cancellation.changed() => {
                    let _ = changed;
                    return self.finish(
                        &mut run,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        &mut last_sequence,
                        AgentStopReason::Cancelled,
                        None,
                    );
                }
                result = tokio::time::timeout(
                    Duration::from_millis(remaining.max(1)),
                    self.complete_model(
                        run_id,
                        &checkpoint.messages,
                        self.bounds.maximum_output_tokens_per_request,
                        &options,
                        &mut last_sequence,
                    ),
                ) => result,
            };
            let completion = match completion {
                Err(_) => {
                    return self.finish(
                        &mut run,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        &mut last_sequence,
                        AgentStopReason::WallTimeLimit,
                        None,
                    );
                }
                Ok(Err(ModelCallError::Provider(error)))
                    if retryable_provider(&error)
                        && checkpoint.provider_retries < self.bounds.maximum_provider_retries =>
                {
                    checkpoint.provider_retries += 1;
                    last_sequence = self.append_event(
                        run_id,
                        "retry.scheduled",
                        json!({
                            "kind": "provider",
                            "attempt": checkpoint.provider_retries,
                            "status": error.status(),
                        }),
                    )?;
                    self.save_checkpoint(
                        run_id,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        last_sequence,
                    )?;
                    tokio::time::sleep(Duration::from_millis(
                        200 * u64::from(checkpoint.provider_retries),
                    ))
                    .await;
                    continue;
                }
                Ok(Err(ModelCallError::Provider(error))) => {
                    let reason = provider_stop_reason(&error);
                    return self.finish(
                        &mut run,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        &mut last_sequence,
                        reason,
                        None,
                    );
                }
                Ok(Err(ModelCallError::Storage)) => return Err(AgentError::Storage),
                Ok(Ok(completion)) => completion,
            };
            checkpoint.iterations += 1;
            checkpoint.provider_retries = 0;
            checkpoint.total_tokens = checkpoint
                .total_tokens
                .saturating_add(completion.total_tokens.unwrap_or_default());
            checkpoint.cost_usd_micros = checkpoint
                .cost_usd_micros
                .saturating_add(completion.cost_usd_micros.unwrap_or_default());
            last_sequence = self.append_event(
                run_id,
                "model.completed",
                json!({
                    "iteration": checkpoint.iterations,
                    "tool_calls": completion.tool_calls.iter().map(|call| call.name.as_str()).collect::<Vec<_>>(),
                    "finish_reason": completion.finish_reason,
                    "prompt_tokens": completion.prompt_tokens,
                    "completion_tokens": completion.completion_tokens,
                    "total_tokens": completion.total_tokens,
                    "cost_usd_micros": completion.cost_usd_micros,
                    "prompt_id": self.provenance.prompt_id,
                    "prompt_version": self.provenance.version,
                    "prompt_hash": self.provenance.hash,
                }),
            )?;
            if let Some(reason) = self.usage_bound_reason(&checkpoint) {
                return self.finish(
                    &mut run,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    &mut last_sequence,
                    reason,
                    None,
                );
            }

            if completion.tool_calls.is_empty() {
                return self.finish(
                    &mut run,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    &mut last_sequence,
                    AgentStopReason::Completed,
                    Some(completion.content),
                );
            }
            checkpoint.messages.push(ChatMessage {
                role: "assistant".to_owned(),
                content: completion.content,
                tool_calls: completion.tool_calls.clone(),
                tool_call_id: None,
                reasoning_content: completion.reasoning_content,
            });

            for call in completion.tool_calls {
                let Some(tool) = self.tools.get(&call.name) else {
                    self.record_tool_observation(
                        run_id,
                        &call,
                        None,
                        Err(ToolFailure {
                            kind: ToolFailureKind::UnknownTool,
                            message: "The requested tool is not in this run's frozen grant."
                                .to_owned(),
                            retryable: true,
                        }),
                        &mut checkpoint,
                        &mut last_sequence,
                    )?;
                    continue;
                };
                if tool.effect() == AgentToolEffect::Effect
                    && !authorization.approved_tool_calls.contains(&call.id)
                {
                    let normalized_arguments = match tool.normalize(call.arguments.clone()) {
                        Ok(value) => value,
                        Err(error) => {
                            self.record_tool_observation(
                                run_id,
                                &call,
                                None,
                                Err(error),
                                &mut checkpoint,
                                &mut last_sequence,
                            )?;
                            continue;
                        }
                    };
                    let normalized_call = ToolCall {
                        arguments: normalized_arguments,
                        ..call.clone()
                    };
                    let digest = action_digest(&normalized_call.name, &normalized_call.arguments);
                    checkpoint.pending_tool = Some(normalized_call.clone());
                    checkpoint.pending_action_digest = Some(digest.clone());
                    let expires_at = approval_expiry()?;
                    checkpoint.pending_approval_expires_at = Some(expires_at.clone());
                    let approval = approval_request(&normalized_call, &digest, &expires_at);
                    self.storage.save_approval(
                        &normalized_call.id,
                        run_id,
                        &expires_at,
                        &approval,
                    )?;
                    last_sequence = self.append_event(
                        run_id,
                        "approval.requested",
                        json!({
                            "tool_call_id": normalized_call.id,
                            "tool": normalized_call.name,
                            "arguments": normalized_call.arguments,
                            "action_digest": digest,
                            "expires_at": expires_at,
                        }),
                    )?;
                    self.save_checkpoint(
                        run_id,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        last_sequence,
                    )?;
                    run = self.storage.transition_run(
                        run_id,
                        run.state_version,
                        "awaiting_approval",
                        Some(AgentStopReason::ApprovalRequired.as_str()),
                        &now()?,
                    )?;
                    return Ok(outcome(
                        &run,
                        &checkpoint,
                        AgentStopReason::ApprovalRequired,
                        None,
                    ));
                }
                let observation = self.invoke_tool(&call, cancellation.clone(), started).await;
                self.record_tool_observation(
                    run_id,
                    &call,
                    None,
                    observation,
                    &mut checkpoint,
                    &mut last_sequence,
                )?;
                if checkpoint.repairs > self.bounds.maximum_repairs {
                    return self.finish(
                        &mut run,
                        &checkpoint,
                        &mut expected_checkpoint_sequence,
                        &mut last_sequence,
                        AgentStopReason::RepairLimit,
                        None,
                    );
                }
                self.save_checkpoint(
                    run_id,
                    &checkpoint,
                    &mut expected_checkpoint_sequence,
                    last_sequence,
                )?;
            }
        }
    }

    fn claim_running(&self, run: &RunRecord) -> Result<RunRecord, AgentError> {
        if !matches!(
            run.state.as_str(),
            "proposed" | "retryable" | "awaiting_approval"
        ) {
            return Err(AgentError::AlreadyAdvancing);
        }
        self.storage
            .transition_run(
                run.run_id.as_str(),
                run.state_version,
                "running",
                None,
                &now()?,
            )
            .map_err(Into::into)
    }

    async fn invoke_tool(
        &self,
        call: &ToolCall,
        mut cancellation: watch::Receiver<bool>,
        started: Instant,
    ) -> Result<Value, ToolFailure> {
        let Some(tool) = self.tools.get(&call.name) else {
            return Err(ToolFailure {
                kind: ToolFailureKind::UnknownTool,
                message: "The requested tool is unavailable.".to_owned(),
                retryable: true,
            });
        };
        if !call.arguments.is_object() {
            return Err(ToolFailure {
                kind: ToolFailureKind::InvalidArguments,
                message: "Tool arguments must be one JSON object.".to_owned(),
                retryable: true,
            });
        }
        let remaining = self
            .bounds
            .maximum_wall_time_ms
            .saturating_sub(elapsed_millis(started));
        let invocation = tool.invoke(call.arguments.clone(), cancellation.clone());
        tokio::select! {
            biased;
            changed = cancellation.changed() => {
                let _ = changed;
                Err(ToolFailure {
                    kind: ToolFailureKind::Denied,
                    message: "The tool was cancelled before it completed.".to_owned(),
                    retryable: true,
                })
            }
            result = tokio::time::timeout(
                Duration::from_millis(remaining.max(1)),
                invocation,
            ) => match result {
                Ok(result) => result,
                Err(_) => Err(ToolFailure {
                    kind: ToolFailureKind::Timeout,
                    message: "The tool exceeded the run's remaining wall-clock budget.".to_owned(),
                    retryable: true,
                }),
            }
        }
    }

    async fn complete_model(
        &self,
        run_id: &str,
        messages: &[ChatMessage],
        maximum_output_tokens: u32,
        options: &ChatOptions,
        last_sequence: &mut i64,
    ) -> Result<ChatCompletion, ModelCallError> {
        let started = Instant::now();
        let Some(mut stream) = self
            .model
            .stream(messages, maximum_output_tokens, options)
            .await
            .map_err(ModelCallError::Provider)?
        else {
            return self
                .model
                .complete(messages, maximum_output_tokens, options)
                .await
                .map_err(ModelCallError::Provider);
        };
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut tool_calls = Vec::new();
        let mut finish_reason = None;
        let mut prompt_tokens = None;
        let mut completion_tokens = None;
        let mut total_tokens = None;
        let mut cost_usd_micros = None;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(ModelCallError::Provider)?;
            if !chunk.content.is_empty() {
                content.push_str(&chunk.content);
                *last_sequence = self
                    .append_event(run_id, "assistant.delta", json!({"content": chunk.content}))
                    .map_err(|_| ModelCallError::Storage)?;
            }
            if let Some(delta) = chunk.reasoning_content {
                reasoning.push_str(&delta);
            }
            if !chunk.tool_calls.is_empty() {
                tool_calls = chunk.tool_calls;
            }
            finish_reason = chunk.finish_reason.or(finish_reason);
            prompt_tokens = chunk.prompt_tokens.or(prompt_tokens);
            completion_tokens = chunk.completion_tokens.or(completion_tokens);
            total_tokens = chunk.total_tokens.or(total_tokens);
            cost_usd_micros = chunk.cost_usd_micros.or(cost_usd_micros);
        }
        Ok(ChatCompletion {
            content,
            tool_calls,
            reasoning_content: (!reasoning.is_empty()).then_some(reasoning),
            finish_reason,
            latency_ms: elapsed_millis(started),
            request_id: None,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cost_usd_micros,
        })
    }

    fn record_tool_observation(
        &self,
        run_id: &str,
        call: &ToolCall,
        action_digest: Option<&str>,
        observation: Result<Value, ToolFailure>,
        checkpoint: &mut AgentCheckpoint,
        last_sequence: &mut i64,
    ) -> Result<(), AgentError> {
        let (kind, content) = match observation {
            Ok(value) => ("tool.completed", json!({"ok": true, "result": value})),
            Err(error) => {
                checkpoint.repairs = checkpoint.repairs.saturating_add(1);
                (
                    "tool.failed",
                    json!({
                        "ok": false,
                        "error": {
                            "kind": error.kind,
                            "message": error.message,
                            "retryable": error.retryable,
                        }
                    }),
                )
            }
        };
        *last_sequence = self.append_event(
            run_id,
            kind,
            json!({
                "tool_call_id": call.id,
                "tool": call.name,
                "action_digest": action_digest,
                "observation": content,
            }),
        )?;
        checkpoint.messages.push(ChatMessage::tool_result(
            call.id.clone(),
            serde_json::to_string(&content).map_err(|_| AgentError::Storage)?,
        ));
        Ok(())
    }

    fn compact_if_needed(
        &self,
        run_id: &str,
        checkpoint: &mut AgentCheckpoint,
        last_sequence: &mut i64,
    ) -> Result<(), AgentError> {
        let tokens = estimate_chat_tokens(&checkpoint.messages).map_err(|_| AgentError::Storage)?;
        if tokens <= self.bounds.maximum_context_tokens || checkpoint.messages.len() <= 8 {
            return Ok(());
        }
        let split = checkpoint.messages.len().saturating_sub(6).max(2);
        let removed = checkpoint.messages[1..split].to_vec();
        let summary = removed
            .iter()
            .map(|message| {
                let excerpt = message.content.chars().take(240).collect::<String>();
                format!("{}: {excerpt}", message.role)
            })
            .collect::<Vec<_>>()
            .join("\n");
        checkpoint.messages.splice(
            1..split,
            [ChatMessage::text(
                "system",
                format!(
                    "Visible context compaction of {} contiguous earlier messages:\n{}",
                    removed.len(),
                    summary
                ),
            )],
        );
        checkpoint.compactions = checkpoint.compactions.saturating_add(1);
        *last_sequence = self.append_event(
            run_id,
            "context.compacted",
            json!({
                "removed_messages": removed.len(),
                "compaction": checkpoint.compactions,
                "history_remains_contiguous": true,
            }),
        )?;
        Ok(())
    }

    fn bound_reason(
        &self,
        checkpoint: &AgentCheckpoint,
        started: Instant,
    ) -> Option<AgentStopReason> {
        if checkpoint.iterations >= self.bounds.maximum_iterations {
            Some(AgentStopReason::IterationLimit)
        } else if checkpoint.repairs > self.bounds.maximum_repairs {
            Some(AgentStopReason::RepairLimit)
        } else if elapsed_millis(started) >= self.bounds.maximum_wall_time_ms {
            Some(AgentStopReason::WallTimeLimit)
        } else if checkpoint.total_tokens >= self.bounds.maximum_total_tokens {
            Some(AgentStopReason::TokenLimit)
        } else if checkpoint.cost_usd_micros >= self.bounds.maximum_cost_usd_micros {
            Some(AgentStopReason::CostLimit)
        } else {
            None
        }
    }

    fn usage_bound_reason(&self, checkpoint: &AgentCheckpoint) -> Option<AgentStopReason> {
        if checkpoint.total_tokens > self.bounds.maximum_total_tokens {
            Some(AgentStopReason::TokenLimit)
        } else if checkpoint.cost_usd_micros > self.bounds.maximum_cost_usd_micros {
            Some(AgentStopReason::CostLimit)
        } else {
            None
        }
    }

    fn finish(
        &self,
        run: &mut RunRecord,
        checkpoint: &AgentCheckpoint,
        expected_checkpoint_sequence: &mut Option<i64>,
        last_sequence: &mut i64,
        reason: AgentStopReason,
        output: Option<String>,
    ) -> Result<AgentOutcome, AgentError> {
        let state = match reason {
            AgentStopReason::Completed => "completed",
            AgentStopReason::Cancelled => "cancelled",
            AgentStopReason::ApprovalRequired => "awaiting_approval",
            AgentStopReason::ProviderUnavailable => "retryable",
            _ => "failed",
        };
        *last_sequence = self.append_event(
            &run.run_id,
            if reason == AgentStopReason::Completed {
                "run.completed"
            } else {
                "run.stopped"
            },
            json!({
                "state": state,
                "stop_reason": reason.as_str(),
                "iterations": checkpoint.iterations,
                "repairs": checkpoint.repairs,
                "total_tokens": checkpoint.total_tokens,
                "cost_usd_micros": checkpoint.cost_usd_micros,
                "assistant_output": output.as_deref().map(|value| value.chars().take(100_000).collect::<String>()),
            }),
        )?;
        self.save_checkpoint(
            &run.run_id,
            checkpoint,
            expected_checkpoint_sequence,
            *last_sequence,
        )?;
        *run = self.storage.transition_run(
            &run.run_id,
            run.state_version,
            state,
            Some(reason.as_str()),
            &now()?,
        )?;
        Ok(outcome(run, checkpoint, reason, output))
    }

    fn append_event(&self, run_id: &str, kind: &str, metadata: Value) -> Result<i64, AgentError> {
        let event_id = random_id("event")?;
        let occurred_at = now()?;
        Ok(self
            .storage
            .append_event(NewEvent {
                event_id: &event_id,
                run_id,
                occurred_at: &occurred_at,
                kind,
                metadata: &metadata,
            })?
            .sequence)
    }

    fn save_checkpoint(
        &self,
        run_id: &str,
        checkpoint: &AgentCheckpoint,
        expected: &mut Option<i64>,
        covered_sequence: i64,
    ) -> Result<(), AgentError> {
        let document = serde_json::to_value(checkpoint.redacted())
            .map_err(|_| AgentError::InvalidCheckpoint)?;
        self.storage
            .save_snapshot_cas(run_id, *expected, covered_sequence, &document)?;
        *expected = Some(covered_sequence);
        Ok(())
    }
}

fn action_digest(tool_name: &str, normalized_arguments: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    hasher.update([0]);
    if let Ok(document) = serde_json::to_vec(normalized_arguments) {
        hasher.update(document);
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn approval_expiry() -> Result<String, AgentError> {
    (OffsetDateTime::now_utc() + time::Duration::minutes(15))
        .format(&Rfc3339)
        .map_err(|_| AgentError::Storage)
}

fn approval_request(call: &ToolCall, digest: &str, expires_at: &str) -> Value {
    json!({
        "approval_id": call.id,
        "action_kind": call.name,
        "risk_class": "external_effect",
        "human_summary": format!("Allow `{}` with the reviewed normalized arguments?", call.name),
        "action_digest": digest,
        "canonical_scope": "single_tool_call",
        "resource_versions": {},
        "policy_version": "agent-tools-v1",
        "preview_ref": null,
        "nonce": call.id,
        "expires_at": expires_at,
    })
}

fn retryable_provider(error: &ProviderError) -> bool {
    matches!(
        error,
        ProviderError::RateLimited | ProviderError::Timeout | ProviderError::Unavailable
    )
}

fn provider_stop_reason(error: &ProviderError) -> AgentStopReason {
    match error {
        ProviderError::Authentication
        | ProviderError::CredentialMissing
        | ProviderError::InsufficientBalance => AgentStopReason::ProviderAuthentication,
        ProviderError::Configuration | ProviderError::PolicyDenied => {
            AgentStopReason::ProviderConfiguration
        }
        _ => AgentStopReason::ProviderUnavailable,
    }
}

fn outcome(
    run: &RunRecord,
    checkpoint: &AgentCheckpoint,
    stop_reason: AgentStopReason,
    output: Option<String>,
) -> AgentOutcome {
    AgentOutcome {
        run_id: run.run_id.clone(),
        state: run.state.clone(),
        stop_reason,
        output,
        iterations: checkpoint.iterations,
        repairs: checkpoint.repairs,
        total_tokens: checkpoint.total_tokens,
        cost_usd_micros: checkpoint.cost_usd_micros,
    }
}

fn elapsed_millis(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn now() -> Result<String, AgentError> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| AgentError::Storage)
}

fn random_id(prefix: &str) -> Result<String, AgentError> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| AgentError::Storage)?;
    let suffix = entropy
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("{prefix}-{suffix}"))
}
