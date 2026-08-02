use restork_deliverables::{
    DeliverableError,
    evidence::{EvidenceLedger, EvidenceSource, EvidenceSourceKind, FactDraft, FactKind, Period},
    report::{ReportArtifact, ReportEntryDraft, ReportKind, ReportSection},
};
use time::OffsetDateTime;

fn hash(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn ledger() -> EvidenceLedger {
    let period = Period::new(
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        OffsetDateTime::from_unix_timestamp(1_700_086_400).unwrap(),
        "Asia/Shanghai",
    )
    .unwrap();
    let verified = EvidenceSource::verified(
        "run:1",
        EvidenceSourceKind::RunEvent,
        "run/1",
        hash('a'),
        None,
    )
    .unwrap();
    let self_asserted =
        EvidenceSource::self_asserted("user:1", "session/1", hash('b'), None).unwrap();
    let facts = [
        FactDraft::new(
            "fact:done",
            FactKind::Completion,
            "Core tests pass.",
            ["run:1"],
        )
        .unwrap(),
        FactDraft::new(
            "fact:plan",
            FactKind::Plan,
            "Ship after review.",
            ["user:1"],
        )
        .unwrap(),
    ];
    EvidenceLedger::build(period, [verified, self_asserted], facts).unwrap()
}

#[test]
fn report_markdown_is_deterministic_cited_and_escaped() {
    let entries = [
        ReportEntryDraft::new(
            "entry:1",
            ReportSection::Completed,
            "Closed <script>alert(1)</script> [link](https://bad.test) \u{202e}hidden",
            ["fact:done"],
        )
        .unwrap(),
        ReportEntryDraft::new(
            "entry:2",
            ReportSection::Next,
            "Ship after approval",
            ["fact:plan"],
        )
        .unwrap(),
    ];

    let first = ReportArtifact::build(
        "report:1",
        1,
        ReportKind::Daily,
        "Daily <status>",
        "en-US",
        &ledger(),
        entries.clone(),
    )
    .unwrap();
    let second = ReportArtifact::build(
        "report:1",
        1,
        ReportKind::Daily,
        "Daily <status>",
        "en-US",
        &ledger(),
        entries,
    )
    .unwrap();

    assert_eq!(first.markdown(), second.markdown());
    assert_eq!(first.markdown_hash(), second.markdown_hash());
    assert!(!first.markdown().contains("<script>"));
    assert!(!first.markdown().contains("](https://"));
    assert!(!first.markdown().contains('\u{202e}'));
    assert!(first.markdown().contains("[^fact:done]"));
    assert!(first.markdown().contains("self-asserted"));
}

#[test]
fn report_rejects_unknown_fact_references() {
    let entry = ReportEntryDraft::new(
        "entry:1",
        ReportSection::Progress,
        "Unknown claim",
        ["fact:missing"],
    )
    .unwrap();

    let error = ReportArtifact::build(
        "report:1",
        1,
        ReportKind::Daily,
        "Daily",
        "en-US",
        &ledger(),
        [entry],
    )
    .unwrap_err();

    assert!(matches!(error, DeliverableError::UnknownFact(_)));
}

#[test]
fn weekly_report_accepts_a_seven_day_evidence_period() {
    let period = Period::new(
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        OffsetDateTime::from_unix_timestamp(1_700_604_800).unwrap(),
        "Asia/Shanghai",
    )
    .unwrap();
    let source = EvidenceSource::observed(
        "git:week",
        EvidenceSourceKind::GitSummary,
        "git/week",
        hash('c'),
        None,
    )
    .unwrap();
    let fact = FactDraft::new(
        "fact:week",
        FactKind::Progress,
        "The feature moved forward.",
        ["git:week"],
    )
    .unwrap();
    let ledger = EvidenceLedger::build(period, [source], [fact]).unwrap();
    let entry = ReportEntryDraft::new(
        "entry:week",
        ReportSection::Progress,
        "The feature moved forward.",
        ["fact:week"],
    )
    .unwrap();

    let report = ReportArtifact::build(
        "report:week",
        1,
        ReportKind::Weekly,
        "Weekly report",
        "en-US",
        &ledger,
        [entry],
    )
    .unwrap();

    assert!(report.markdown().contains("kind: weekly"));
}

#[test]
fn stale_facts_cannot_be_published() {
    let period = Period::new(
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        OffsetDateTime::from_unix_timestamp(1_700_086_400).unwrap(),
        "Asia/Shanghai",
    )
    .unwrap();
    let source = EvidenceSource::stale(
        "vault:old",
        EvidenceSourceKind::VaultNote,
        "notes/old.md",
        hash('d'),
        None,
    )
    .unwrap();
    let fact = FactDraft::new(
        "fact:old",
        FactKind::Metric,
        "An old measurement.",
        ["vault:old"],
    )
    .unwrap();
    let ledger = EvidenceLedger::build(period, [source], [fact]).unwrap();
    let entry = ReportEntryDraft::new(
        "entry:old",
        ReportSection::Summary,
        "An old measurement.",
        ["fact:old"],
    )
    .unwrap();

    let error = ReportArtifact::build(
        "report:old",
        1,
        ReportKind::Daily,
        "Daily report",
        "en-US",
        &ledger,
        [entry],
    )
    .unwrap_err();

    assert!(matches!(
        error,
        DeliverableError::UnpublishableVerification { .. }
    ));
}
