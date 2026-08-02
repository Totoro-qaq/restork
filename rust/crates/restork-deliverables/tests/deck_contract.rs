use restork_deliverables::{
    DeliverableError,
    deck::{
        AssetRef, DeckAudience, DeckClaimDraft, DeckSpec, SlideDraft, SlideRole, SlideVisual,
        ThemeRef, VisualKind,
    },
    evidence::{EvidenceLedger, EvidenceSource, EvidenceSourceKind, FactDraft, FactKind, Period},
};
use time::OffsetDateTime;

fn hash(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn ledger() -> EvidenceLedger {
    let period = Period::new(
        OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
        OffsetDateTime::from_unix_timestamp(1_700_604_800).unwrap(),
        "Asia/Shanghai",
    )
    .unwrap();
    let source = EvidenceSource::verified(
        "artifact:1",
        EvidenceSourceKind::ValidatedArtifact,
        "artifact/1",
        hash('a'),
        None,
    )
    .unwrap();
    let fact = FactDraft::new(
        "fact:1",
        FactKind::Metric,
        "Latency fell by 20 percent.",
        ["artifact:1"],
    )
    .unwrap();
    EvidenceLedger::build(period, [source], [fact]).unwrap()
}

fn audience() -> DeckAudience {
    DeckAudience::new("engineering", "Architecture review", "expert").unwrap()
}

fn theme() -> ThemeRef {
    ThemeRef::new("restork-print", 2, hash('b')).unwrap()
}

#[test]
fn deck_derives_citations_and_outline_digest() {
    let claim = DeckClaimDraft::new("claim:1", "Latency improved", ["fact:1"]).unwrap();
    let asset = AssetRef::new(
        "asset:chart",
        hash('c'),
        "image/svg+xml",
        "assets/latency.svg",
    )
    .unwrap();
    let visual = SlideVisual::new(
        VisualKind::Chart,
        "Bar chart comparing latency before and after",
        Some("asset:chart"),
    )
    .unwrap();
    let slide = SlideDraft::new(
        "slide:1",
        SlideRole::Chart,
        "Latency is lower",
        ["claim:1"],
        [],
        [visual],
    )
    .unwrap();

    let deck = DeckSpec::build(
        "deck:1",
        3,
        "en-US",
        audience(),
        theme(),
        &ledger(),
        [asset],
        [claim],
        [slide],
    )
    .unwrap();

    assert_eq!(deck.slides()[0].citation_refs(), &["artifact:1"]);
    assert_eq!(deck.outline_digest().len(), 64);
    assert_eq!(deck.spec_hash().len(), 64);
}

#[test]
fn a_visual_requires_nonempty_alt_text() {
    let error = SlideVisual::new(VisualKind::Image, "  ", None).unwrap_err();
    assert!(matches!(error, DeliverableError::EmptyField("alt_text")));
}

#[test]
fn deck_rejects_traversing_asset_paths() {
    let error =
        AssetRef::new("asset:1", hash('c'), "image/png", "../private/avatar.png").unwrap_err();

    assert!(matches!(error, DeliverableError::UnsafeLocalReference(_)));
}
