use restork_deliverables::{
    DeliverableError,
    evidence::{
        EvidenceLedger, EvidenceSource, EvidenceSourceKind, FactDraft, FactKind, Period,
        VerificationState,
    },
};
use time::OffsetDateTime;

fn hash(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn period() -> Period {
    Period::new(
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        OffsetDateTime::from_unix_timestamp(1_700_086_400).unwrap(),
        "Asia/Shanghai",
    )
    .unwrap()
}

#[test]
fn verification_is_derived_from_the_weakest_source() {
    let sources = vec![
        EvidenceSource::verified(
            "run:1",
            EvidenceSourceKind::RunEvent,
            "run/1",
            hash('a'),
            None,
        )
        .unwrap(),
        EvidenceSource::observed(
            "vault:1",
            EvidenceSourceKind::VaultNote,
            "notes/day.md",
            hash('b'),
            None,
        )
        .unwrap(),
    ];
    let fact = FactDraft::new(
        "fact:1",
        FactKind::Progress,
        "The migration is in progress.",
        ["run:1", "vault:1"],
    )
    .unwrap();

    let ledger = EvidenceLedger::build(period(), sources, [fact]).unwrap();

    assert_eq!(
        ledger.fact("fact:1").unwrap().verification(),
        VerificationState::Observed
    );
}

#[test]
fn model_facing_fact_draft_has_no_verification_field() {
    let value = serde_json::json!({
        "fact_id": "fact:1",
        "kind": "progress",
        "statement": "Done",
        "source_refs": ["run:1"],
        "verification_state": "verified"
    });

    let error = serde_json::from_value::<FactDraft>(value).unwrap_err();
    assert!(error.to_string().contains("unknown field"));
}

#[test]
fn conversation_and_memory_cannot_ground_facts() {
    for kind in [EvidenceSourceKind::Conversation, EvidenceSourceKind::Memory] {
        let source =
            EvidenceSource::unverified("context:1", kind, "local-context", hash('c'), None)
                .unwrap();
        let fact = FactDraft::new(
            "fact:1",
            FactKind::Decision,
            "A remembered decision",
            ["context:1"],
        )
        .unwrap();

        let error = EvidenceLedger::build(period(), [source], [fact]).unwrap_err();
        assert!(matches!(
            error,
            DeliverableError::ForbiddenGroundingSource { .. }
        ));
    }
}

#[test]
fn a_caller_cannot_mark_a_vault_note_as_verified() {
    let error = EvidenceSource::verified(
        "vault:1",
        EvidenceSourceKind::VaultNote,
        "notes/day.md",
        hash('d'),
        None,
    )
    .unwrap_err();

    assert!(matches!(
        error,
        DeliverableError::InvalidSourceVerification { .. }
    ));
}

#[test]
fn ledger_hash_is_independent_of_input_order() {
    let a = EvidenceSource::verified(
        "run:a",
        EvidenceSourceKind::RunEvent,
        "run/a",
        hash('a'),
        None,
    )
    .unwrap();
    let b = EvidenceSource::observed(
        "git:b",
        EvidenceSourceKind::GitSummary,
        "git/b",
        hash('b'),
        None,
    )
    .unwrap();
    let first = FactDraft::new("fact:a", FactKind::Completion, "A", ["run:a"]).unwrap();
    let second = FactDraft::new("fact:b", FactKind::Progress, "B", ["git:b"]).unwrap();

    let left = EvidenceLedger::build(
        period(),
        [a.clone(), b.clone()],
        [first.clone(), second.clone()],
    )
    .unwrap();
    let right = EvidenceLedger::build(period(), [b, a], [second, first]).unwrap();

    assert_eq!(left.ledger_hash(), right.ledger_hash());
}
