use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};
use time::Duration;

use crate::{
    DeliverableError, Result,
    evidence::{EvidenceLedger, VerificationState, collect_unique_ids, validate_id_slice},
    hash::sha256_hex,
    safety::{markdown_escape, validate_id, validate_language_tag, validate_nonempty_text},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportKind {
    Daily,
    Weekly,
}

impl ReportKind {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportSection {
    Summary,
    Completed,
    Progress,
    Decisions,
    Blockers,
    Next,
    Notes,
}

impl ReportSection {
    const fn title(self) -> &'static str {
        match self {
            Self::Summary => "Summary",
            Self::Completed => "Completed",
            Self::Progress => "Progress",
            Self::Decisions => "Decisions",
            Self::Blockers => "Blockers",
            Self::Next => "Next",
            Self::Notes => "Notes",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportEntryDraft {
    entry_id: String,
    section: ReportSection,
    text: String,
    fact_refs: Vec<String>,
}

impl ReportEntryDraft {
    pub fn new<I, S>(
        entry_id: impl Into<String>,
        section: ReportSection,
        text: impl Into<String>,
        fact_refs: I,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let entry_id = entry_id.into();
        validate_id("entry_id", &entry_id)?;
        let text = text.into();
        validate_nonempty_text("text", &text)?;
        let fact_refs = collect_unique_ids("fact_ref", fact_refs)?;
        if fact_refs.is_empty() {
            return Err(DeliverableError::EmptyField("fact_refs"));
        }
        Ok(Self {
            entry_id,
            section,
            text,
            fact_refs,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportEntry {
    entry_id: String,
    section: ReportSection,
    text: String,
    fact_refs: Vec<String>,
    citation_refs: Vec<String>,
    verification: VerificationState,
}

impl ReportEntry {
    #[must_use]
    pub fn entry_id(&self) -> &str {
        &self.entry_id
    }

    #[must_use]
    pub fn fact_refs(&self) -> &[String] {
        &self.fact_refs
    }

    #[must_use]
    pub fn citation_refs(&self) -> &[String] {
        &self.citation_refs
    }

    #[must_use]
    pub const fn verification(&self) -> VerificationState {
        self.verification
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportArtifact {
    report_id: String,
    revision: u64,
    kind: ReportKind,
    title: String,
    language: String,
    ledger_hash: String,
    entries: Vec<ReportEntry>,
    markdown: String,
    markdown_hash: String,
}

impl ReportArtifact {
    #[allow(clippy::too_many_arguments)]
    pub fn build<I>(
        report_id: impl Into<String>,
        revision: u64,
        kind: ReportKind,
        title: impl Into<String>,
        language: impl Into<String>,
        ledger: &EvidenceLedger,
        entries: I,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = ReportEntryDraft>,
    {
        let report_id = report_id.into();
        validate_id("report_id", &report_id)?;
        if revision == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        validate_report_period(kind, ledger)?;
        let title = title.into();
        validate_nonempty_text("title", &title)?;
        let language = language.into();
        validate_language_tag(&language)?;

        let mut seen = BTreeSet::new();
        let mut resolved = Vec::new();
        for draft in entries {
            validate_id("entry_id", &draft.entry_id)?;
            validate_nonempty_text("text", &draft.text)?;
            validate_id_slice("fact_ref", &draft.fact_refs, true)?;
            if !seen.insert(draft.entry_id.clone()) {
                return Err(DeliverableError::DuplicateId {
                    kind: "entry",
                    id: draft.entry_id,
                });
            }
            let (verification, citation_refs) = ledger.resolve_fact_refs(&draft.fact_refs)?;
            if !verification.is_publishable() {
                return Err(DeliverableError::UnpublishableVerification {
                    item_id: draft.entry_id,
                    verification: verification.as_str(),
                });
            }
            resolved.push(ReportEntry {
                entry_id: draft.entry_id,
                section: draft.section,
                text: draft.text,
                fact_refs: draft.fact_refs,
                citation_refs,
                verification,
            });
        }
        if resolved.is_empty() {
            return Err(DeliverableError::EmptyField("entries"));
        }
        resolved.sort_by(|left, right| {
            (left.section, left.entry_id.as_str()).cmp(&(right.section, right.entry_id.as_str()))
        });

        let markdown = render_markdown(kind, &title, &language, ledger, &resolved)?;
        let markdown_hash = sha256_hex(markdown.as_bytes());
        Ok(Self {
            report_id,
            revision,
            kind,
            title,
            language,
            ledger_hash: ledger.ledger_hash().to_owned(),
            entries: resolved,
            markdown,
            markdown_hash,
        })
    }

    #[must_use]
    pub fn report_id(&self) -> &str {
        &self.report_id
    }

    #[must_use]
    pub const fn revision(&self) -> u64 {
        self.revision
    }

    #[must_use]
    pub fn ledger_hash(&self) -> &str {
        &self.ledger_hash
    }

    #[must_use]
    pub fn entries(&self) -> &[ReportEntry] {
        &self.entries
    }

    #[must_use]
    pub fn markdown(&self) -> &str {
        &self.markdown
    }

    #[must_use]
    pub fn markdown_hash(&self) -> &str {
        &self.markdown_hash
    }
}

fn validate_report_period(kind: ReportKind, ledger: &EvidenceLedger) -> Result<()> {
    let duration = ledger.period().duration();
    let maximum = match kind {
        ReportKind::Daily => Duration::hours(26),
        ReportKind::Weekly => Duration::hours(194),
    };
    if duration <= Duration::ZERO || duration > maximum {
        return Err(DeliverableError::InvalidReportPeriod);
    }
    Ok(())
}

fn render_markdown(
    kind: ReportKind,
    title: &str,
    language: &str,
    ledger: &EvidenceLedger,
    entries: &[ReportEntry],
) -> Result<String> {
    let period = ledger.period();
    let mut output = String::new();
    output.push_str("# ");
    output.push_str(&markdown_escape(title));
    output.push_str("\n\n");
    output.push_str("> kind: ");
    output.push_str(kind.as_str());
    output.push_str(" | language: ");
    output.push_str(&markdown_escape(language));
    output.push_str(" | timezone: ");
    output.push_str(&markdown_escape(period.timezone()));
    output.push_str(" | start: ");
    output.push_str(&period.start().unix_timestamp().to_string());
    output.push_str(" | end-exclusive: ");
    output.push_str(&period.end_exclusive().unix_timestamp().to_string());
    output.push_str("\n\n");

    let sections = [
        ReportSection::Summary,
        ReportSection::Completed,
        ReportSection::Progress,
        ReportSection::Decisions,
        ReportSection::Blockers,
        ReportSection::Next,
        ReportSection::Notes,
    ];
    for section in sections {
        let matching: Vec<_> = entries
            .iter()
            .filter(|entry| entry.section == section)
            .collect();
        if matching.is_empty() {
            continue;
        }
        output.push_str("## ");
        output.push_str(section.title());
        output.push_str("\n\n");
        for entry in matching {
            output.push_str("- ");
            output.push_str(&markdown_escape(&entry.text));
            output.push_str(" — **");
            output.push_str(entry.verification.as_str());
            output.push_str("**");
            for fact_id in &entry.fact_refs {
                output.push_str(" [^");
                output.push_str(fact_id);
                output.push(']');
            }
            output.push('\n');
        }
        output.push('\n');
    }

    output.push_str("## Evidence\n\n");
    let referenced_facts: BTreeSet<_> = entries
        .iter()
        .flat_map(|entry| entry.fact_refs.iter())
        .collect();
    for fact_id in referenced_facts {
        let fact = ledger
            .fact(fact_id)
            .ok_or_else(|| DeliverableError::UnknownFact((*fact_id).clone()))?;
        output.push_str("[^");
        output.push_str(fact_id);
        output.push_str("]: ");
        output.push_str(&markdown_escape(fact.statement()));
        output.push_str(" — ");
        output.push_str(fact.verification().as_str());
        output.push_str("; sources: ");
        for (index, source_id) in fact.source_refs().iter().enumerate() {
            if index > 0 {
                output.push_str(", ");
            }
            output.push('`');
            output.push_str(source_id);
            output.push('`');
        }
        output.push('\n');
    }
    Ok(output)
}
