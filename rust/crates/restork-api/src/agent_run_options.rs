//! Validation for optional, per-run model controls.

use std::collections::BTreeSet;

use axum::{http::StatusCode, response::Response};
use restork_core::durable_loop::AgentBounds;
use restork_personal::{ProviderProfile, ReasoningEffort};
use serde::Deserialize;
use serde_json::Value;

use crate::{default_public_data_class, default_true, error::error_response};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct AgentRunCreate {
    pub(super) goal: String,
    pub(super) mode: String,
    pub(super) provider_profile_id: String,
    #[serde(default = "default_public_data_class")]
    pub(super) data_class: String,
    pub(super) bounds: Option<AgentBounds>,
    #[serde(default = "default_true")]
    pub(super) auto_start: bool,
    #[serde(default)]
    pub(super) allowed_tools: BTreeSet<String>,
    #[serde(default)]
    pub(super) skill_ids: Vec<String>,
    #[serde(default)]
    pub(super) reasoning_effort: Option<ReasoningEffort>,
}

pub(super) fn requested_reasoning_profile(
    profile: ProviderProfile,
    effort: Option<ReasoningEffort>,
) -> Result<ProviderProfile, Response> {
    match effort {
        Some(effort) => profile.with_reasoning(effort, None).map_err(|_| {
            error_response(
                StatusCode::UNPROCESSABLE_ENTITY,
                "the selected reasoning effort is not supported by this provider",
            )
        }),
        None => Ok(profile),
    }
}

pub(super) fn stored_reasoning_profile(
    profile: ProviderProfile,
    task_spec: &Value,
) -> Result<ProviderProfile, Response> {
    let Some(value) = task_spec
        .get("reasoning_effort")
        .filter(|value| !value.is_null())
    else {
        return Ok(profile);
    };
    let effort = serde_json::from_value::<ReasoningEffort>(value.clone()).map_err(|_| {
        error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "run reasoning effort is invalid",
        )
    })?;
    profile.with_reasoning(effort, None).map_err(|_| {
        error_response(
            StatusCode::UNPROCESSABLE_ENTITY,
            "run reasoning effort is not supported by this provider",
        )
    })
}

pub(super) fn insert_reasoning_effort(document: &mut Value, effort: Option<ReasoningEffort>) {
    if let Some(effort) = effort {
        document["reasoning_effort"] = serde_json::json!(effort);
    }
}
