//! Recovery, scheduling, evaluation, and bounded-delegation contracts.

use std::{
    collections::BTreeSet,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum Recurrence {
    OneShot {
        at: DateTime<Utc>,
    },
    Daily {
        hour: u8,
        minute: u8,
    },
    Weekly {
        weekday_monday_zero: u8,
        hour: u8,
        minute: u8,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MissedRunPolicy {
    Skip,
    CreateDraft,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, tag = "kind", rename_all = "snake_case")]
pub enum ScheduleJob {
    Deterministic {
        job: String,
    },
    ModelDraft {
        profile_id: String,
        requested_effect: Option<String>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleSpec {
    pub schedule_id: String,
    pub timezone: String,
    pub recurrence: Recurrence,
    pub missed_run_policy: MissedRunPolicy,
    pub job: ScheduleJob,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduleOccurrence {
    pub scheduled_at: DateTime<Utc>,
    pub local_date: NaiveDate,
    pub period_key: String,
    pub dst_adjusted: bool,
}

impl ScheduleSpec {
    pub fn new(
        schedule_id: impl Into<String>,
        timezone: impl Into<String>,
        recurrence: Recurrence,
        missed_run_policy: MissedRunPolicy,
        job: ScheduleJob,
    ) -> Result<Self, &'static str> {
        let schedule_id = schedule_id.into();
        let timezone = timezone.into();
        validate_text(&schedule_id, 256)?;
        validate_text(&timezone, 128)?;
        timezone
            .parse::<Tz>()
            .map_err(|_| "schedule timezone is invalid")?;
        validate_recurrence(&recurrence)?;
        match &job {
            ScheduleJob::Deterministic { job } => validate_text(job, 128)?,
            ScheduleJob::ModelDraft {
                profile_id,
                requested_effect,
            } => {
                validate_text(profile_id, 256)?;
                if requested_effect.is_some() {
                    return Err("model schedules may only create drafts");
                }
            }
        }
        Ok(Self {
            schedule_id,
            timezone,
            recurrence,
            missed_run_policy,
            job,
        })
    }

    pub fn due_between(
        &self,
        after: DateTime<Utc>,
        through: DateTime<Utc>,
    ) -> Result<Vec<ScheduleOccurrence>, &'static str> {
        if through <= after || through - after > Duration::days(370) {
            return Err("schedule query window is invalid");
        }
        let timezone = self
            .timezone
            .parse::<Tz>()
            .map_err(|_| "schedule timezone is invalid")?;
        if let Recurrence::OneShot { at } = self.recurrence {
            return Ok(if at > after && at <= through {
                vec![ScheduleOccurrence {
                    scheduled_at: at,
                    local_date: at.with_timezone(&timezone).date_naive(),
                    period_key: format!("{}:{}", self.schedule_id, at.timestamp()),
                    dst_adjusted: false,
                }]
            } else {
                Vec::new()
            });
        }
        let mut date = after.with_timezone(&timezone).date_naive();
        let last = through.with_timezone(&timezone).date_naive();
        let mut occurrences = Vec::new();
        while date <= last {
            if let Some((hour, minute)) = self.local_time_on(date) {
                let local = date.and_time(
                    NaiveTime::from_hms_opt(u32::from(hour), u32::from(minute), 0)
                        .ok_or("schedule local time is invalid")?,
                );
                let (scheduled_at, dst_adjusted) = resolve_local(timezone, local)?;
                if scheduled_at > after && scheduled_at <= through {
                    occurrences.push(ScheduleOccurrence {
                        scheduled_at,
                        local_date: date,
                        period_key: format!("{}:{}T{hour:02}{minute:02}", self.schedule_id, date),
                        dst_adjusted,
                    });
                }
            }
            date = date.succ_opt().ok_or("schedule date overflow")?;
        }
        Ok(occurrences)
    }

    pub fn next_after(
        &self,
        after: DateTime<Utc>,
    ) -> Result<Option<ScheduleOccurrence>, &'static str> {
        Ok(self
            .due_between(after, after + Duration::days(370))?
            .into_iter()
            .next())
    }

    fn local_time_on(&self, date: NaiveDate) -> Option<(u8, u8)> {
        match self.recurrence {
            Recurrence::Daily { hour, minute } => Some((hour, minute)),
            Recurrence::Weekly {
                weekday_monday_zero,
                hour,
                minute,
            } if date.weekday().num_days_from_monday() == u32::from(weekday_monday_zero) => {
                Some((hour, minute))
            }
            Recurrence::OneShot { .. } | Recurrence::Weekly { .. } => None,
        }
    }
}

fn validate_recurrence(recurrence: &Recurrence) -> Result<(), &'static str> {
    match recurrence {
        Recurrence::OneShot { .. } => Ok(()),
        Recurrence::Daily { hour, minute } | Recurrence::Weekly { hour, minute, .. }
            if *hour < 24 && *minute < 60 =>
        {
            if matches!(
                recurrence,
                Recurrence::Weekly {
                    weekday_monday_zero: 7..,
                    ..
                }
            ) {
                Err("weekly schedule weekday is invalid")
            } else {
                Ok(())
            }
        }
        _ => Err("schedule local time is invalid"),
    }
}

fn resolve_local(
    timezone: Tz,
    local: NaiveDateTime,
) -> Result<(DateTime<Utc>, bool), &'static str> {
    match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => Ok((value.with_timezone(&Utc), false)),
        LocalResult::Ambiguous(first, second) => Ok((first.min(second).with_timezone(&Utc), false)),
        LocalResult::None => {
            for minutes in 1..=180 {
                let adjusted = local + Duration::minutes(minutes);
                match timezone.from_local_datetime(&adjusted) {
                    LocalResult::Single(value) => return Ok((value.with_timezone(&Utc), true)),
                    LocalResult::Ambiguous(first, second) => {
                        return Ok((first.min(second).with_timezone(&Utc), true));
                    }
                    LocalResult::None => {}
                }
            }
            Err("schedule time could not be resolved across DST")
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointFile {
    pub relative_path: String,
    pub content_hash: String,
    pub byte_count: u64,
}

impl CheckpointFile {
    pub fn new(
        relative_path: impl Into<String>,
        content_hash: impl Into<String>,
        byte_count: u64,
    ) -> Result<Self, &'static str> {
        let relative_path = relative_path.into();
        let content_hash = content_hash.into();
        validate_relative_path(&relative_path)?;
        validate_hash(&content_hash)?;
        Ok(Self {
            relative_path,
            content_hash,
            byte_count,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CheckpointSpec {
    pub checkpoint_id: String,
    pub run_id: String,
    pub files: Vec<CheckpointFile>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RestoreSelection {
    Files(BTreeSet<String>),
    All,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RestorePreview {
    pub checkpoint_id: String,
    pub pre_rollback_checkpoint: String,
    pub files: Vec<CheckpointFile>,
}

impl CheckpointSpec {
    pub fn new(
        checkpoint_id: impl Into<String>,
        run_id: impl Into<String>,
        files: Vec<CheckpointFile>,
        maximum_files: usize,
        maximum_bytes: u64,
    ) -> Result<Self, &'static str> {
        let checkpoint_id = checkpoint_id.into();
        let run_id = run_id.into();
        validate_text(&checkpoint_id, 256)?;
        validate_text(&run_id, 256)?;
        if files.is_empty()
            || files.len() > maximum_files
            || files
                .iter()
                .try_fold(0_u64, |total, file| total.checked_add(file.byte_count))
                .is_none_or(|total| total > maximum_bytes)
        {
            return Err("checkpoint is outside its storage limits");
        }
        let paths = files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect::<BTreeSet<_>>();
        if paths.len() != files.len() {
            return Err("checkpoint paths must be unique");
        }
        Ok(Self {
            checkpoint_id,
            run_id,
            files,
        })
    }

    pub fn preview_restore(
        &self,
        selection: RestoreSelection,
        pre_rollback_checkpoint: Option<&str>,
    ) -> Result<RestorePreview, &'static str> {
        let pre_rollback_checkpoint =
            pre_rollback_checkpoint.ok_or("a pre-rollback checkpoint is required")?;
        validate_text(pre_rollback_checkpoint, 256)?;
        let files = match selection {
            RestoreSelection::All => self.files.clone(),
            RestoreSelection::Files(paths) => {
                if paths.is_empty() {
                    return Err("restore selection is empty");
                }
                let selected = self
                    .files
                    .iter()
                    .filter(|file| paths.contains(&file.relative_path))
                    .cloned()
                    .collect::<Vec<_>>();
                if selected.len() != paths.len() {
                    return Err("restore selection is outside the checkpoint");
                }
                selected
            }
        };
        Ok(RestorePreview {
            checkpoint_id: self.checkpoint_id.clone(),
            pre_rollback_checkpoint: pre_rollback_checkpoint.to_owned(),
            files,
        })
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BudgetGrant {
    pub model_turns: u32,
    pub tool_calls: u32,
    pub tokens: u64,
    pub wall_time_ms: u64,
}

impl BudgetGrant {
    fn is_subset_of(self, parent: Self) -> bool {
        self.model_turns <= parent.model_turns
            && self.tool_calls <= parent.tool_calls
            && self.tokens <= parent.tokens
            && self.wall_time_ms <= parent.wall_time_ms
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubtaskSpec {
    pub subtask_id: String,
    pub parent_run_id: String,
    pub depth: u8,
    pub source_refs: BTreeSet<String>,
    pub allowed_tools: BTreeSet<String>,
    pub budget: BudgetGrant,
    pub manifest_hash: String,
    pub can_approve_effects: bool,
    pub can_write_memory: bool,
    pub can_delegate: bool,
}

impl SubtaskSpec {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        subtask_id: impl Into<String>,
        parent_run_id: impl Into<String>,
        depth: u8,
        source_refs: BTreeSet<String>,
        allowed_tools: BTreeSet<String>,
        budget: BudgetGrant,
        parent_sources: &BTreeSet<String>,
        parent_tools: &BTreeSet<String>,
        parent_budget: BudgetGrant,
    ) -> Result<Self, &'static str> {
        let subtask_id = subtask_id.into();
        let parent_run_id = parent_run_id.into();
        validate_text(&subtask_id, 256)?;
        validate_text(&parent_run_id, 256)?;
        if depth != 1 {
            return Err("recursive delegation is disabled");
        }
        if !source_refs.is_subset(parent_sources)
            || !allowed_tools.is_subset(parent_tools)
            || !budget.is_subset_of(parent_budget)
        {
            return Err("subtask authority must be a subset of its parent");
        }
        if allowed_tools.iter().any(|tool| {
            tool.contains("write")
                || tool.contains("approve")
                || tool.contains("delegate")
                || tool.contains("memory")
        }) {
            return Err("subtasks cannot receive effects, approvals, memory, or delegation");
        }
        let manifest_hash = hash_parts([
            subtask_id.as_str(),
            parent_run_id.as_str(),
            &depth.to_string(),
            &source_refs.iter().cloned().collect::<Vec<_>>().join("\n"),
            &allowed_tools.iter().cloned().collect::<Vec<_>>().join("\n"),
            &format!(
                "{}:{}:{}:{}",
                budget.model_turns, budget.tool_calls, budget.tokens, budget.wall_time_ms
            ),
        ]);
        Ok(Self {
            subtask_id,
            parent_run_id,
            depth,
            source_refs,
            allowed_tools,
            budget,
            manifest_hash,
            can_approve_effects: false,
            can_write_memory: false,
            can_delegate: false,
        })
    }

    pub fn validate_result(&self, result: &ArtifactResult) -> Result<(), &'static str> {
        if result.subtask_id != self.subtask_id
            || result.manifest_hash != self.manifest_hash
            || !result.validated
        {
            return Err("subtask result is not bound to the frozen validated child");
        }
        validate_text(&result.artifact_kind, 128)?;
        validate_hash(&result.artifact_hash)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactResult {
    pub subtask_id: String,
    pub manifest_hash: String,
    pub artifact_kind: String,
    pub artifact_hash: String,
    pub validated: bool,
}

#[derive(Clone)]
pub struct ConcurrencyGate {
    maximum: usize,
    active: Arc<AtomicUsize>,
}

impl ConcurrencyGate {
    pub fn new(maximum: usize) -> Result<Self, &'static str> {
        if maximum == 0 || maximum > 64 {
            return Err("concurrency limit is invalid");
        }
        Ok(Self {
            maximum,
            active: Arc::new(AtomicUsize::new(0)),
        })
    }

    pub fn try_acquire(&self) -> Option<ConcurrencyLease> {
        let acquired = self
            .active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.maximum).then_some(active + 1)
            })
            .is_ok();
        acquired.then(|| ConcurrencyLease {
            active: Arc::clone(&self.active),
        })
    }
}

pub struct ConcurrencyLease {
    active: Arc<AtomicUsize>,
}

impl Drop for ConcurrencyLease {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EvaluationManifest {
    pub suite_id: String,
    pub model_ref: String,
    pub prompt_ref: String,
    pub skill_ref: String,
    pub tool_manifest_ref: String,
    pub policy_ref: String,
    pub fixture_ref: String,
    pub manifest_hash: String,
    pub public_export_includes_private_trajectory: bool,
}

impl EvaluationManifest {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        suite_id: impl Into<String>,
        model_ref: impl Into<String>,
        prompt_ref: impl Into<String>,
        skill_ref: impl Into<String>,
        tool_manifest_ref: impl Into<String>,
        policy_ref: impl Into<String>,
        fixture_ref: impl Into<String>,
    ) -> Result<Self, &'static str> {
        let values = [
            suite_id.into(),
            model_ref.into(),
            prompt_ref.into(),
            skill_ref.into(),
            tool_manifest_ref.into(),
            policy_ref.into(),
            fixture_ref.into(),
        ];
        for value in &values {
            validate_text(value, 512)?;
        }
        Ok(Self {
            suite_id: values[0].clone(),
            model_ref: values[1].clone(),
            prompt_ref: values[2].clone(),
            skill_ref: values[3].clone(),
            tool_manifest_ref: values[4].clone(),
            policy_ref: values[5].clone(),
            fixture_ref: values[6].clone(),
            manifest_hash: hash_parts(values.iter().map(String::as_str)),
            public_export_includes_private_trajectory: false,
        })
    }
}

fn validate_text(value: &str, maximum: usize) -> Result<(), &'static str> {
    if value.trim().is_empty() || value.len() > maximum || value.contains('\0') {
        Err("text is empty or outside its size limit")
    } else {
        Ok(())
    }
}

fn validate_hash(value: &str) -> Result<(), &'static str> {
    if value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("content hash must be a 64-character hexadecimal digest")
    }
}

fn validate_relative_path(value: &str) -> Result<(), &'static str> {
    validate_text(value, 1_024)?;
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        Err("checkpoint path must be relative and traversal-free")
    } else {
        Ok(())
    }
}

fn hash_parts<'a>(parts: impl IntoIterator<Item = &'a str>) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.len().to_be_bytes());
        hasher.update(part.as_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
