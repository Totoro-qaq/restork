use restork_deliverables::{
    DeliverableError,
    approval::{ApprovalAction, ApprovalBinding, ExportFormat, ExportManifest},
};
use time::OffsetDateTime;

fn hash(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

#[test]
fn outline_approval_binds_revision_ledger_spec_policy_and_nonce() {
    let left = ApprovalBinding::deck_outline_with_nonce(
        "deck:1",
        4,
        &hash('a'),
        &hash('b'),
        "policy:v2",
        [7; 32],
    )
    .unwrap();
    let changed = ApprovalBinding::deck_outline_with_nonce(
        "deck:1",
        5,
        &hash('a'),
        &hash('b'),
        "policy:v2",
        [7; 32],
    )
    .unwrap();

    assert_eq!(left.action(), ApprovalAction::DeckOutlineFreeze);
    assert_ne!(left.digest(), changed.digest());
}

#[test]
fn export_approval_binds_reproducibility_manifest_and_artifact() {
    let manifest = ExportManifest::new(
        "export:1",
        "deck:1",
        4,
        ExportFormat::Pptx,
        hash('a'),
        hash('b'),
        "renderer:local",
        "1.2.0",
        hash('c'),
        hash('d'),
        hash('e'),
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
    )
    .unwrap();
    let binding = ApprovalBinding::deck_export_with_nonce(&manifest, "policy:v2", [3; 32]).unwrap();

    assert_eq!(binding.action(), ApprovalAction::DeckExport);
    assert_eq!(binding.resources()["artifact"], hash('a'));
    assert_eq!(binding.resources()["reproducibility_manifest"], hash('d'));
    assert_eq!(binding.resources()["outline_approval"], hash('e'));
}

#[test]
fn report_write_target_must_stay_inside_the_selected_root() {
    let error = ApprovalBinding::report_write_with_nonce(
        "report:1",
        1,
        &hash('a'),
        &hash('b'),
        "../vault/private.md",
        None,
        "policy:v1",
        [1; 32],
    )
    .unwrap_err();

    assert!(matches!(error, DeliverableError::UnsafeLocalReference(_)));
}
