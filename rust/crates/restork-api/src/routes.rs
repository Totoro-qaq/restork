//! Route composition for the loopback API.
//!
//! Handlers stay with their owning feature modules. This module is deliberately
//! limited to the public HTTP inventory, so adding a route does not make the
//! runtime state and boundary middleware harder to review.

use super::*;

pub(super) fn build_router(state: ApiState) -> Router {
    Router::new()
        .merge(system_routes())
        .merge(run_routes())
        .merge(knowledge_routes())
        .merge(mode_routes())
        .merge(daily_routes())
        .merge(configuration_routes())
        .merge(session_routes())
        .merge(extension_routes())
        .merge(automation_routes())
        .merge(deliverable_routes())
        .merge(dashboard_routes())
        .layer(axum::middleware::from_fn(
            http_middleware::local_browser_boundary,
        ))
        .with_state(state)
}

fn system_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/readiness", get(readiness))
        .route("/v1/schema", get(api_schema))
        .route("/v1/health", get(health))
        .route("/v1/bootstrap", get(bootstrap_workspace))
        .route("/v1/pair", axum::routing::post(pair_web))
        .route("/v1/cli/pair", axum::routing::post(pair_cli))
        .route("/v1/token/rotate", axum::routing::post(rotate_token))
        .route("/v1/token/resume", axum::routing::post(resume_web_token))
        .route("/v1/token/revoke", axum::routing::post(revoke_token))
}

fn run_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/runs", get(list_agent_runs).post(create_agent_run))
        .route("/v1/runs/{run_id}", get(get_agent_run))
        .route(
            "/v1/runs/{run_id}/advance",
            axum::routing::post(advance_agent_run),
        )
        .route(
            "/v1/runs/{run_id}/cancel",
            axum::routing::post(cancel_agent_run),
        )
        .route("/v1/runs/{run_id}/events", get(run_events))
        .route("/v1/runs/{run_id}/event-page", get(agent_event_page))
        .route(
            "/v1/runs/{run_id}/conversation",
            get(agent_conversation_page).post(create_agent_conversation),
        )
        .route(
            "/v1/runs/{run_id}/summary-suggestion",
            get(crate::memory_suggestion_api::get_run_summary_suggestion),
        )
        .route(
            "/v1/runs/{run_id}/summary-suggestion/accept",
            axum::routing::post(crate::memory_suggestion_api::accept_run_summary_suggestion),
        )
        .route(
            "/v1/runs/{run_id}/summary-suggestion/dismiss",
            axum::routing::post(crate::memory_suggestion_api::dismiss_run_summary_suggestion),
        )
        .route("/v1/approvals", get(list_feature_approvals))
        .route(
            "/v1/approvals/{approval_id}",
            axum::routing::post(decide_feature_approval),
        )
}

fn knowledge_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/memory", get(list_memory).post(create_memory))
        .route(
            "/v1/memory/{memory_id}",
            axum::routing::patch(correct_memory).delete(delete_memory),
        )
        .route("/v1/memory/export", axum::routing::post(export_memory))
        .route(
            "/v1/memory/purge-source",
            axum::routing::post(purge_memory_source),
        )
        .route("/v1/tasks", get(list_tasks))
        .route("/v1/tasks/local", axum::routing::post(create_local_todo))
        .route("/v1/tasks/local/deleted", get(list_deleted_local_todos))
        .route(
            "/v1/tasks/local/{task_id}",
            axum::routing::patch(update_local_todo).delete(delete_local_todo),
        )
        .route(
            "/v1/tasks/local/{task_id}/restore",
            axum::routing::post(restore_local_todo),
        )
        .route(
            "/v1/tasks/{task_id}/preview",
            axum::routing::post(preview_task_change),
        )
        .route(
            "/v1/tasks/quick-capture/preview",
            axum::routing::post(preview_task_capture),
        )
        .route(
            "/v1/tasks/approvals/{approval_id}/apply",
            axum::routing::post(apply_task_change),
        )
        .route("/v1/radar", get(list_radar))
        .route("/v1/radar/config", axum::routing::put(configure_radar))
        .route(
            "/v1/radar/{item_id}/action",
            axum::routing::post(radar_action),
        )
        .route("/v1/search", get(feature_api::search_workspace))
        .route("/v1/vault/files", get(vault_api::list_vault_notes))
        .route("/v1/vault/search", get(vault_api::search_vault_notes))
        .route("/v1/vault/note", get(vault_api::read_vault_note))
        .route("/v1/vault/events", get(vault_api::vault_events))
        .route(
            "/v1/tools/available",
            get(agent_tools::list_available_tools),
        )
}

fn mode_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/research/{run_id}", get(get_research_artifact))
        .route(
            "/v1/research/{run_id}/note/preview",
            axum::routing::post(preview_research_note),
        )
        .route(
            "/v1/study/runs/{run_id}/diagnostic",
            axum::routing::post(prepare_study),
        )
        .route(
            "/v1/study/runs/{run_id}/path",
            axum::routing::post(submit_study_path),
        )
        .route(
            "/v1/study/runs/{run_id}/exercises/{exercise_id}/attempt",
            axum::routing::post(submit_study_attempt),
        )
        .route(
            "/v1/study/runs/{run_id}/note/preview",
            axum::routing::post(preview_study_note),
        )
        .route(
            "/v1/work/runs/{run_id}/plan",
            axum::routing::post(plan_work),
        )
        .route(
            "/v1/work/runs/{run_id}/handoff/preview",
            axum::routing::post(preview_work_handoff),
        )
        .route(
            "/v1/work/runs/{run_id}/handoff/export",
            axum::routing::post(export_work_handoff),
        )
        .route(
            "/v1/work/runs/{run_id}/verify",
            axum::routing::post(verify_work),
        )
}

fn daily_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/daily/context", get(daily_context))
        .route("/v1/daily", get(read_daily_snapshot))
        .route(
            "/v1/daily/weather",
            axum::routing::post(configure_daily_weather),
        )
        .route(
            "/v1/daily/calendar",
            axum::routing::post(configure_daily_calendar),
        )
        .route(
            "/v1/daily/calendar/native",
            get(get_native_calendar_capability).delete(disconnect_native_calendar),
        )
        .route(
            "/v1/daily/calendar/native/connect",
            axum::routing::post(connect_daily_native_calendar),
        )
        .route(
            "/v1/daily/mail/native",
            get(get_native_mail_capability).delete(disconnect_native_mail),
        )
        .route(
            "/v1/daily/mail/native/connect",
            axum::routing::post(connect_daily_native_mail),
        )
        .route("/v1/daily/mail/events", get(daily_mail_events))
        .route(
            "/v1/daily/music",
            axum::routing::post(configure_daily_music),
        )
        .route("/v1/daily/music/sources", get(list_music_sources))
        .route(
            "/v1/daily/music/refresh",
            axum::routing::post(refresh_daily_music),
        )
        .route(
            "/v1/daily/music/research",
            axum::routing::post(research_daily_music),
        )
        .route("/v1/daily/music/cover", get(daily_music_cover))
}

fn configuration_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/settings/personal",
            get(get_personal_settings)
                .put(put_personal_settings)
                .delete(delete_personal_settings),
        )
        .route("/v1/providers", get(list_provider_registry))
        .route("/v1/provider-profiles", get(list_provider_profiles))
        .route(
            "/v1/provider-profiles/{provider_id}",
            axum::routing::put(put_provider_profile),
        )
        .route("/v1/providers/{provider_id}", get(get_provider_status))
        .route(
            "/v1/providers/{provider_id}/models",
            get(list_provider_models),
        )
        .route(
            "/v1/providers/{provider_id}/diagnostics",
            axum::routing::post(run_provider_diagnostic),
        )
        .route(
            "/v1/configuration-profiles",
            get(list_configuration_profiles),
        )
        .route(
            "/v1/configuration-profiles/{profile_id}",
            axum::routing::put(put_configuration_profile),
        )
        .route(
            "/v1/prompts/{prompt_id}",
            get(list_prompt_revisions).post(create_prompt_revision),
        )
        .route(
            "/v1/prompts/{prompt_id}/active",
            axum::routing::patch(activate_prompt_revision),
        )
}

fn session_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/sessions", get(list_sessions).post(create_session))
        .route("/v1/sessions/search", get(search_sessions))
        .route(
            "/v1/sessions/{session_id}/fork",
            axum::routing::post(fork_session),
        )
        .route(
            "/v1/sessions/{session_id}",
            get(get_session)
                .patch(archive_session)
                .delete(delete_session),
        )
        .route(
            "/v1/sessions/{session_id}/messages",
            get(list_session_messages).post(create_session_message),
        )
        .route(
            "/v1/sessions/{session_id}/turns",
            axum::routing::post(create_conversation_turn),
        )
        .route(
            "/v1/sessions/{session_id}/context-preview",
            axum::routing::post(create_context_preview),
        )
        .route("/v1/sessions/{session_id}/export", get(export_session))
        .route(
            "/v1/sessions/{session_id}/proposals",
            axum::routing::post(create_run_proposal),
        )
        .route(
            "/v1/operations/{operation_id}",
            get(get_conversation_operation),
        )
        .route(
            "/v1/operations/{operation_id}/events",
            get(conversation_operation_events),
        )
        .route(
            "/v1/operations/{operation_id}/cancel",
            axum::routing::post(cancel_conversation_operation),
        )
}

fn extension_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/extensions",
            get(list_extensions).post(install_extension),
        )
        .route(
            "/v1/extensions/{package_id}",
            get(get_extension).patch(change_extension_state),
        )
        .route(
            "/v1/extensions/{package_id}/revisions",
            get(list_extension_revisions),
        )
        .route(
            "/v1/extensions/{package_id}/rollback",
            axum::routing::post(rollback_extension),
        )
        .route(
            "/v1/sessions/{session_id}/tools/search",
            get(search_session_tools),
        )
        .route(
            "/v1/sessions/{session_id}/tools/{tool_id}",
            get(describe_session_tool),
        )
        .route(
            "/v1/sessions/{session_id}/tool-call-preview",
            axum::routing::post(preview_session_tool_call),
        )
        .route(
            "/v1/sessions/{session_id}/tool-calls",
            axum::routing::post(execute_session_tool_call),
        )
        .route(
            "/v1/tool-executions/{execution_id}",
            get(get_tool_execution),
        )
}

fn automation_routes() -> Router<ApiState> {
    Router::new()
        .route("/v1/schedules", get(list_schedules).post(create_schedule))
        .route("/v1/schedules/deleted", get(list_deleted_schedules))
        .route(
            "/v1/schedules/{schedule_id}",
            get(get_schedule)
                .put(update_schedule)
                .patch(change_schedule_state)
                .delete(delete_schedule),
        )
        .route(
            "/v1/schedules/{schedule_id}/run",
            axum::routing::post(run_schedule_now),
        )
        .route(
            "/v1/schedules/{schedule_id}/restore",
            axum::routing::post(restore_schedule),
        )
        .route("/v1/schedules/{schedule_id}/runs", get(list_schedule_runs))
}

fn deliverable_routes() -> Router<ApiState> {
    Router::new()
        .route(
            "/v1/deliverable-templates",
            get(list_presentation_templates).post(create_presentation_template),
        )
        .route(
            "/v1/deliverable-templates/deleted",
            get(list_deleted_presentation_templates),
        )
        .route(
            "/v1/deliverable-templates/{template_id}",
            axum::routing::put(update_presentation_template).delete(delete_presentation_template),
        )
        .route(
            "/v1/deliverable-templates/{template_id}/restore",
            axum::routing::post(restore_presentation_template),
        )
        .route("/v1/deliverables", get(list_deliverables))
        .route(
            "/v1/deliverables/reports",
            axum::routing::post(compose_report),
        )
        .route(
            "/v1/deliverables/reports/manual",
            axum::routing::post(compose_manual_report),
        )
        .route(
            "/v1/deliverables/reports/ai-draft",
            axum::routing::post(compose_ai_report),
        )
        .route("/v1/deliverables/decks", axum::routing::post(compose_deck))
        .route(
            "/v1/deliverables/decks/from-report",
            axum::routing::post(compose_deck_from_report),
        )
        .route(
            "/v1/deliverables/decks/draft",
            axum::routing::post(compose_deck_draft),
        )
        .route(
            "/v1/deliverables/{deliverable_id}/{revision}/render-preview",
            axum::routing::post(preview_deliverable_render),
        )
        .route(
            "/v1/deliverables/{deliverable_id}/{revision}/render",
            axum::routing::post(export_deliverable_render),
        )
        .route("/v1/checkpoints", axum::routing::post(create_checkpoint))
        .route("/v1/checkpoints/{checkpoint_id}", get(get_checkpoint))
        .route(
            "/v1/checkpoints/{checkpoint_id}/restore-preview",
            axum::routing::post(preview_restore),
        )
        .route(
            "/v1/checkpoints/{checkpoint_id}/restore",
            axum::routing::post(restore_checkpoint_files),
        )
        .route("/v1/evaluations", axum::routing::post(create_evaluation))
        .route("/v1/subtasks", axum::routing::post(create_subtask))
        .route(
            "/v1/subtasks/{subtask_id}",
            axum::routing::delete(cancel_subtask),
        )
        .route(
            "/v1/subtasks/{subtask_id}/execute",
            axum::routing::post(execute_subtask),
        )
}

fn dashboard_routes() -> Router<ApiState> {
    Router::new()
        .route("/", get(dashboard_index))
        .route("/{*path}", get(dashboard_asset))
}
