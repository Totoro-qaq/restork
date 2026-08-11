use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::{
    DeliverableError, Result,
    evidence::{EvidenceLedger, VerificationState, collect_unique_ids, validate_id_slice},
    hash::{canonical_hash, domain_hash},
    safety::{
        validate_hash, validate_id, validate_language_tag, validate_nonempty_text,
        validate_safe_relative_path,
    },
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ThemeLayout {
    Editorial,
    Minimal,
    Spotlight,
    Research,
    Narrative,
    Blueprint,
}

/// A frozen, renderer-safe copy of a user-created presentation theme.
///
/// Only bounded text, six-digit RGB colors and one of Restork's built-in
/// layouts are accepted. The snapshot deliberately cannot refer to files,
/// fonts, scripts, remote assets or host applications.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeSnapshot {
    theme_id: String,
    version: u64,
    name: String,
    background: String,
    foreground: String,
    muted: String,
    accent: String,
    accent_secondary: String,
    layout: ThemeLayout,
}

impl ThemeSnapshot {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        theme_id: impl Into<String>,
        version: u64,
        name: impl Into<String>,
        background: impl Into<String>,
        foreground: impl Into<String>,
        muted: impl Into<String>,
        accent: impl Into<String>,
        accent_secondary: impl Into<String>,
        layout: ThemeLayout,
    ) -> Result<Self> {
        let theme_id = theme_id.into();
        validate_id("theme_id", &theme_id)?;
        if version == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        let name = name.into();
        validate_nonempty_text("theme_name", &name)?;
        if name.len() > 120 {
            return Err(DeliverableError::InvalidIdentifier {
                field: "theme_name",
                value: "theme name exceeds the safe contract boundary".to_owned(),
            });
        }
        let background = normalized_rgb(background.into())?;
        let foreground = normalized_rgb(foreground.into())?;
        let muted = normalized_rgb(muted.into())?;
        let accent = normalized_rgb(accent.into())?;
        let accent_secondary = normalized_rgb(accent_secondary.into())?;
        Ok(Self {
            theme_id,
            version,
            name,
            background,
            foreground,
            muted,
            accent,
            accent_secondary,
            layout,
        })
    }

    pub fn content_hash(&self) -> Result<String> {
        let canonical = canonical_hash(self)?;
        Ok(domain_hash("restork.presentation-theme.v1", &[&canonical]))
    }

    #[must_use]
    pub fn theme_id(&self) -> &str {
        &self.theme_id
    }
    #[must_use]
    pub const fn version(&self) -> u64 {
        self.version
    }
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }
    #[must_use]
    pub fn background(&self) -> &str {
        &self.background
    }
    #[must_use]
    pub fn foreground(&self) -> &str {
        &self.foreground
    }
    #[must_use]
    pub fn muted(&self) -> &str {
        &self.muted
    }
    #[must_use]
    pub fn accent(&self) -> &str {
        &self.accent
    }
    #[must_use]
    pub fn accent_secondary(&self) -> &str {
        &self.accent_secondary
    }
    #[must_use]
    pub const fn layout(&self) -> ThemeLayout {
        self.layout
    }
}

fn normalized_rgb(value: String) -> Result<String> {
    let value = value.trim().trim_start_matches('#').to_ascii_uppercase();
    if value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(value)
    } else {
        Err(DeliverableError::InvalidIdentifier {
            field: "theme_color",
            value: "theme colors must be six-digit RGB values".to_owned(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeckAudience {
    audience_id: String,
    purpose: String,
    expertise: String,
}

impl DeckAudience {
    pub fn new(
        audience_id: impl Into<String>,
        purpose: impl Into<String>,
        expertise: impl Into<String>,
    ) -> Result<Self> {
        let audience_id = audience_id.into();
        validate_id("audience_id", &audience_id)?;
        let purpose = purpose.into();
        validate_nonempty_text("purpose", &purpose)?;
        let expertise = expertise.into();
        validate_nonempty_text("expertise", &expertise)?;
        Ok(Self {
            audience_id,
            purpose,
            expertise,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeRef {
    theme_id: String,
    version: u64,
    content_hash: String,
}

impl ThemeRef {
    pub fn new(
        theme_id: impl Into<String>,
        version: u64,
        content_hash: impl Into<String>,
    ) -> Result<Self> {
        let theme_id = theme_id.into();
        validate_id("theme_id", &theme_id)?;
        if version == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        let content_hash = content_hash.into();
        validate_hash("theme_content_hash", &content_hash)?;
        Ok(Self {
            theme_id,
            version,
            content_hash,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssetRef {
    asset_id: String,
    content_hash: String,
    media_type: String,
    local_ref: String,
}

impl AssetRef {
    pub fn new(
        asset_id: impl Into<String>,
        content_hash: impl Into<String>,
        media_type: impl Into<String>,
        local_ref: impl Into<String>,
    ) -> Result<Self> {
        let asset_id = asset_id.into();
        validate_id("asset_id", &asset_id)?;
        let content_hash = content_hash.into();
        validate_hash("asset_content_hash", &content_hash)?;
        let media_type = media_type.into();
        validate_media_type(&media_type)?;
        let local_ref = local_ref.into();
        validate_safe_relative_path(&local_ref)?;
        Ok(Self {
            asset_id,
            content_hash,
            media_type,
            local_ref,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeckClaimDraft {
    claim_id: String,
    text: String,
    fact_refs: Vec<String>,
}

impl DeckClaimDraft {
    pub fn new<I, S>(
        claim_id: impl Into<String>,
        text: impl Into<String>,
        fact_refs: I,
    ) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let claim_id = claim_id.into();
        validate_id("claim_id", &claim_id)?;
        let text = text.into();
        validate_nonempty_text("claim_text", &text)?;
        let fact_refs = collect_unique_ids("fact_ref", fact_refs)?;
        if fact_refs.is_empty() {
            return Err(DeliverableError::EmptyField("fact_refs"));
        }
        Ok(Self {
            claim_id,
            text,
            fact_refs,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeckClaim {
    claim_id: String,
    text: String,
    fact_refs: Vec<String>,
    citation_refs: Vec<String>,
    verification: VerificationState,
}

impl DeckClaim {
    #[must_use]
    pub fn claim_id(&self) -> &str {
        &self.claim_id
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VisualKind {
    Image,
    Chart,
    Table,
    Diagram,
    Formula,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SlideVisual {
    kind: VisualKind,
    alt_text: String,
    asset_ref: Option<String>,
}

impl SlideVisual {
    pub fn new(
        kind: VisualKind,
        alt_text: impl Into<String>,
        asset_ref: Option<&str>,
    ) -> Result<Self> {
        let alt_text = alt_text.into();
        validate_nonempty_text("alt_text", &alt_text)?;
        let asset_ref = asset_ref.map(str::to_owned);
        if let Some(asset_id) = &asset_ref {
            validate_id("asset_ref", asset_id)?;
        }
        Ok(Self {
            kind,
            alt_text,
            asset_ref,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeakerNoteDraft {
    text: String,
    fact_refs: Vec<String>,
}

impl SpeakerNoteDraft {
    pub fn new<I, S>(text: impl Into<String>, fact_refs: I) -> Result<Self>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        let text = text.into();
        validate_nonempty_text("speaker_note", &text)?;
        let fact_refs = collect_unique_ids("fact_ref", fact_refs)?;
        if fact_refs.is_empty() {
            return Err(DeliverableError::EmptyField("fact_refs"));
        }
        Ok(Self { text, fact_refs })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SpeakerNote {
    text: String,
    fact_refs: Vec<String>,
    citation_refs: Vec<String>,
    verification: VerificationState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SlideRole {
    Title,
    Agenda,
    Section,
    Evidence,
    Comparison,
    Timeline,
    Architecture,
    Chart,
    Table,
    Image,
    Formula,
    Conclusion,
    Appendix,
}

impl SlideRole {
    const fn requires_claims(self) -> bool {
        matches!(
            self,
            Self::Evidence
                | Self::Comparison
                | Self::Timeline
                | Self::Architecture
                | Self::Chart
                | Self::Table
                | Self::Formula
                | Self::Conclusion
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SlideDraft {
    slide_id: String,
    role: SlideRole,
    action_title: String,
    claim_refs: Vec<String>,
    speaker_notes: Vec<SpeakerNoteDraft>,
    visuals: Vec<SlideVisual>,
}

impl SlideDraft {
    pub fn new<C, S, N, V>(
        slide_id: impl Into<String>,
        role: SlideRole,
        action_title: impl Into<String>,
        claim_refs: C,
        speaker_notes: N,
        visuals: V,
    ) -> Result<Self>
    where
        C: IntoIterator<Item = S>,
        S: Into<String>,
        N: IntoIterator<Item = SpeakerNoteDraft>,
        V: IntoIterator<Item = SlideVisual>,
    {
        let slide_id = slide_id.into();
        validate_id("slide_id", &slide_id)?;
        let action_title = action_title.into();
        validate_nonempty_text("action_title", &action_title)?;
        let claim_refs = collect_unique_ids("claim_ref", claim_refs)?;
        if role.requires_claims() && claim_refs.is_empty() {
            return Err(DeliverableError::MissingClaims(slide_id));
        }
        Ok(Self {
            slide_id,
            role,
            action_title,
            claim_refs,
            speaker_notes: speaker_notes.into_iter().collect(),
            visuals: visuals.into_iter().collect(),
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Slide {
    slide_id: String,
    role: SlideRole,
    action_title: String,
    claim_refs: Vec<String>,
    citation_refs: Vec<String>,
    speaker_notes: Vec<SpeakerNote>,
    visuals: Vec<SlideVisual>,
}

impl Slide {
    #[must_use]
    pub fn citation_refs(&self) -> &[String] {
        &self.citation_refs
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DeckSpec {
    deck_id: String,
    revision: u64,
    language: String,
    audience: DeckAudience,
    theme: ThemeRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    theme_snapshot: Option<ThemeSnapshot>,
    ledger_hash: String,
    assets: BTreeMap<String, AssetRef>,
    claims: BTreeMap<String, DeckClaim>,
    slides: Vec<Slide>,
    spec_hash: String,
    outline_digest: String,
}

impl DeckSpec {
    #[allow(clippy::too_many_arguments)]
    pub fn build<A, C, S>(
        deck_id: impl Into<String>,
        revision: u64,
        language: impl Into<String>,
        audience: DeckAudience,
        theme: ThemeRef,
        ledger: &EvidenceLedger,
        assets: A,
        claims: C,
        slides: S,
    ) -> Result<Self>
    where
        A: IntoIterator<Item = AssetRef>,
        C: IntoIterator<Item = DeckClaimDraft>,
        S: IntoIterator<Item = SlideDraft>,
    {
        Self::build_with_theme_snapshot(
            deck_id, revision, language, audience, theme, None, ledger, assets, claims, slides,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn build_with_theme_snapshot<A, C, S>(
        deck_id: impl Into<String>,
        revision: u64,
        language: impl Into<String>,
        audience: DeckAudience,
        theme: ThemeRef,
        theme_snapshot: Option<ThemeSnapshot>,
        ledger: &EvidenceLedger,
        assets: A,
        claims: C,
        slides: S,
    ) -> Result<Self>
    where
        A: IntoIterator<Item = AssetRef>,
        C: IntoIterator<Item = DeckClaimDraft>,
        S: IntoIterator<Item = SlideDraft>,
    {
        if let Some(snapshot) = &theme_snapshot
            && (snapshot.theme_id != theme.theme_id
                || snapshot.version != theme.version
                || snapshot.content_hash()? != theme.content_hash)
        {
            return Err(DeliverableError::InvalidHash("theme_content_hash"));
        }
        let deck_id = deck_id.into();
        validate_id("deck_id", &deck_id)?;
        if revision == 0 {
            return Err(DeliverableError::InvalidRevision);
        }
        let language = language.into();
        validate_language_tag(&language)?;
        let assets = asset_map(assets)?;
        let claims = claim_map(claims, ledger)?;
        if claims.is_empty() {
            return Err(DeliverableError::EmptyField("claims"));
        }
        let slides = resolve_slides(slides, &claims, &assets, ledger)?;
        if slides.is_empty() {
            return Err(DeliverableError::EmptyField("slides"));
        }

        let ledger_hash = ledger.ledger_hash().to_owned();
        let canonical = canonical_hash(&(
            &deck_id,
            revision,
            &language,
            &audience,
            &theme,
            &theme_snapshot,
            &ledger_hash,
            &assets,
            &claims,
            &slides,
        ))?;
        let spec_hash = domain_hash("restork.deck-spec.v1", &[&canonical]);
        let outline_digest = domain_hash(
            "restork.deck.outline.v1",
            &[&deck_id, &revision.to_string(), &spec_hash, &ledger_hash],
        );
        Ok(Self {
            deck_id,
            revision,
            language,
            audience,
            theme,
            theme_snapshot,
            ledger_hash,
            assets,
            claims,
            slides,
            spec_hash,
            outline_digest,
        })
    }

    #[must_use]
    pub fn deck_id(&self) -> &str {
        &self.deck_id
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
    pub fn slides(&self) -> &[Slide] {
        &self.slides
    }

    #[must_use]
    pub fn spec_hash(&self) -> &str {
        &self.spec_hash
    }

    #[must_use]
    pub fn outline_digest(&self) -> &str {
        &self.outline_digest
    }
}

fn asset_map(assets: impl IntoIterator<Item = AssetRef>) -> Result<BTreeMap<String, AssetRef>> {
    let mut output = BTreeMap::new();
    for asset in assets {
        let id = asset.asset_id.clone();
        if output.insert(id.clone(), asset).is_some() {
            return Err(DeliverableError::DuplicateId { kind: "asset", id });
        }
    }
    Ok(output)
}

fn claim_map(
    claims: impl IntoIterator<Item = DeckClaimDraft>,
    ledger: &EvidenceLedger,
) -> Result<BTreeMap<String, DeckClaim>> {
    let mut output = BTreeMap::new();
    for draft in claims {
        validate_id("claim_id", &draft.claim_id)?;
        validate_nonempty_text("claim_text", &draft.text)?;
        validate_id_slice("fact_ref", &draft.fact_refs, true)?;
        if output.contains_key(&draft.claim_id) {
            return Err(DeliverableError::DuplicateId {
                kind: "claim",
                id: draft.claim_id,
            });
        }
        let (verification, citation_refs) = ledger.resolve_fact_refs(&draft.fact_refs)?;
        if !verification.is_publishable() {
            return Err(DeliverableError::UnpublishableVerification {
                item_id: draft.claim_id,
                verification: verification.as_str(),
            });
        }
        let claim_id = draft.claim_id.clone();
        output.insert(
            claim_id,
            DeckClaim {
                claim_id: draft.claim_id,
                text: draft.text,
                fact_refs: draft.fact_refs,
                citation_refs,
                verification,
            },
        );
    }
    Ok(output)
}

fn resolve_slides(
    slides: impl IntoIterator<Item = SlideDraft>,
    claims: &BTreeMap<String, DeckClaim>,
    assets: &BTreeMap<String, AssetRef>,
    ledger: &EvidenceLedger,
) -> Result<Vec<Slide>> {
    let mut seen = BTreeSet::new();
    let mut output = Vec::new();
    for draft in slides {
        validate_id("slide_id", &draft.slide_id)?;
        validate_nonempty_text("action_title", &draft.action_title)?;
        validate_id_slice("claim_ref", &draft.claim_refs, draft.role.requires_claims())?;
        if !seen.insert(draft.slide_id.clone()) {
            return Err(DeliverableError::DuplicateId {
                kind: "slide",
                id: draft.slide_id,
            });
        }
        let mut citations = BTreeSet::new();
        for claim_id in &draft.claim_refs {
            let claim = claims
                .get(claim_id)
                .ok_or_else(|| DeliverableError::UnknownClaim(claim_id.clone()))?;
            citations.extend(claim.citation_refs.iter().cloned());
        }

        let mut speaker_notes = Vec::with_capacity(draft.speaker_notes.len());
        for note in draft.speaker_notes {
            validate_nonempty_text("speaker_note", &note.text)?;
            validate_id_slice("fact_ref", &note.fact_refs, true)?;
            let (verification, note_citations) = ledger.resolve_fact_refs(&note.fact_refs)?;
            if !verification.is_publishable() {
                return Err(DeliverableError::UnpublishableVerification {
                    item_id: draft.slide_id.clone(),
                    verification: verification.as_str(),
                });
            }
            citations.extend(note_citations.iter().cloned());
            speaker_notes.push(SpeakerNote {
                text: note.text,
                fact_refs: note.fact_refs,
                citation_refs: note_citations,
                verification,
            });
        }

        for visual in &draft.visuals {
            validate_nonempty_text("alt_text", &visual.alt_text)?;
            if let Some(asset_id) = &visual.asset_ref {
                validate_id("asset_ref", asset_id)?;
                if !assets.contains_key(asset_id) {
                    return Err(DeliverableError::UnknownAsset(asset_id.clone()));
                }
            }
        }

        output.push(Slide {
            slide_id: draft.slide_id,
            role: draft.role,
            action_title: draft.action_title,
            claim_refs: draft.claim_refs,
            citation_refs: citations.into_iter().collect(),
            speaker_notes,
            visuals: draft.visuals,
        });
    }
    Ok(output)
}

fn validate_media_type(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 127
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'+' | b'-' | b'.'))
        || !value.contains('/')
    {
        return Err(DeliverableError::InvalidIdentifier {
            field: "media_type",
            value: value.to_owned(),
        });
    }
    Ok(())
}
