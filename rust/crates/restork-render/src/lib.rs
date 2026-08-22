//! Deterministic, dependency-light PPTX and PDF rendering for frozen DeckSpec JSON.
//!
//! The renderer accepts only the already validated deck artifact. It performs no
//! network, filesystem, process, template, macro, or secret access.

use restork_deliverables::deck::{ThemeLayout, ThemeSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use subsetter::{GlyphRemapper, Tag, subset_with_variations};
use ttf_parser::{Face, GlyphId};

const MAX_SLIDES: usize = 200;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const CJK_FONT: &[u8] = include_bytes!("../assets/fonts/NotoSansSC-wght.ttf");

/// A renderer-owned theme bundled into every Restork desktop build.
///
/// Themes contain colors and layout intent only. They never refer to remote
/// assets, host fonts, executables, or user-installed template packages.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderLayout {
    Editorial,
    Minimal,
    Spotlight,
    Research,
    Narrative,
    Blueprint,
    PptMasterApple,
    PptMasterJangpm,
    PptMasterMckinsey,
    PptMasterNaverIr,
}

impl RenderLayout {
    const fn is_ppt_master(self) -> bool {
        matches!(
            self,
            Self::PptMasterApple
                | Self::PptMasterJangpm
                | Self::PptMasterMckinsey
                | Self::PptMasterNaverIr
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct RenderTheme {
    pub theme_id: &'static str,
    pub version: u64,
    pub content_hash: &'static str,
    pub name_en: &'static str,
    pub name_zh: &'static str,
    pub description_en: &'static str,
    pub description_zh: &'static str,
    pub background: &'static str,
    pub foreground: &'static str,
    pub muted: &'static str,
    pub accent: &'static str,
    pub accent_secondary: &'static str,
    pub layout: RenderLayout,
}

const BUILTIN_THEMES: [RenderTheme; 10] = [
    RenderTheme {
        theme_id: "restork-print",
        version: 1,
        content_hash: "59719d41523c169b974f04cabba1c06cefb78617346c738bff8a89cbd0307907",
        name_en: "Letterpress",
        name_zh: "打字纸",
        description_en: "Warm paper, editorial headings, and calm review slides.",
        description_zh: "暖色纸张、编辑式标题，适合复盘与汇报。",
        background: "FBF7EF",
        foreground: "302A21",
        muted: "756B5D",
        accent: "6657D9",
        accent_secondary: "E84D8A",
        layout: RenderLayout::Editorial,
    },
    RenderTheme {
        theme_id: "restork-clarity",
        version: 1,
        content_hash: "f083ed7b3d465d3c6fb3f7f668daae21d44df22694eec60c71068576c1a24e35",
        name_en: "Clarity",
        name_zh: "清晰简报",
        description_en: "Clean white canvas with restrained cobalt emphasis.",
        description_zh: "留白清楚、钴蓝强调，适合正式简报。",
        background: "F8FAFC",
        foreground: "172033",
        muted: "64748B",
        accent: "2563EB",
        accent_secondary: "06B6D4",
        layout: RenderLayout::Minimal,
    },
    RenderTheme {
        theme_id: "restork-midnight",
        version: 1,
        content_hash: "75bb59e39da2663fff0139bb8c023fc535ba053a0271e31b647a9f4c5bb36caf",
        name_en: "Midnight",
        name_zh: "深夜演示",
        description_en: "Dark stage with violet and cyan highlights.",
        description_zh: "深色舞台配紫青高光，适合演讲与展示。",
        background: "11131A",
        foreground: "F8FAFC",
        muted: "AAB2C5",
        accent: "A78BFA",
        accent_secondary: "22D3EE",
        layout: RenderLayout::Spotlight,
    },
    RenderTheme {
        theme_id: "restork-ocean",
        version: 1,
        content_hash: "04a8a222557487c194644fd2ac31b39b719eaeb04e69fb98a0e28758a5fa532a",
        name_en: "Ocean Lab",
        name_zh: "海盐研究",
        description_en: "Cool research palette for evidence and technical narratives.",
        description_zh: "清冷研究配色，适合证据、论文与技术叙事。",
        background: "ECFEFF",
        foreground: "164E63",
        muted: "477987",
        accent: "0891B2",
        accent_secondary: "0F766E",
        layout: RenderLayout::Research,
    },
    RenderTheme {
        theme_id: "restork-ember",
        version: 1,
        content_hash: "e313b188c7638c78e22967923c089dab1630c2c739115bbe67835fb39dd62bc8",
        name_en: "Ember",
        name_zh: "暖色复盘",
        description_en: "Soft cream and ember accents for stories and retrospectives.",
        description_zh: "奶油底色配暖橙重点，适合故事与阶段复盘。",
        background: "FFF7ED",
        foreground: "431407",
        muted: "9A5A3A",
        accent: "EA580C",
        accent_secondary: "E11D48",
        layout: RenderLayout::Narrative,
    },
    RenderTheme {
        theme_id: "restork-blueprint",
        version: 1,
        content_hash: "0cc52a02b1c52121215c34afe897e6ec154792bb6ccd20837b426cb555984e1c",
        name_en: "Blueprint",
        name_zh: "数据蓝图",
        description_en: "Structured navy canvas for architecture, metrics, and plans.",
        description_zh: "深蓝结构化画布，适合架构、数据与计划。",
        background: "EAF2FF",
        foreground: "102A56",
        muted: "4F6B95",
        accent: "1D4ED8",
        accent_secondary: "7C3AED",
        layout: RenderLayout::Blueprint,
    },
    // PPT Master compatibility themes port the reviewed upstream deck tokens
    // and page grammar into Restork's bounded, macro-free OOXML renderer. They
    // do not execute the upstream Python toolchain or load remote assets.
    RenderTheme {
        theme_id: "ppt-master-apple",
        version: 1,
        content_hash: "4028a6fcc2b4fe9b172490c4ad82ea7a62a092728c2b9589164f6437d569e1e3",
        name_en: "PPT Master · Apple",
        name_zh: "PPT Master · Apple",
        description_en: "Monochrome product-keynote compatibility pack.",
        description_zh: "黑白产品发布风格兼容包。",
        background: "FFFFFF",
        foreground: "1D1D1F",
        muted: "6E6E73",
        accent: "1D1D1F",
        accent_secondary: "A8A8AD",
        layout: RenderLayout::PptMasterApple,
    },
    RenderTheme {
        theme_id: "ppt-master-jangpm",
        version: 1,
        content_hash: "55c1f9d7fd9a18b1f7c64bae8c6b4dea1e3ecdbf7c56db8cd8e27e632b1abb0e",
        name_en: "PPT Master · JangPM",
        name_zh: "PPT Master · JangPM",
        description_en: "Editorial lecture and report compatibility pack.",
        description_zh: "编辑式讲义与报告兼容包。",
        background: "FAFAF9",
        foreground: "1A1A1A",
        muted: "6B7280",
        accent: "4633E3",
        accent_secondary: "E8E5FC",
        layout: RenderLayout::PptMasterJangpm,
    },
    RenderTheme {
        theme_id: "ppt-master-mckinsey",
        version: 1,
        content_hash: "a4453838135f6a7f740a6e73f94b5d2b69291761c21dd973adcf312cc3c01da1",
        name_en: "PPT Master · McKinsey style",
        name_zh: "PPT Master · 咨询报告",
        description_en: "Evidence-first strategy-deck compatibility pack.",
        description_zh: "证据优先策略报告兼容包。",
        background: "FFFFFF",
        foreground: "1A1A1A",
        muted: "888888",
        accent: "0F2A4A",
        accent_secondary: "2E9BD6",
        layout: RenderLayout::PptMasterMckinsey,
    },
    RenderTheme {
        theme_id: "ppt-master-naver-ir",
        version: 1,
        content_hash: "f893512a7a77bdefeb4ceeb958e5b9e2238ec26a8c2a8c2d0cfed487186408d7",
        name_en: "PPT Master · NAVER IR",
        name_zh: "PPT Master · NAVER IR",
        description_en: "Restrained investor-relations compatibility pack.",
        description_zh: "克制型投资者关系兼容包。",
        background: "FFFFFF",
        foreground: "262626",
        muted: "7F7F7F",
        accent: "03C75A",
        accent_secondary: "4472C4",
        layout: RenderLayout::PptMasterNaverIr,
    },
];

/// Returns the complete theme catalog compiled into the binary.
#[must_use]
pub const fn builtin_themes() -> &'static [RenderTheme] {
    &BUILTIN_THEMES
}

#[must_use]
pub fn builtin_theme(theme_id: &str) -> Option<&'static RenderTheme> {
    BUILTIN_THEMES
        .iter()
        .find(|theme| theme.theme_id == theme_id)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RenderFormat {
    Pptx,
    Pdf,
}

impl RenderFormat {
    #[must_use]
    pub const fn media_type(self) -> &'static str {
        match self {
            Self::Pptx => {
                "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            }
            Self::Pdf => "application/pdf",
        }
    }

    #[must_use]
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Pptx => "pptx",
            Self::Pdf => "pdf",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RenderManifest {
    pub schema_version: u8,
    pub renderer_id: &'static str,
    pub renderer_version: &'static str,
    pub format: RenderFormat,
    pub deck_id: String,
    pub deck_revision: u64,
    pub deck_spec_hash: String,
    pub evidence_set_hash: String,
    pub theme_hash: String,
    pub renderer_lock_hash: String,
    pub target: String,
    pub artifact_hash: String,
    pub byte_count: usize,
    pub macro_free: bool,
    pub deterministic: bool,
    pub validation_checks: Vec<&'static str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedArtifact {
    pub bytes: Vec<u8>,
    pub manifest: RenderManifest,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderError {
    InvalidDeck,
    OutsideLimits,
    Encoding,
}

#[derive(Clone)]
struct DeckView {
    id: String,
    revision: u64,
    spec_hash: String,
    ledger_hash: String,
    theme_hash: String,
    theme: ResolvedRenderTheme,
    language: String,
    slides: Vec<SlideView>,
}

#[derive(Clone)]
struct ResolvedRenderTheme {
    name_en: String,
    background: String,
    foreground: String,
    muted: String,
    accent: String,
    accent_secondary: String,
    layout: RenderLayout,
}

impl ResolvedRenderTheme {
    fn builtin(theme: &RenderTheme) -> Self {
        Self {
            name_en: theme.name_en.to_owned(),
            background: theme.background.to_owned(),
            foreground: theme.foreground.to_owned(),
            muted: theme.muted.to_owned(),
            accent: theme.accent.to_owned(),
            accent_secondary: theme.accent_secondary.to_owned(),
            layout: theme.layout,
        }
    }

    fn snapshot(theme: &ThemeSnapshot) -> Self {
        Self {
            name_en: theme.name().to_owned(),
            background: theme.background().to_owned(),
            foreground: theme.foreground().to_owned(),
            muted: theme.muted().to_owned(),
            accent: theme.accent().to_owned(),
            accent_secondary: theme.accent_secondary().to_owned(),
            layout: match theme.layout() {
                ThemeLayout::Editorial => RenderLayout::Editorial,
                ThemeLayout::Minimal => RenderLayout::Minimal,
                ThemeLayout::Spotlight => RenderLayout::Spotlight,
                ThemeLayout::Research => RenderLayout::Research,
                ThemeLayout::Narrative => RenderLayout::Narrative,
                ThemeLayout::Blueprint => RenderLayout::Blueprint,
                ThemeLayout::PptMasterApple => RenderLayout::PptMasterApple,
                ThemeLayout::PptMasterJangpm => RenderLayout::PptMasterJangpm,
                ThemeLayout::PptMasterMckinsey => RenderLayout::PptMasterMckinsey,
                ThemeLayout::PptMasterNaverIr => RenderLayout::PptMasterNaverIr,
            },
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SlideKind {
    Title,
    Agenda,
    Section,
    Evidence,
    Comparison,
    Timeline,
    Architecture,
    Chart,
    Table,
    Formula,
    Conclusion,
    Appendix,
}

impl SlideKind {
    fn parse(value: Option<&Value>) -> Self {
        match value.and_then(Value::as_str) {
            Some("title") => Self::Title,
            Some("agenda") => Self::Agenda,
            Some("section") => Self::Section,
            Some("comparison") => Self::Comparison,
            Some("timeline") => Self::Timeline,
            Some("architecture") => Self::Architecture,
            Some("chart") => Self::Chart,
            Some("table") => Self::Table,
            Some("formula") => Self::Formula,
            Some("conclusion") => Self::Conclusion,
            Some("appendix") => Self::Appendix,
            _ => Self::Evidence,
        }
    }
}

#[derive(Clone)]
struct SlideView {
    kind: SlideKind,
    title: String,
    lines: Vec<String>,
    /// Optional, renderer-safe exhibit data supplied through the existing
    /// `visuals[].alt_text` contract. Chart rows use `label | value`; table
    /// rows use pipe-delimited cells. Keeping this textual contract means old
    /// decks remain valid and no executable or remote asset enters rendering.
    exhibit_lines: Vec<String>,
    /// Citation ids for this slide, de-duplicated in first-seen order. They used
    /// to be concatenated onto the claim text, so every body line ended in a
    /// literal `[source:brief]`. A source belongs under the slide, not inside
    /// the sentence it supports.
    sources: Vec<String>,
}

pub fn render_deck(deck: &Value, format: RenderFormat) -> Result<RenderedArtifact, RenderError> {
    let deck = DeckView::parse(deck)?;
    let bytes = match format {
        RenderFormat::Pptx => render_pptx(&deck)?,
        RenderFormat::Pdf => render_pdf(&deck)?,
    };
    validate_output(&bytes, format)?;
    let artifact_hash = digest(&bytes);
    let mut validation_checks = vec![
        "bounded_input",
        "no_remote_assets",
        "no_external_relationships",
        "no_macros_or_ole",
        "required_parts_present",
        "cjk_text_preserved",
        "output_hash_verified",
    ];
    if format == RenderFormat::Pdf {
        validation_checks.extend(["embedded_cjk_font_subset", "unicode_copy_map"]);
    }
    Ok(RenderedArtifact {
        manifest: RenderManifest {
            schema_version: 1,
            renderer_id: if deck.theme.layout.is_ppt_master() {
                "restork-ppt-master-compat"
            } else {
                "restork-native"
            },
            renderer_version: env!("CARGO_PKG_VERSION"),
            format,
            deck_id: deck.id,
            deck_revision: deck.revision,
            deck_spec_hash: deck.spec_hash,
            evidence_set_hash: deck.ledger_hash,
            theme_hash: deck.theme_hash,
            renderer_lock_hash: digest(include_bytes!("../../../Cargo.lock")),
            target: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
            artifact_hash,
            byte_count: bytes.len(),
            macro_free: true,
            deterministic: true,
            validation_checks,
        },
        bytes,
    })
}

impl DeckView {
    fn parse(value: &Value) -> Result<Self, RenderError> {
        let object = value.as_object().ok_or(RenderError::InvalidDeck)?;
        let id = bounded_text(object.get("deck_id"), 160)?;
        let revision = object
            .get("revision")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or(RenderError::InvalidDeck)?;
        let spec_hash = object
            .get("spec_hash")
            .and_then(Value::as_str)
            .filter(|value| is_digest(value))
            .ok_or(RenderError::InvalidDeck)?
            .to_owned();
        let ledger_hash = object
            .get("ledger_hash")
            .and_then(Value::as_str)
            .filter(|value| is_digest(value))
            .ok_or(RenderError::InvalidDeck)?
            .to_owned();
        let theme_ref = object
            .get("theme")
            .and_then(Value::as_object)
            .ok_or(RenderError::InvalidDeck)?;
        let theme_id = theme_ref
            .get("theme_id")
            .and_then(Value::as_str)
            .ok_or(RenderError::InvalidDeck)?;
        let theme_version = theme_ref
            .get("version")
            .and_then(Value::as_u64)
            .filter(|version| *version > 0)
            .ok_or(RenderError::InvalidDeck)?;
        let theme_hash = theme_ref
            .get("content_hash")
            .and_then(Value::as_str)
            .filter(|value| is_digest(value))
            .ok_or(RenderError::InvalidDeck)?
            .to_owned();
        let theme = if let Some(snapshot) = object.get("theme_snapshot") {
            let snapshot = serde_json::from_value::<ThemeSnapshot>(snapshot.clone())
                .map_err(|_| RenderError::InvalidDeck)?;
            let snapshot_hash = snapshot
                .content_hash()
                .map_err(|_| RenderError::InvalidDeck)?;
            if snapshot.theme_id() != theme_id
                || snapshot.version() != theme_version
                || snapshot_hash != theme_hash
            {
                return Err(RenderError::InvalidDeck);
            }
            ResolvedRenderTheme::snapshot(&snapshot)
        } else {
            let builtin = builtin_theme(theme_id).ok_or(RenderError::InvalidDeck)?;
            if builtin.version != theme_version || builtin.content_hash != theme_hash {
                return Err(RenderError::InvalidDeck);
            }
            ResolvedRenderTheme::builtin(builtin)
        };
        let language = bounded_text(object.get("language"), 64)?;
        let claims = object
            .get("claims")
            .and_then(Value::as_object)
            .ok_or(RenderError::InvalidDeck)?;
        let raw_slides = object
            .get("slides")
            .and_then(Value::as_array)
            .filter(|slides| !slides.is_empty() && slides.len() <= MAX_SLIDES)
            .ok_or(RenderError::OutsideLimits)?;
        let mut total = 0_usize;
        let mut slides = Vec::with_capacity(raw_slides.len());
        for raw in raw_slides {
            let raw = raw.as_object().ok_or(RenderError::InvalidDeck)?;
            let kind = SlideKind::parse(raw.get("role"));
            let title = bounded_text(raw.get("action_title"), 4_096)?;
            total = total.saturating_add(title.len());
            let mut lines = Vec::new();
            let mut exhibit_lines = Vec::new();
            let mut sources: Vec<String> = Vec::new();
            let refs = raw
                .get("claim_refs")
                .and_then(Value::as_array)
                .ok_or(RenderError::InvalidDeck)?;
            for reference in refs {
                let reference = reference.as_str().ok_or(RenderError::InvalidDeck)?;
                let claim = claims
                    .get(reference)
                    .and_then(Value::as_object)
                    .ok_or(RenderError::InvalidDeck)?;
                let text = bounded_text(claim.get("text"), 16_384)?;
                let citations = claim
                    .get("citation_refs")
                    .and_then(Value::as_array)
                    .ok_or(RenderError::InvalidDeck)?
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>();
                for citation in &citations {
                    let citation = (*citation).to_owned();
                    total = total.saturating_add(citation.len());
                    if !sources.contains(&citation) {
                        sources.push(citation);
                    }
                }
                total = total.saturating_add(text.len());
                lines.push(text);
            }
            if let Some(visuals) = raw.get("visuals").and_then(Value::as_array) {
                let expected_kind = match kind {
                    SlideKind::Chart => Some("chart"),
                    SlideKind::Table => Some("table"),
                    _ => None,
                };
                for visual in visuals {
                    let Some(visual) = visual.as_object() else {
                        continue;
                    };
                    if expected_kind != visual.get("kind").and_then(Value::as_str) {
                        continue;
                    }
                    let Some(alt_text) = visual.get("alt_text").and_then(Value::as_str) else {
                        continue;
                    };
                    if alt_text.len() > 16_384 {
                        return Err(RenderError::OutsideLimits);
                    }
                    for line in alt_text
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                    {
                        total = total.saturating_add(line.len());
                        exhibit_lines.push(line.to_owned());
                    }
                }
            }
            if let Some(notes) = raw.get("speaker_notes").and_then(Value::as_array) {
                for note in notes {
                    if let Some(text) = note.get("text").and_then(Value::as_str) {
                        total = total.saturating_add(text.len());
                    }
                }
            }
            slides.push(SlideView {
                kind,
                title,
                lines,
                exhibit_lines,
                sources,
            });
        }
        if total > MAX_TEXT_BYTES {
            return Err(RenderError::OutsideLimits);
        }
        Ok(Self {
            id,
            revision,
            spec_hash,
            ledger_hash,
            theme_hash,
            theme,
            language,
            slides,
        })
    }
}

fn validate_output(bytes: &[u8], format: RenderFormat) -> Result<(), RenderError> {
    if bytes.is_empty() || bytes.len() > 64 * 1024 * 1024 {
        return Err(RenderError::OutsideLimits);
    }
    match format {
        RenderFormat::Pptx => {
            let forbidden = [
                b"vbaProject".as_slice(),
                b"oleObject".as_slice(),
                b"activeX".as_slice(),
                b"EncryptedPackage".as_slice(),
                b"TargetMode=\"External\"".as_slice(),
            ];
            if !bytes.starts_with(b"PK\x03\x04")
                || forbidden
                    .iter()
                    .any(|needle| bytes.windows(needle.len()).any(|window| window == *needle))
            {
                return Err(RenderError::Encoding);
            }
        }
        RenderFormat::Pdf => {
            if !bytes.starts_with(b"%PDF-1.7") || !bytes.ends_with(b"%%EOF\n") {
                return Err(RenderError::Encoding);
            }
        }
    }
    Ok(())
}

fn bounded_text(value: Option<&Value>, maximum: usize) -> Result<String, RenderError> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty() && value.len() <= maximum)
        .map(str::to_owned)
        .ok_or(RenderError::InvalidDeck)
}

fn render_pptx(deck: &DeckView) -> Result<Vec<u8>, RenderError> {
    let mut archive = StoreZip::default();
    archive.add(
        "[Content_Types].xml",
        content_types(deck.slides.len()).into_bytes(),
    )?;
    archive.add("_rels/.rels", ROOT_RELS.as_bytes().to_vec())?;
    archive.add("docProps/core.xml", core_properties(deck).into_bytes())?;
    archive.add(
        "docProps/app.xml",
        app_properties(deck.slides.len()).into_bytes(),
    )?;
    archive.add(
        "ppt/presentation.xml",
        presentation(deck.slides.len()).into_bytes(),
    )?;
    archive.add(
        "ppt/_rels/presentation.xml.rels",
        presentation_relationships(deck.slides.len()).into_bytes(),
    )?;
    archive.add(
        "ppt/slideMasters/slideMaster1.xml",
        SLIDE_MASTER.as_bytes().to_vec(),
    )?;
    archive.add(
        "ppt/slideMasters/_rels/slideMaster1.xml.rels",
        MASTER_RELS.as_bytes().to_vec(),
    )?;
    archive.add(
        "ppt/slideLayouts/slideLayout1.xml",
        SLIDE_LAYOUT.as_bytes().to_vec(),
    )?;
    archive.add(
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
        LAYOUT_RELS.as_bytes().to_vec(),
    )?;
    archive.add("ppt/theme/theme1.xml", theme_xml(&deck.theme).into_bytes())?;
    for (index, slide) in deck.slides.iter().enumerate() {
        archive.add(
            &format!("ppt/slides/slide{}.xml", index + 1),
            slide_xml(slide, &deck.language, &deck.theme, index).into_bytes(),
        )?;
        archive.add(
            &format!("ppt/slides/_rels/slide{}.xml.rels", index + 1),
            SLIDE_RELS.as_bytes().to_vec(),
        )?;
    }
    archive.finish()
}

fn content_types(slides: usize) -> String {
    let slide_overrides = (1..=slides)
        .map(|index| format!("<Override PartName=\"/ppt/slides/slide{index}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/><Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/><Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/><Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/><Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>{slide_overrides}</Types>"
    )
}

fn core_properties(deck: &DeckView) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:dcterms=\"http://purl.org/dc/terms/\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"><dc:title>{}</dc:title><dc:creator>Restork</dc:creator><cp:lastModifiedBy>Restork</cp:lastModifiedBy><cp:revision>{}</cp:revision></cp:coreProperties>",
        xml(&deck.id),
        deck.revision
    )
}

fn app_properties(slides: usize) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\" xmlns:vt=\"http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes\"><Application>Restork</Application><PresentationFormat>Widescreen</PresentationFormat><Slides>{slides}</Slides><Notes>0</Notes><HiddenSlides>0</HiddenSlides><MMClips>0</MMClips><ScaleCrop>false</ScaleCrop></Properties>"
    )
}

fn presentation(slides: usize) -> String {
    let ids = (1..=slides)
        .map(|index| {
            format!(
                "<p:sldId id=\"{}\" r:id=\"rId{}\"/>",
                255 + index,
                index + 1
            )
        })
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:presentation xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst><p:sldIdLst>{ids}</p:sldIdLst><p:sldSz cx=\"12192000\" cy=\"6858000\" type=\"screen16x9\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/></p:presentation>"
    )
}

fn presentation_relationships(slides: usize) -> String {
    let relations = (1..=slides)
        .map(|index| format!("<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{index}.xml\"/>", index + 1))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>{relations}</Relationships>"
    )
}

fn slide_xml(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    index: usize,
) -> String {
    let layout = layout_metrics(theme.layout, slide.kind);
    let title_size = fitted_title_size(layout.title_size, &slide.title, slide.kind);
    let bullets = slide
        .lines
        .iter()
        .flat_map(|line| wrap(line, layout.wrap_width))
        .take(layout.maximum_lines)
        .map(|line| format!("<a:p><a:pPr lvl=\"0\" marL=\"342900\" indent=\"-228600\"><a:buChar char=\"•\"/></a:pPr><a:r><a:rPr lang=\"{}\" sz=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"{}\"/></a:p>", xml(language), layout.body_size, theme.foreground, xml(&line), xml(language), layout.body_size))
        .collect::<String>();
    let body = exhibit_body_shapes(slide, language, theme, &layout).unwrap_or_else(|| {
        if theme.layout.is_ppt_master() {
            ppt_master_body_shapes(slide, language, theme, &layout)
        } else {
            text_box(
                3,
                "Body",
                layout.body_x,
                layout.body_y,
                layout.body_width,
                layout.body_height,
                &bullets,
            )
        }
    });
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{}{}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        theme.background,
        accent_shape(theme, index, slide.kind),
        text_box(
            2,
            "Title",
            layout.title_x,
            layout.title_y,
            layout.title_width,
            layout.title_height,
            &format!(
                "<a:p><a:r><a:rPr lang=\"{}\" sz=\"{}\" b=\"1\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"{}\"/></a:p>",
                xml(language),
                title_size,
                theme.foreground,
                xml(&slide.title),
                xml(language),
                title_size
            )
        ),
        body,
        source_note_shape(slide, language, theme, &layout),
    )
}

#[derive(Clone, Debug)]
struct BarDatum {
    label: String,
    display_value: String,
    value: f64,
}

#[derive(Clone, Debug)]
struct TableData {
    rows: Vec<Vec<String>>,
    has_ordinal_column: bool,
}

fn exhibit_body_shapes(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
) -> Option<String> {
    match slide.kind {
        SlideKind::Chart => {
            let data = chart_data(slide);
            (!data.is_empty()).then(|| bar_chart_shapes(&data, language, theme, layout))
        }
        SlideKind::Table => {
            let data = table_data(slide, language);
            (!data.rows.is_empty()).then(|| table_graphic_frame(&data, language, theme, layout))
        }
        _ => None,
    }
}

/// Prefer explicitly supplied visual rows. Generated decks created before the
/// exhibit contract existed still work because their evidence claims are used
/// as a deterministic fallback. The middle dot is the compose API's separator
/// when one slide cites several facts.
fn exhibit_source_lines(slide: &SlideView) -> Vec<String> {
    let source = if slide.exhibit_lines.is_empty() {
        &slide.lines
    } else {
        &slide.exhibit_lines
    };
    source
        .iter()
        .flat_map(|line| line.split(" · "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(12)
        .map(str::to_owned)
        .collect()
}

fn chart_data(slide: &SlideView) -> Vec<BarDatum> {
    exhibit_source_lines(slide)
        .iter()
        .filter_map(|line| parse_bar_datum(line))
        .take(6)
        .collect()
}

fn parse_bar_datum(line: &str) -> Option<BarDatum> {
    if let Some((label, raw_value)) = line.split_once('|').or_else(|| line.split_once('\t')) {
        let value = raw_value
            .split_whitespace()
            .rev()
            .find_map(numeric_value)
            .or_else(|| numeric_value(raw_value))?
            .0;
        let display_value = raw_value.trim().to_owned();
        let label = label.trim().trim_matches([':', '-', '–', '—']).trim();
        if label.is_empty() {
            return None;
        }
        return Some(BarDatum {
            label: label.to_owned(),
            display_value,
            value,
        });
    }

    for token in line.split_whitespace().rev() {
        let Some((value, mut display_value, _)) = numeric_value(token) else {
            continue;
        };
        let offset = line.rfind(token)?;
        let mut label = line[..offset]
            .trim()
            .trim_matches([':', '-', '–', '—', '|'])
            .trim()
            .to_owned();
        let suffix = line[offset + token.len()..]
            .trim()
            .trim_matches(|character: char| character.is_ascii_punctuation())
            .trim();
        if suffix.eq_ignore_ascii_case("percent") || suffix == "百分比" {
            display_value.push(' ');
            display_value.push_str(suffix);
        }
        if label.is_empty() {
            label = line.to_owned();
        }
        return Some(BarDatum {
            label,
            display_value,
            value,
        });
    }
    None
}

fn numeric_value(token: &str) -> Option<(f64, String, bool)> {
    let display = token
        .trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | ':' | '.'
            )
        })
        .to_owned();
    let mut normalized = display
        .trim_start_matches(['$', '¥', '￥', '€', '£'])
        .replace(',', "");
    let percent = normalized.ends_with('%');
    if percent {
        normalized.pop();
    }
    let multiplier = match normalized.chars().last() {
        Some('k' | 'K') => 1_000.0,
        Some('m' | 'M') => 1_000_000.0,
        Some('b' | 'B') => 1_000_000_000.0,
        _ => 1.0,
    };
    if multiplier != 1.0 {
        normalized.pop();
    }
    let value = normalized.parse::<f64>().ok()? * multiplier;
    value.is_finite().then_some((value, display, percent))
}

fn bar_chart_shapes(
    data: &[BarDatum],
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
) -> String {
    let maximum = data
        .iter()
        .map(|datum| datum.value.abs())
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let count = u32::try_from(data.len()).unwrap_or(1).max(1);
    let row_height = layout.body_height / count;
    let label_width = layout.body_width.saturating_mul(31) / 100;
    let value_width = layout.body_width.saturating_mul(14) / 100;
    let gap = 114_300_u32;
    let track_x = layout.body_x + label_width + gap;
    let track_width = layout
        .body_width
        .saturating_sub(label_width + value_width + gap.saturating_mul(2));
    let bar_height = (row_height.saturating_mul(34) / 100).clamp(76_200, 266_700);
    data.iter()
        .enumerate()
        .map(|(index, datum)| {
            let index = u32::try_from(index).unwrap_or(0);
            let y = layout.body_y + index * row_height;
            let bar_y = y + row_height.saturating_sub(bar_height) / 2;
            let ratio = (datum.value.abs() / maximum).clamp(0.0, 1.0);
            let fill_width = (f64::from(track_width) * ratio).round() as u32;
            let color = if datum.value < 0.0 {
                &theme.accent_secondary
            } else {
                &theme.accent
            };
            let id = 100 + index * 4;
            format!(
                "{}{}{}{}",
                text_box(
                    id,
                    &format!("Bar label {}", index + 1),
                    layout.body_x,
                    y,
                    label_width,
                    row_height,
                    &plain_paragraph(
                        &datum.label,
                        language,
                        layout.body_size.min(1_600),
                        &theme.foreground,
                        false,
                    ),
                ),
                filled_rect(
                    id + 1,
                    &format!("Bar track {}", index + 1),
                    track_x,
                    bar_y,
                    track_width,
                    bar_height,
                    "E6E8EB",
                ),
                if fill_width == 0 {
                    String::new()
                } else {
                    filled_rect(
                        id + 2,
                        &format!("Bar {}", index + 1),
                        track_x,
                        bar_y,
                        fill_width,
                        bar_height,
                        color,
                    )
                },
                text_box(
                    id + 3,
                    &format!("Bar value {}", index + 1),
                    track_x + track_width + gap,
                    y,
                    value_width,
                    row_height,
                    &plain_paragraph(
                        &datum.display_value,
                        language,
                        layout.body_size.min(1_600),
                        &theme.foreground,
                        true,
                    ),
                ),
            )
        })
        .collect()
}

fn table_data(slide: &SlideView, language: &str) -> TableData {
    let lines = exhibit_source_lines(slide);
    let delimited = lines
        .iter()
        .any(|line| line.contains('|') || line.contains('\t'));
    if !delimited {
        let mut rows = vec![vec![
            "#".to_owned(),
            if language.starts_with("zh") {
                "证据".to_owned()
            } else {
                "Evidence".to_owned()
            },
        ]];
        rows.extend(
            lines
                .into_iter()
                .take(6)
                .enumerate()
                .map(|(index, line)| vec![(index + 1).to_string(), line]),
        );
        return TableData {
            rows,
            has_ordinal_column: true,
        };
    }

    let mut rows = lines
        .iter()
        .take(7)
        .map(|line| {
            line.split(['|', '\t'])
                .map(str::trim)
                .filter(|cell| !cell.is_empty())
                .take(4)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0).clamp(1, 4);
    let first_is_header = rows.first().is_some_and(|row| {
        row.first().is_some_and(|cell| {
            matches!(
                cell.trim().to_ascii_lowercase().as_str(),
                "item" | "metric" | "category" | "项目" | "指标" | "类别"
            )
        })
    });
    if !first_is_header {
        let english = ["Item", "Value", "Detail", "Notes"];
        let chinese = ["项目", "数值", "详情", "备注"];
        let labels = if language.starts_with("zh") {
            &chinese
        } else {
            &english
        };
        rows.insert(
            0,
            labels[..columns]
                .iter()
                .map(|label| (*label).to_owned())
                .collect(),
        );
    }
    for row in &mut rows {
        row.resize(columns, String::new());
    }
    TableData {
        rows,
        has_ordinal_column: false,
    }
}

fn table_graphic_frame(
    data: &TableData,
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
) -> String {
    let columns = data.rows.first().map(Vec::len).unwrap_or(1).max(1);
    let widths = table_column_widths(layout.body_width, columns, data.has_ordinal_column);
    let table_height = fitted_table_height(layout.body_height, data.rows.len());
    let row_height = table_height / u32::try_from(data.rows.len()).unwrap_or(1).max(1);
    let grid = widths
        .iter()
        .map(|width| format!("<a:gridCol w=\"{width}\"/>"))
        .collect::<String>();
    let rows = data
        .rows
        .iter()
        .enumerate()
        .map(|(row_index, row)| {
            let header = row_index == 0;
            let cells = row
                .iter()
                .map(|cell| table_cell_xml(cell, language, theme, header, row_index % 2 == 0))
                .collect::<String>();
            format!("<a:tr h=\"{row_height}\">{cells}</a:tr>")
        })
        .collect::<String>();
    format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"100\" name=\"Exhibit table\"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/table\"><a:tbl><a:tblPr firstRow=\"1\" bandRow=\"1\"/><a:tblGrid>{grid}</a:tblGrid>{rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
        layout.body_x, layout.body_y, layout.body_width, table_height
    )
}

fn fitted_table_height(available: u32, rows: usize) -> u32 {
    const PREFERRED_ROW_HEIGHT: u32 = 685_800;
    let rows = u32::try_from(rows).unwrap_or(1).max(1);
    available.min(PREFERRED_ROW_HEIGHT.saturating_mul(rows))
}

fn table_column_widths(total: u32, columns: usize, ordinal: bool) -> Vec<u32> {
    if columns == 1 {
        return vec![total];
    }
    let first = if ordinal {
        total / 10
    } else {
        total.saturating_mul(32) / 100
    };
    let remaining = total.saturating_sub(first);
    let rest_count = u32::try_from(columns - 1).unwrap_or(1);
    let each = remaining / rest_count;
    let mut widths = vec![first];
    widths.extend(std::iter::repeat_n(each, columns - 1));
    let remainder = total.saturating_sub(widths.iter().sum::<u32>());
    if let Some(last) = widths.last_mut() {
        *last = last.saturating_add(remainder);
    }
    widths
}

fn table_cell_xml(
    text: &str,
    language: &str,
    theme: &ResolvedRenderTheme,
    header: bool,
    alternate: bool,
) -> String {
    let fill = if header {
        &theme.accent
    } else if alternate {
        "F5F6F7"
    } else {
        &theme.background
    };
    let foreground = if header { "FFFFFF" } else { &theme.foreground };
    let border = &theme.muted;
    let paragraph = plain_paragraph(text, language, 1_300, foreground, header);
    let line = |edge: &str| {
        format!(
            "<a:ln{edge} w=\"6350\"><a:solidFill><a:srgbClr val=\"{border}\"><a:alpha val=\"35000\"/></a:srgbClr></a:solidFill></a:ln{edge}>"
        )
    };
    format!(
        "<a:tc><a:txBody><a:bodyPr anchor=\"ctr\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"><a:normAutofit fontScale=\"78000\" lnSpcReduction=\"12000\"/></a:bodyPr><a:lstStyle/>{paragraph}</a:txBody><a:tcPr><a:solidFill><a:srgbClr val=\"{fill}\"/></a:solidFill>{}{}{}{}</a:tcPr></a:tc>",
        line("L"),
        line("R"),
        line("T"),
        line("B"),
    )
}

/// The slide's citations, rendered once under the body as a quiet source line.
/// They were previously appended to every claim, so a reader met `[source:brief]`
/// mid-sentence four times on one slide.
fn source_note_shape(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
) -> String {
    let Some(note) = source_note_text(slide) else {
        return String::new();
    };
    let y = source_note_y(layout);
    text_box(
        40,
        "Sources",
        layout.body_x,
        y,
        layout.body_width,
        SOURCE_NOTE_HEIGHT,
        &plain_paragraph(&note, language, SOURCE_NOTE_SIZE, &theme.muted, false),
    )
}

const SOURCE_NOTE_SIZE: u32 = 900;
const SOURCE_NOTE_HEIGHT: u32 = 228_600;
const SLIDE_HEIGHT_EMU: u32 = 6_858_000;

fn source_note_text(slide: &SlideView) -> Option<String> {
    if slide.sources.is_empty() {
        return None;
    }
    Some(format!("Sources: {}", slide.sources.join(" · ")))
}

fn source_note_y(layout: &LayoutMetrics) -> u32 {
    let below_body = layout
        .body_y
        .saturating_add(layout.body_height)
        .saturating_add(45_720);
    let floor = SLIDE_HEIGHT_EMU.saturating_sub(SOURCE_NOTE_HEIGHT + 91_440);
    below_body.min(floor)
}

#[derive(Clone, Copy)]
struct LayoutMetrics {
    title_x: u32,
    title_y: u32,
    title_width: u32,
    title_height: u32,
    body_x: u32,
    body_y: u32,
    body_width: u32,
    body_height: u32,
    title_size: u32,
    body_size: u32,
    wrap_width: usize,
    maximum_lines: usize,
}

const fn layout_metrics(layout: RenderLayout, kind: SlideKind) -> LayoutMetrics {
    match layout {
        RenderLayout::Editorial => LayoutMetrics {
            title_x: 685_800,
            title_y: 457_200,
            title_width: 10_820_400,
            title_height: 914_400,
            body_x: 914_400,
            body_y: 1_600_200,
            body_width: 10_363_200,
            body_height: 4_343_400,
            title_size: 3_000,
            body_size: 1_900,
            wrap_width: 78,
            maximum_lines: 12,
        },
        RenderLayout::Minimal => LayoutMetrics {
            title_x: 914_400,
            title_y: 685_800,
            title_width: 10_363_200,
            title_height: 800_100,
            body_x: 914_400,
            body_y: 1_828_800,
            body_width: 9_144_000,
            body_height: 3_886_200,
            title_size: 2_800,
            body_size: 1_800,
            wrap_width: 70,
            maximum_lines: 11,
        },
        RenderLayout::Spotlight => LayoutMetrics {
            title_x: 1_143_000,
            title_y: 914_400,
            title_width: 9_906_000,
            title_height: 1_257_300,
            body_x: 1_371_600,
            body_y: 2_400_300,
            body_width: 8_686_800,
            body_height: 3_086_100,
            title_size: 3_400,
            body_size: 2_000,
            wrap_width: 60,
            maximum_lines: 9,
        },
        RenderLayout::Research => LayoutMetrics {
            title_x: 1_371_600,
            title_y: 571_500,
            title_width: 9_753_600,
            title_height: 914_400,
            body_x: 1_371_600,
            body_y: 1_714_500,
            body_width: 9_144_000,
            body_height: 4_000_500,
            title_size: 2_900,
            body_size: 1_800,
            wrap_width: 68,
            maximum_lines: 12,
        },
        RenderLayout::Narrative => LayoutMetrics {
            title_x: 685_800,
            title_y: 800_100,
            title_width: 8_686_800,
            title_height: 1_257_300,
            body_x: 685_800,
            body_y: 2_286_000,
            body_width: 9_144_000,
            body_height: 3_200_400,
            title_size: 3_300,
            body_size: 1_900,
            wrap_width: 64,
            maximum_lines: 9,
        },
        RenderLayout::Blueprint => LayoutMetrics {
            title_x: 1_143_000,
            title_y: 457_200,
            title_width: 9_906_000,
            title_height: 914_400,
            body_x: 1_143_000,
            body_y: 1_714_500,
            body_width: 9_144_000,
            body_height: 3_886_200,
            title_size: 2_700,
            body_size: 1_750,
            wrap_width: 72,
            maximum_lines: 12,
        },
        RenderLayout::PptMasterApple => {
            if matches!(
                kind,
                SlideKind::Title | SlideKind::Section | SlideKind::Conclusion
            ) {
                LayoutMetrics {
                    title_x: 952_500,
                    title_y: 1_714_500,
                    title_width: 10_287_000,
                    title_height: 2_286_000,
                    body_x: 3_048_000,
                    body_y: 4_572_000,
                    body_width: 6_096_000,
                    body_height: 1_143_000,
                    title_size: 6_200,
                    body_size: 2_200,
                    wrap_width: 34,
                    maximum_lines: 3,
                }
            } else {
                LayoutMetrics {
                    title_x: 838_200,
                    title_y: 838_200,
                    title_width: 10_515_600,
                    title_height: 1_143_000,
                    body_x: 838_200,
                    body_y: 2_171_700,
                    body_width: 10_515_600,
                    body_height: 3_657_600,
                    title_size: 3_700,
                    body_size: 1_650,
                    wrap_width: 54,
                    maximum_lines: 8,
                }
            }
        }
        RenderLayout::PptMasterJangpm => LayoutMetrics {
            title_x: 685_800,
            title_y: 571_500,
            title_width: 10_820_400,
            title_height: 1_143_000,
            body_x: 685_800,
            body_y: 2_057_400,
            body_width: 10_820_400,
            body_height: 3_657_600,
            title_size: if matches!(kind, SlideKind::Title | SlideKind::Section) {
                4_800
            } else {
                3_200
            },
            body_size: 1_700,
            wrap_width: 58,
            maximum_lines: 9,
        },
        RenderLayout::PptMasterMckinsey => {
            if matches!(kind, SlideKind::Title | SlideKind::Section) {
                LayoutMetrics {
                    title_x: 514_350,
                    title_y: 419_100,
                    title_width: 11_163_300,
                    title_height: 1_371_600,
                    body_x: 514_350,
                    body_y: 2_057_400,
                    body_width: 10_972_800,
                    body_height: 3_657_600,
                    title_size: 4_000,
                    body_size: 1_650,
                    wrap_width: 72,
                    maximum_lines: 8,
                }
            } else {
                LayoutMetrics {
                    title_x: 514_350,
                    title_y: 381_000,
                    title_width: 11_163_300,
                    title_height: 685_800,
                    body_x: 419_100,
                    body_y: 1_409_700,
                    body_width: 11_353_800,
                    body_height: 4_572_000,
                    title_size: 2_400,
                    body_size: 1_450,
                    wrap_width: 72,
                    maximum_lines: 10,
                }
            }
        }
        RenderLayout::PptMasterNaverIr => LayoutMetrics {
            title_x: 685_800,
            title_y: 571_500,
            title_width: 10_820_400,
            title_height: 914_400,
            body_x: 685_800,
            body_y: 1_828_800,
            body_width: 10_820_400,
            body_height: 4_000_500,
            title_size: if matches!(kind, SlideKind::Title | SlideKind::Section) {
                4_800
            } else {
                2_800
            },
            body_size: 1_550,
            wrap_width: 60,
            maximum_lines: 10,
        },
    }
}

fn accent_shape(theme: &ResolvedRenderTheme, index: usize, kind: SlideKind) -> String {
    let color = if index.is_multiple_of(2) {
        theme.accent.as_str()
    } else {
        theme.accent_secondary.as_str()
    };
    match theme.layout {
        RenderLayout::Editorial => filled_rect(4, "Accent", 0, 0, 114_300, 6_858_000, color),
        RenderLayout::Minimal => filled_rect(4, "Accent", 0, 0, 12_192_000, 114_300, color),
        RenderLayout::Spotlight => {
            filled_rect(4, "Accent", 0, 6_686_550, 12_192_000, 171_450, color)
        }
        RenderLayout::Research => format!(
            "{}{}",
            filled_rect(4, "Accent", 0, 0, 685_800, 685_800, color),
            filled_rect(
                5,
                "Rule",
                685_800,
                0,
                11_506_200,
                57_150,
                &theme.accent_secondary
            )
        ),
        RenderLayout::Narrative => {
            filled_rect(4, "Accent", 12_077_700, 0, 114_300, 6_858_000, color)
        }
        RenderLayout::Blueprint => format!(
            "{}{}",
            filled_rect(4, "Accent", 0, 0, 228_600, 6_858_000, color),
            filled_rect(
                5,
                "Rule",
                228_600,
                0,
                11_963_400,
                57_150,
                &theme.accent_secondary
            )
        ),
        RenderLayout::PptMasterApple => format!(
            "{}{}",
            filled_rect(
                4,
                "Apple top rule",
                609_600,
                381_000,
                762_000,
                38_100,
                color
            ),
            filled_rect(
                5,
                "Apple footer",
                609_600,
                6_477_000,
                10_972_800,
                19_050,
                "D2D2D7"
            )
        ),
        RenderLayout::PptMasterJangpm => format!(
            "{}{}",
            filled_rect(
                4,
                "JangPM marker",
                609_600,
                457_200,
                95_250,
                1_066_800,
                color
            ),
            filled_rect(
                5,
                "JangPM footer",
                609_600,
                6_381_750,
                10_972_800,
                19_050,
                "E5E7EB"
            )
        ),
        RenderLayout::PptMasterMckinsey => format!(
            "{}{}{}",
            filled_rect(
                4,
                "Consulting kicker",
                419_100,
                228_600,
                571_500,
                57_150,
                color
            ),
            filled_rect(
                5,
                "Title rule",
                419_100,
                if matches!(kind, SlideKind::Title | SlideKind::Section) {
                    1_828_800
                } else {
                    1_066_800
                },
                11_353_800,
                9_525,
                "999999"
            ),
            filled_rect(
                6,
                "Footer rule",
                419_100,
                6_438_900,
                11_353_800,
                9_525,
                if matches!(kind, SlideKind::Conclusion) {
                    &theme.accent_secondary
                } else {
                    "D0D0D0"
                }
            )
        ),
        RenderLayout::PptMasterNaverIr => format!(
            "{}{}",
            filled_rect(
                4,
                "NAVER brand rail",
                0,
                0,
                if matches!(kind, SlideKind::Title | SlideKind::Conclusion) {
                    12_192_000
                } else {
                    171_450
                },
                6_858_000,
                color
            ),
            filled_rect(
                5,
                "NAVER footer",
                685_800,
                6_381_750,
                10_820_400,
                19_050,
                "E5E5E5"
            )
        ),
    }
}

fn ppt_master_body_shapes(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
) -> String {
    // A claim is a semantic unit. It may wrap inside its text box, but it must
    // never be split into multiple cards (the old preview/export path did that
    // and could even break an English word across two panels).
    let lines = slide.lines.iter().take(6).cloned().collect::<Vec<_>>();
    if lines.is_empty() {
        return String::new();
    }
    if matches!(
        slide.kind,
        SlideKind::Title | SlideKind::Section | SlideKind::Conclusion
    ) {
        let paragraphs = lines
            .iter()
            .map(|line| plain_paragraph(line, language, layout.body_size, &theme.muted, false))
            .collect::<String>();
        return text_box(
            20,
            "Summary",
            layout.body_x,
            layout.body_y,
            layout.body_width,
            layout.body_height,
            &paragraphs,
        );
    }

    let panel = match theme.layout {
        RenderLayout::PptMasterApple => "F5F5F7",
        RenderLayout::PptMasterJangpm => "FFFFFF",
        RenderLayout::PptMasterMckinsey => "F2F2F2",
        RenderLayout::PptMasterNaverIr => "F7F8F8",
        _ => &theme.background,
    };
    let count = lines.len().min(4);
    let (columns, rows) = match slide.kind {
        SlideKind::Timeline => (count, 1),
        SlideKind::Architecture => (1, count),
        SlideKind::Comparison => (2, count.div_ceil(2)),
        _ => (2.min(count), count.div_ceil(2)),
    };
    let gap = 152_400_u32;
    let columns = u32::try_from(columns.max(1)).unwrap_or(1);
    let rows = u32::try_from(rows.max(1)).unwrap_or(1);
    let card_width = (layout.body_width - gap.saturating_mul(columns.saturating_sub(1))) / columns;
    // Cards used to divide the whole body height regardless of how much text
    // they held, so a single forty-character claim was handed a five-inch grey
    // panel that was 95% empty. Size them to the tallest card's own wrapped
    // content instead, and give every card the same height so a row still reads
    // as one group (DESIGN.md: 同组卡片等高).
    let available_height = (layout.body_height - gap.saturating_mul(rows.saturating_sub(1))) / rows;
    let card_height = fitted_card_height(
        &lines[..count],
        slide.kind,
        layout,
        card_width,
        available_height,
    );
    lines
        .iter()
        .take(count)
        .enumerate()
        .map(|(index, line)| {
            let index_u32 = u32::try_from(index).unwrap_or(0);
            let column = if matches!(slide.kind, SlideKind::Architecture) {
                0
            } else {
                index_u32 % columns
            };
            let row = if matches!(slide.kind, SlideKind::Timeline) {
                0
            } else {
                index_u32 / columns
            };
            let x = layout.body_x + column * (card_width + gap);
            let y = layout.body_y + row * (card_height + gap);
            let marker = if matches!(slide.kind, SlideKind::Timeline | SlideKind::Architecture) {
                format!("{:02}", index + 1)
            } else {
                String::new()
            };
            let paragraph = if marker.is_empty() {
                plain_paragraph(line, language, layout.body_size, &theme.foreground, false)
            } else {
                marker_paragraph(
                    &marker,
                    line,
                    language,
                    layout.body_size,
                    &theme.accent,
                    &theme.foreground,
                )
            };
            format!(
                "{}{}",
                filled_rect(
                    30 + index_u32 * 2,
                    "Content panel",
                    x,
                    y,
                    card_width,
                    card_height,
                    panel
                ),
                text_box(
                    31 + index_u32 * 2,
                    "Content",
                    x + 114_300,
                    y + 95_250,
                    card_width.saturating_sub(228_600),
                    card_height.saturating_sub(190_500),
                    &paragraph,
                )
            )
        })
        .collect()
}

/// Height a body card needs for its own wrapped text, bounded by what the slide
/// can actually give it. Shared by the PPTX and PDF paths so a preview and an
/// export never disagree about how tall a panel is.
fn fitted_card_height(
    lines: &[String],
    kind: SlideKind,
    layout: &LayoutMetrics,
    card_width: u32,
    available_height: u32,
) -> u32 {
    const MIN_CARD_HEIGHT: u32 = 640_080;
    const TEXT_INSET: u32 = 190_500;
    const HORIZONTAL_INSET: u32 = 228_600;
    let line_height = layout
        .body_size
        .saturating_mul(127)
        .saturating_mul(135)
        .saturating_div(100);
    let char_width = layout
        .body_size
        .saturating_mul(127)
        .saturating_mul(54)
        .saturating_div(100);
    let units = card_width
        .saturating_sub(HORIZONTAL_INSET)
        .checked_div(char_width)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or(24);
    // The 01/02 marker eats roughly four ASCII units before the claim starts.
    let marker_units = if matches!(kind, SlideKind::Timeline | SlideKind::Architecture) {
        4
    } else {
        0
    };
    let units = units.saturating_sub(marker_units).max(8);
    let needed = lines
        .iter()
        .map(|line| wrap_weighted(line, units).len())
        .max()
        .unwrap_or(1);
    let content = TEXT_INSET.saturating_add(
        u32::try_from(needed)
            .unwrap_or(1)
            .saturating_mul(line_height),
    );
    content.clamp(MIN_CARD_HEIGHT.min(available_height), available_height)
}

fn marker_paragraph(
    marker: &str,
    text: &str,
    language: &str,
    size: u32,
    marker_color: &str,
    text_color: &str,
) -> String {
    format!(
        "<a:p><a:r><a:rPr lang=\"{}\" sz=\"{}\" b=\"1\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:r><a:rPr lang=\"{}\" sz=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t xml:space=\"preserve\">  {}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"{}\"/></a:p>",
        xml(language),
        size,
        marker_color,
        xml(marker),
        xml(language),
        size,
        text_color,
        xml(text),
        xml(language),
        size
    )
}

fn fitted_title_size(base: u32, title: &str, kind: SlideKind) -> u32 {
    let units = title.chars().fold(0_u32, |total, character| {
        total + if character.is_ascii() { 1 } else { 2 }
    });
    let scale = if matches!(kind, SlideKind::Title | SlideKind::Section) {
        if units > 180 {
            68
        } else if units > 130 {
            78
        } else if units > 92 {
            88
        } else {
            100
        }
    } else if units > 220 {
        72
    } else if units > 160 {
        82
    } else if units > 110 {
        90
    } else {
        100
    };
    base.saturating_mul(scale) / 100
}

fn plain_paragraph(text: &str, language: &str, size: u32, color: &str, bold: bool) -> String {
    format!(
        "<a:p><a:r><a:rPr lang=\"{}\" sz=\"{}\" b=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"{}\"/></a:p>",
        xml(language),
        size,
        u8::from(bold),
        color,
        xml(text),
        xml(language),
        size
    )
}

fn filled_rect(id: u32, name: &str, x: u32, y: u32, cx: u32, cy: u32, color: &str) -> String {
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>",
        xml(name)
    )
}

#[allow(clippy::too_many_arguments)]
fn text_box(id: u32, name: &str, x: u32, y: u32, cx: u32, cy: u32, paragraphs: &str) -> String {
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"><a:normAutofit fontScale=\"80000\" lnSpcReduction=\"12000\"/></a:bodyPr><a:lstStyle/>{paragraphs}</p:txBody></p:sp>",
        xml(name)
    )
}

/// A document-specific, embedded subset of the bundled OFL-licensed Noto Sans
/// SC font. Character codes are compact CIDs, not Unicode scalar values: the
/// explicit CIDToGIDMap controls drawing and ToUnicode controls copying and
/// search. This also supports non-BMP characters without abusing UTF-16
/// surrogate halves as separate glyphs.
struct PdfCjkFont {
    base_font: String,
    subset: Vec<u8>,
    cid_to_gid: Vec<u8>,
    to_unicode: Vec<u8>,
    widths: String,
    mapping: BTreeMap<char, u16>,
    bbox: [i32; 4],
    ascent: i32,
    descent: i32,
    cap_height: i32,
}

impl PdfCjkFont {
    fn build(deck: &DeckView) -> Result<Self, RenderError> {
        let face = Face::parse(CJK_FONT, 0).map_err(|_| RenderError::Encoding)?;
        let units = u32::from(face.units_per_em()).max(1);
        let characters = pdf_cjk_characters(deck);
        if characters.len() >= usize::from(u16::MAX) {
            return Err(RenderError::OutsideLimits);
        }

        let mut remapper = GlyphRemapper::new();
        let mut mapping = BTreeMap::new();
        let mut source_glyphs = Vec::with_capacity(characters.len());
        let mut advances = Vec::with_capacity(characters.len());
        for (index, character) in characters.into_iter().enumerate() {
            let glyph = face.glyph_index(character).unwrap_or(GlyphId(0));
            remapper.remap(glyph.0);
            mapping.insert(
                character,
                u16::try_from(index + 1).map_err(|_| RenderError::OutsideLimits)?,
            );
            source_glyphs.push(glyph.0);
            let advance = u32::from(face.glyph_hor_advance(glyph).unwrap_or(face.units_per_em()));
            advances.push((advance.saturating_mul(1_000) + units / 2) / units);
        }

        let subset = subset_with_variations(CJK_FONT, 0, &[(Tag::new(b"wght"), 400.0)], &remapper)
            .map_err(|_| RenderError::Encoding)?;
        let prefix = digest(&subset)[..6].to_ascii_uppercase();
        let base_font = format!("{prefix}+RestorkCJK");

        let mut cid_to_gid = vec![0_u8, 0_u8];
        for glyph in source_glyphs {
            let remapped = remapper.get(glyph).ok_or(RenderError::Encoding)?;
            cid_to_gid.extend_from_slice(&remapped.to_be_bytes());
        }
        let widths = if advances.is_empty() {
            String::new()
        } else {
            format!(
                "/W [1 [{}]]",
                advances
                    .iter()
                    .map(u32::to_string)
                    .collect::<Vec<_>>()
                    .join(" ")
            )
        };
        let to_unicode = to_unicode_cmap(&mapping).into_bytes();
        let bounds = face.global_bounding_box();
        let scale = |value: i16| (f64::from(value) * 1_000.0 / f64::from(units)).round() as i32;
        Ok(Self {
            base_font,
            subset,
            cid_to_gid,
            to_unicode,
            widths,
            mapping,
            bbox: [
                scale(bounds.x_min),
                scale(bounds.y_min),
                scale(bounds.x_max),
                scale(bounds.y_max),
            ],
            ascent: scale(face.ascender()),
            descent: scale(face.descender()),
            cap_height: scale(face.ascender()),
        })
    }

    fn encode(&self, value: &str) -> String {
        let mut output = String::with_capacity(value.chars().count() * 4);
        for character in value.chars() {
            let cid = self.mapping.get(&character).copied().unwrap_or(0);
            output.push_str(&format!("{cid:04X}"));
        }
        output
    }

    fn type0_object(&self) -> Vec<u8> {
        format!(
            "<< /Type /Font /Subtype /Type0 /BaseFont /{} /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 8 0 R >>",
            self.base_font
        )
        .into_bytes()
    }

    fn descendant_object(&self) -> Vec<u8> {
        format!(
            "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 5 0 R /CIDToGIDMap 9 0 R /DW 1000 {} >>",
            self.base_font, self.widths
        )
        .into_bytes()
    }

    fn descriptor_object(&self) -> Vec<u8> {
        format!(
            "<< /Type /FontDescriptor /FontName /{} /Flags 4 /FontBBox [{} {} {} {}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 7 0 R >>",
            self.base_font,
            self.bbox[0],
            self.bbox[1],
            self.bbox[2],
            self.bbox[3],
            self.ascent,
            self.descent,
            self.cap_height,
        )
        .into_bytes()
    }
}

fn pdf_cjk_characters(deck: &DeckView) -> BTreeSet<char> {
    let mut characters = BTreeSet::new();
    let mut add = |text: &str| {
        characters.extend(text.chars().filter(|character| !character.is_ascii()));
    };
    for slide in &deck.slides {
        add(&slide.title);
        for line in &slide.lines {
            add(line);
        }
        for line in &slide.exhibit_lines {
            add(line);
        }
        for source in &slide.sources {
            add(source);
        }
    }
    if deck.language.starts_with("zh") {
        add("证据项目数值详情备注");
    }
    characters
}

fn to_unicode_cmap(mapping: &BTreeMap<char, u16>) -> String {
    let mut output = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /RestorkCJKToUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    let entries = mapping.iter().collect::<Vec<_>>();
    for chunk in entries.chunks(100) {
        output.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (character, cid) in chunk {
            let mut encoded = String::new();
            for unit in character.encode_utf16(&mut [0_u16; 2]) {
                encoded.push_str(&format!("{unit:04X}"));
            }
            output.push_str(&format!("<{cid:04X}> <{encoded}>\n"));
        }
        output.push_str("endbfchar\n");
    }
    output.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend");
    output
}

fn pdf_stream_object(bytes: &[u8], extra_entries: &str) -> Vec<u8> {
    let mut output =
        format!("<< /Length {}{} >>\nstream\n", bytes.len(), extra_entries).into_bytes();
    output.extend_from_slice(bytes);
    output.extend_from_slice(b"\nendstream");
    output
}

fn render_pdf(deck: &DeckView) -> Result<Vec<u8>, RenderError> {
    let cjk_font = PdfCjkFont::build(deck)?;
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        Vec::new(),
        cjk_font.type0_object(),
        cjk_font.descendant_object(),
        cjk_font.descriptor_object(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_vec(),
        pdf_stream_object(
            &cjk_font.subset,
            &format!(" /Length1 {}", cjk_font.subset.len()),
        ),
        pdf_stream_object(&cjk_font.to_unicode, ""),
        pdf_stream_object(&cjk_font.cid_to_gid, ""),
    ];
    let mut page_refs = Vec::new();
    for slide in &deck.slides {
        let page_id = objects.len() + 1;
        let content_id = page_id + 1;
        page_refs.push(format!("{page_id} 0 R"));
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 3 0 R /F2 6 0 R >> >> /Contents {content_id} 0 R >>").into_bytes());
        let stream = pdf_page(slide, &deck.language, &deck.theme, &cjk_font);
        objects.push(
            format!(
                "<< /Length {} >>\nstream\n{}\nendstream",
                stream.len(),
                stream
            )
            .into_bytes(),
        );
    }
    objects[1] = format!(
        "<< /Type /Pages /Kids [{}] /Count {} >>",
        page_refs.join(" "),
        deck.slides.len()
    )
    .into_bytes();
    let mut output = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (index, object) in objects.iter().enumerate() {
        offsets.push(output.len());
        output.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
        output.extend_from_slice(object);
        output.extend_from_slice(b"\nendobj\n");
    }
    let xref = output.len();
    output.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        output.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    output.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    Ok(output)
}

fn pdf_page(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    cjk_font: &PdfCjkFont,
) -> String {
    let layout = layout_metrics(theme.layout, slide.kind);
    let background = pdf_rgb(&theme.background);
    let foreground = pdf_rgb(&theme.foreground);
    let accent = pdf_rgb(&theme.accent);
    let accent_command = match theme.layout {
        RenderLayout::Editorial => format!("q {accent} rg 0 0 8 540 re f Q"),
        RenderLayout::Minimal => format!("q {accent} rg 0 532 960 8 re f Q"),
        RenderLayout::Spotlight => format!("q {accent} rg 0 0 960 12 re f Q"),
        RenderLayout::Research => format!("q {accent} rg 0 486 54 54 re f Q"),
        RenderLayout::Narrative => format!("q {accent} rg 952 0 8 540 re f Q"),
        RenderLayout::Blueprint => {
            format!("q {accent} rg 0 0 14 540 re f Q\nq {accent} rg 0 536 960 4 re f Q")
        }
        RenderLayout::PptMasterApple => {
            format!("q {accent} rg 48 506 60 3 re f Q\nq 0.824 0.824 0.843 rg 48 30 864 1 re f Q")
        }
        RenderLayout::PptMasterJangpm => {
            format!("q {accent} rg 48 420 8 84 re f Q\nq 0.898 0.906 0.922 rg 48 34 864 1 re f Q")
        }
        RenderLayout::PptMasterMckinsey => {
            format!(
                "q {accent} rg 33 516 45 4 re f Q\nq 0.600 0.600 0.600 rg 33 {} 894 1 re f Q\nq 0.816 0.816 0.816 rg 33 32 894 1 re f Q",
                if matches!(slide.kind, SlideKind::Title | SlideKind::Section) {
                    385
                } else {
                    456
                }
            )
        }
        RenderLayout::PptMasterNaverIr => {
            if matches!(slide.kind, SlideKind::Title | SlideKind::Conclusion) {
                format!("q {accent} rg 0 0 960 540 re f Q")
            } else {
                format!(
                    "q {accent} rg 0 0 14 540 re f Q\nq 0.898 0.898 0.898 rg 54 34 852 1 re f Q"
                )
            }
        }
    };
    let title_size = fitted_title_size(layout.title_size, &slide.title, slide.kind) as f32 / 100.0;
    let title_x = emu_to_pdf(layout.title_x);
    let title_top = emu_to_pdf(layout.title_y);
    let title_width = emu_to_pdf(layout.title_width);
    let title_height = emu_to_pdf(layout.title_height);
    let title_line_height = title_size * 1.16;
    let title_units = (title_width / (title_size * 0.54)).floor().max(4.0) as usize;
    let title_lines = wrap_weighted(&slide.title, title_units);
    let title_limit = (title_height / title_line_height).floor().max(1.0) as usize;
    let mut commands =
        format!("q {background} rg 0 0 960 540 re f Q\n{accent_command}\n{foreground} rg\n");
    let mut title_y = 540.0 - title_top - title_size;
    for line in title_lines.iter().take(title_limit) {
        commands.push_str(&pdf_text(line, title_x, title_y, title_size, cjk_font));
        title_y -= title_line_height;
    }
    if let Some(exhibit) = pdf_exhibit_body(slide, language, theme, &layout, cjk_font) {
        commands.push_str(&exhibit);
    } else if theme.layout.is_ppt_master() {
        commands.push_str(&pdf_ppt_master_body(slide, theme, &layout, cjk_font));
    } else {
        let body_size = layout.body_size as f32 / 120.0;
        let body_x = emu_to_pdf(layout.body_x);
        let body_width = emu_to_pdf(layout.body_width);
        let body_top = emu_to_pdf(layout.body_y);
        let body_units = (body_width / (body_size * 0.54)).floor().max(4.0) as usize;
        let mut y = 540.0 - body_top - body_size;
        for line in slide
            .lines
            .iter()
            .flat_map(|line| wrap_weighted(line, body_units))
            .take(layout.maximum_lines)
        {
            commands.push_str(&pdf_text(
                &format!("- {line}"),
                body_x,
                y,
                body_size,
                cjk_font,
            ));
            y -= body_size * 1.45;
        }
    }
    if let Some(note) = source_note_text(slide) {
        let note_size = SOURCE_NOTE_SIZE as f32 / 100.0;
        let note_y = 540.0 - emu_to_pdf(source_note_y(&layout)) - note_size;
        commands.push_str(&format!("{} rg\n", pdf_rgb(&theme.muted)));
        commands.push_str(&pdf_text(
            &note,
            emu_to_pdf(layout.body_x),
            note_y,
            note_size,
            cjk_font,
        ));
    }
    commands
}

fn pdf_exhibit_body(
    slide: &SlideView,
    language: &str,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
    cjk_font: &PdfCjkFont,
) -> Option<String> {
    match slide.kind {
        SlideKind::Chart => {
            let data = chart_data(slide);
            (!data.is_empty()).then(|| pdf_bar_chart(&data, theme, layout, cjk_font))
        }
        SlideKind::Table => {
            let data = table_data(slide, language);
            (!data.rows.is_empty()).then(|| pdf_table(&data, theme, layout, cjk_font))
        }
        _ => None,
    }
}

fn pdf_bar_chart(
    data: &[BarDatum],
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
    cjk_font: &PdfCjkFont,
) -> String {
    let maximum = data
        .iter()
        .map(|datum| datum.value.abs())
        .fold(0.0_f64, f64::max)
        .max(1.0);
    let body_x = emu_to_pdf(layout.body_x);
    let body_top = emu_to_pdf(layout.body_y);
    let body_width = emu_to_pdf(layout.body_width);
    let body_height = emu_to_pdf(layout.body_height);
    let row_height = body_height / data.len().max(1) as f32;
    let label_width = body_width * 0.31;
    let value_width = body_width * 0.14;
    let gap = 9.0_f32;
    let track_x = body_x + label_width + gap;
    let track_width = (body_width - label_width - value_width - gap * 2.0).max(10.0);
    let bar_height = (row_height * 0.34).clamp(6.0, 21.0);
    let font_size = (layout.body_size as f32 / 100.0).min(16.0);
    let mut output = String::new();
    for (index, datum) in data.iter().enumerate() {
        let top = body_top + index as f32 * row_height;
        let bar_y = 540.0 - top - (row_height + bar_height) / 2.0;
        let text_y = 540.0 - top - row_height / 2.0 - font_size * 0.32;
        let fill_width = track_width * (datum.value.abs() / maximum) as f32;
        output.push_str(&format!(
            "q 0.902 0.910 0.922 rg {track_x:.2} {bar_y:.2} {track_width:.2} {bar_height:.2} re f Q\n"
        ));
        if fill_width > 0.0 {
            output.push_str(&format!(
                "q {} rg {track_x:.2} {bar_y:.2} {fill_width:.2} {bar_height:.2} re f Q\n",
                pdf_rgb(if datum.value < 0.0 {
                    &theme.accent_secondary
                } else {
                    &theme.accent
                })
            ));
        }
        let label_units = (label_width / (font_size * 0.54)).floor().max(4.0) as usize;
        let label = wrap_weighted(&datum.label, label_units)
            .into_iter()
            .next()
            .unwrap_or_default();
        output.push_str(&format!("{} rg\n", pdf_rgb(&theme.foreground)));
        output.push_str(&pdf_text(&label, body_x, text_y, font_size, cjk_font));
        output.push_str(&pdf_text(
            &datum.display_value,
            track_x + track_width + gap,
            text_y,
            font_size,
            cjk_font,
        ));
    }
    output
}

fn pdf_table(
    data: &TableData,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
    cjk_font: &PdfCjkFont,
) -> String {
    let columns = data.rows.first().map(Vec::len).unwrap_or(1).max(1);
    let widths = table_column_widths(layout.body_width, columns, data.has_ordinal_column)
        .into_iter()
        .map(emu_to_pdf)
        .collect::<Vec<_>>();
    let body_x = emu_to_pdf(layout.body_x);
    let body_top = emu_to_pdf(layout.body_y);
    let table_height = emu_to_pdf(fitted_table_height(layout.body_height, data.rows.len()));
    let row_height = table_height / data.rows.len().max(1) as f32;
    let border = pdf_rgb(&theme.muted);
    let mut output = String::new();
    for (row_index, row) in data.rows.iter().enumerate() {
        let header = row_index == 0;
        let top = body_top + row_index as f32 * row_height;
        let y = 540.0 - top - row_height;
        let mut x = body_x;
        for (column_index, cell) in row.iter().enumerate() {
            let width = widths.get(column_index).copied().unwrap_or(1.0);
            let fill = if header {
                pdf_rgb(&theme.accent)
            } else if row_index % 2 == 0 {
                "0.961 0.965 0.969".to_owned()
            } else {
                pdf_rgb(&theme.background)
            };
            output.push_str(&format!(
                "q {fill} rg {x:.2} {y:.2} {width:.2} {row_height:.2} re f Q\nq {border} RG 0.5 w {x:.2} {y:.2} {width:.2} {row_height:.2} re S Q\n"
            ));
            let font_size = 10.5_f32;
            let text_width = (width - 14.0).max(10.0);
            let units = (text_width / (font_size * 0.54)).floor().max(4.0) as usize;
            let max_lines = ((row_height - 10.0) / (font_size * 1.18)).floor().max(1.0) as usize;
            let mut text_y = y + row_height - font_size - 5.0;
            output.push_str(&format!(
                "{} rg\n",
                if header {
                    "1.000 1.000 1.000".to_owned()
                } else {
                    pdf_rgb(&theme.foreground)
                }
            ));
            for line in wrap_weighted(cell, units).iter().take(max_lines) {
                output.push_str(&pdf_text(line, x + 7.0, text_y, font_size, cjk_font));
                text_y -= font_size * 1.18;
            }
            x += width;
        }
    }
    output
}

fn pdf_ppt_master_body(
    slide: &SlideView,
    theme: &ResolvedRenderTheme,
    layout: &LayoutMetrics,
    cjk_font: &PdfCjkFont,
) -> String {
    let body_x = emu_to_pdf(layout.body_x);
    let body_top = emu_to_pdf(layout.body_y);
    let body_width = emu_to_pdf(layout.body_width);
    let body_height = emu_to_pdf(layout.body_height);
    let body_size = layout.body_size as f32 / 100.0;
    let line_height = body_size * 1.3;
    if matches!(
        slide.kind,
        SlideKind::Title | SlideKind::Section | SlideKind::Conclusion
    ) {
        let mut output = String::new();
        let units = (body_width / (body_size * 0.54)).floor().max(4.0) as usize;
        let mut y = 540.0 - body_top - body_size;
        let limit = (body_height / line_height).floor().max(1.0) as usize;
        for line in slide
            .lines
            .iter()
            .flat_map(|line| wrap_weighted(line, units))
            .take(limit)
        {
            output.push_str(&pdf_text(&line, body_x, y, body_size, cjk_font));
            y -= line_height;
        }
        return output;
    }

    let count = slide.lines.len().min(4);
    if count == 0 {
        return String::new();
    }
    let (columns, rows) = match slide.kind {
        SlideKind::Timeline => (count, 1),
        SlideKind::Architecture => (1, count),
        SlideKind::Comparison => (2, count.div_ceil(2)),
        _ => (2.min(count), count.div_ceil(2)),
    };
    let gap = 12.0_f32;
    let card_width = (body_width - gap * (columns.saturating_sub(1)) as f32) / columns as f32;
    // Same height rule as the PPTX path, converted once, so the two exports and
    // the preview cannot disagree about panel height.
    let gap_emu = 152_400_u32;
    let rows_u32 = u32::try_from(rows.max(1)).unwrap_or(1);
    let columns_u32 = u32::try_from(columns.max(1)).unwrap_or(1);
    let card_width_emu =
        (layout.body_width - gap_emu.saturating_mul(columns_u32.saturating_sub(1))) / columns_u32;
    let available_emu =
        (layout.body_height - gap_emu.saturating_mul(rows_u32.saturating_sub(1))) / rows_u32;
    let card_height = emu_to_pdf(fitted_card_height(
        &slide.lines[..count],
        slide.kind,
        layout,
        card_width_emu,
        available_emu,
    ));
    let panel = match theme.layout {
        RenderLayout::PptMasterApple => "F5F5F7",
        RenderLayout::PptMasterJangpm => "FFFFFF",
        RenderLayout::PptMasterMckinsey => "F2F2F2",
        RenderLayout::PptMasterNaverIr => "F7F8F8",
        _ => &theme.background,
    };
    let panel_rgb = pdf_rgb(panel);
    let mut output = String::new();
    for (index, text) in slide.lines.iter().take(count).enumerate() {
        let column = if matches!(slide.kind, SlideKind::Architecture) {
            0
        } else {
            index % columns
        };
        let row = if matches!(slide.kind, SlideKind::Timeline) {
            0
        } else {
            index / columns
        };
        let x = body_x + column as f32 * (card_width + gap);
        let top = body_top + row as f32 * (card_height + gap);
        let y = 540.0 - top - card_height;
        output.push_str(&format!(
            "q {panel_rgb} rg {x:.2} {y:.2} {card_width:.2} {card_height:.2} re f Q\n"
        ));
        let marker = if matches!(slide.kind, SlideKind::Timeline | SlideKind::Architecture) {
            format!("{:02}  ", index + 1)
        } else {
            String::new()
        };
        let content = format!("{marker}{text}");
        let text_x = x + 18.0;
        let text_width = (card_width - 36.0).max(30.0);
        let units = (text_width / (body_size * 0.54)).floor().max(4.0) as usize;
        let max_lines = ((card_height - 28.0) / line_height).floor().max(1.0) as usize;
        let mut text_y = y + card_height - 22.0;
        for line in wrap_weighted(&content, units).iter().take(max_lines) {
            output.push_str(&pdf_text(line, text_x, text_y, body_size, cjk_font));
            text_y -= line_height;
        }
    }
    output
}

fn emu_to_pdf(value: u32) -> f32 {
    value as f32 / 12_700.0
}

fn pdf_text(value: &str, x: f32, y: f32, size: f32, cjk_font: &PdfCjkFont) -> String {
    let mut output = String::new();
    let mut run = String::new();
    let mut run_ascii = None;
    let mut cursor = x;
    let flush = |output: &mut String, run: &mut String, ascii: bool, cursor: &mut f32| {
        if run.is_empty() {
            return;
        }
        if ascii {
            output.push_str(&format!(
                "BT /F2 {size:.2} Tf 1 0 0 1 {cursor:.2} {y:.2} Tm ({}) Tj ET\n",
                pdf_literal(run)
            ));
        } else {
            output.push_str(&format!(
                "BT /F1 {size:.2} Tf 1 0 0 1 {cursor:.2} {y:.2} Tm <{}> Tj ET\n",
                cjk_font.encode(run)
            ));
        }
        *cursor += pdf_text_width(run, size);
        run.clear();
    };
    for character in value.chars() {
        let ascii = character.is_ascii();
        if run_ascii.is_some_and(|current| current != ascii) {
            flush(
                &mut output,
                &mut run,
                run_ascii.unwrap_or(true),
                &mut cursor,
            );
        }
        run_ascii = Some(ascii);
        run.push(character);
    }
    flush(
        &mut output,
        &mut run,
        run_ascii.unwrap_or(true),
        &mut cursor,
    );
    output
}

fn pdf_text_width(value: &str, size: f32) -> f32 {
    value.chars().fold(0.0, |width, character| {
        width
            + if !character.is_ascii() {
                size
            } else if character == ' ' {
                size * 0.28
            } else if character.is_ascii_punctuation() {
                size * 0.36
            } else if character.is_ascii_uppercase() {
                size * 0.64
            } else {
                size * 0.52
            }
    })
}

fn pdf_literal(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('(', "\\(")
        .replace(')', "\\)")
}

fn pdf_rgb(hex: &str) -> String {
    let component = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&hex[range], 16).map_or(0.0, |value| f32::from(value) / 255.0)
    };
    format!(
        "{:.3} {:.3} {:.3}",
        component(0..2),
        component(2..4),
        component(4..6)
    )
}

fn wrap_weighted(value: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![value.to_owned()];
    }
    let weight = |text: &str| {
        text.chars()
            .map(|character| if character.is_ascii() { 1 } else { 2 })
            .sum::<usize>()
    };
    let mut lines = Vec::new();
    let mut line = String::new();
    let mut line_width = 0_usize;
    for word in value.split_whitespace() {
        let word_width = weight(word);
        if word_width > width {
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            let mut chunk = String::new();
            let mut chunk_width = 0_usize;
            for character in word.chars() {
                let character_width = if character.is_ascii() { 1 } else { 2 };
                if !chunk.is_empty() && chunk_width + character_width > width {
                    lines.push(std::mem::take(&mut chunk));
                    chunk_width = 0;
                }
                chunk.push(character);
                chunk_width += character_width;
            }
            line = chunk;
            line_width = chunk_width;
        } else if line.is_empty() {
            line.push_str(word);
            line_width = word_width;
        } else if line_width + 1 + word_width <= width {
            line.push(' ');
            line.push_str(word);
            line_width += 1 + word_width;
        } else {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
            line_width = word_width;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn wrap(value: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![value.to_owned()];
    }
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in value.split_whitespace() {
        let word_width = word.chars().count();
        if word_width > width {
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            let mut chunk = String::new();
            for character in word.chars() {
                chunk.push(character);
                if chunk.chars().count() >= width {
                    lines.push(std::mem::take(&mut chunk));
                }
            }
            line = chunk;
        } else if line.is_empty() {
            line.push_str(word);
        } else if line.chars().count() + 1 + word_width <= width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(std::mem::take(&mut line));
            line.push_str(word);
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[derive(Default)]
struct StoreZip {
    entries: Vec<(String, Vec<u8>, u32)>,
}

impl StoreZip {
    fn add(&mut self, name: &str, bytes: Vec<u8>) -> Result<(), RenderError> {
        if name.is_empty() || name.len() > u16::MAX as usize || bytes.len() > u32::MAX as usize {
            return Err(RenderError::OutsideLimits);
        }
        self.entries
            .push((name.to_owned(), bytes.clone(), crc32(&bytes)));
        Ok(())
    }

    fn finish(self) -> Result<Vec<u8>, RenderError> {
        if self.entries.len() > u16::MAX as usize {
            return Err(RenderError::OutsideLimits);
        }
        let mut output = Vec::new();
        let mut central = Vec::new();
        for (name, bytes, crc) in self.entries {
            let offset = u32::try_from(output.len()).map_err(|_| RenderError::OutsideLimits)?;
            let size = u32::try_from(bytes.len()).map_err(|_| RenderError::OutsideLimits)?;
            let name_len = u16::try_from(name.len()).map_err(|_| RenderError::OutsideLimits)?;
            push_u32(&mut output, 0x0403_4b50);
            push_u16(&mut output, 20);
            push_u16(&mut output, 0x0800);
            push_u16(&mut output, 0);
            push_u16(&mut output, 0);
            push_u16(&mut output, 0x0021);
            push_u32(&mut output, crc);
            push_u32(&mut output, size);
            push_u32(&mut output, size);
            push_u16(&mut output, name_len);
            push_u16(&mut output, 0);
            output.extend_from_slice(name.as_bytes());
            output.extend_from_slice(&bytes);

            push_u32(&mut central, 0x0201_4b50);
            push_u16(&mut central, 20);
            push_u16(&mut central, 20);
            push_u16(&mut central, 0x0800);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0x0021);
            push_u32(&mut central, crc);
            push_u32(&mut central, size);
            push_u32(&mut central, size);
            push_u16(&mut central, name_len);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u16(&mut central, 0);
            push_u32(&mut central, 0);
            push_u32(&mut central, offset);
            central.extend_from_slice(name.as_bytes());
        }
        let central_offset = u32::try_from(output.len()).map_err(|_| RenderError::OutsideLimits)?;
        let central_size = u32::try_from(central.len()).map_err(|_| RenderError::OutsideLimits)?;
        output.extend_from_slice(&central);
        let count = u16::try_from(count_central_entries(&central))
            .map_err(|_| RenderError::OutsideLimits)?;
        push_u32(&mut output, 0x0605_4b50);
        push_u16(&mut output, 0);
        push_u16(&mut output, 0);
        push_u16(&mut output, count);
        push_u16(&mut output, count);
        push_u32(&mut output, central_size);
        push_u32(&mut output, central_offset);
        push_u16(&mut output, 0);
        Ok(output)
    }
}

fn count_central_entries(bytes: &[u8]) -> usize {
    bytes
        .windows(4)
        .filter(|window| *window == 0x0201_4b50_u32.to_le_bytes())
        .count()
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb8_8320_u32 & (0_u32.wrapping_sub(crc & 1)));
        }
    }
    !crc
}

fn push_u16(output: &mut Vec<u8>, value: u16) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn push_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

const ROOT_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"ppt/presentation.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/><Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/></Relationships>";
const SLIDE_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/></Relationships>";
const MASTER_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/><Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/></Relationships>";
const LAYOUT_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/></Relationships>";
const SLIDE_MASTER: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sldMaster xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" bg1=\"lt1\" bg2=\"lt2\" folHlink=\"folHlink\" hlink=\"hlink\" tx1=\"dk1\" tx2=\"dk2\"/><p:sldLayoutIdLst><p:sldLayoutId id=\"1\" r:id=\"rId1\"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>";
const SLIDE_LAYOUT: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sldLayout xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\" type=\"blank\" preserve=\"1\"><p:cSld name=\"Blank\"><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";
fn theme_xml(theme: &ResolvedRenderTheme) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Restork {}\"><a:themeElements><a:clrScheme name=\"Restork\"><a:dk1><a:srgbClr val=\"{}\"/></a:dk1><a:lt1><a:srgbClr val=\"{}\"/></a:lt1><a:dk2><a:srgbClr val=\"{}\"/></a:dk2><a:lt2><a:srgbClr val=\"{}\"/></a:lt2><a:accent1><a:srgbClr val=\"{}\"/></a:accent1><a:accent2><a:srgbClr val=\"{}\"/></a:accent2><a:accent3><a:srgbClr val=\"{}\"/></a:accent3><a:accent4><a:srgbClr val=\"F39819\"/></a:accent4><a:accent5><a:srgbClr val=\"40B98A\"/></a:accent5><a:accent6><a:srgbClr val=\"AF6BCE\"/></a:accent6><a:hlink><a:srgbClr val=\"{}\"/></a:hlink><a:folHlink><a:srgbClr val=\"{}\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Restork\"><a:majorFont><a:latin typeface=\"Arial\"/><a:ea typeface=\"\"/><a:cs typeface=\"Arial\"/></a:majorFont><a:minorFont><a:latin typeface=\"Arial\"/><a:ea typeface=\"\"/><a:cs typeface=\"Arial\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Restork\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>",
        xml(&theme.name_en),
        theme.foreground,
        theme.background,
        theme.muted,
        theme.background,
        theme.accent,
        theme.accent_secondary,
        theme.muted,
        theme.accent,
        theme.accent_secondary
    )
}

#[cfg(test)]
mod tests {
    use super::{RenderFormat, builtin_themes, render_deck};
    use restork_deliverables::deck::{ThemeLayout, ThemeSnapshot};
    use serde_json::json;

    fn deck() -> serde_json::Value {
        json!({
            "deck_id": "deck-fixture",
            "revision": 1,
            "language": "zh-CN",
            "spec_hash": "a".repeat(64),
            "ledger_hash": "b".repeat(64),
            "theme": {
                "theme_id": "restork-print",
                "version": 1,
                "content_hash": builtin_themes()[0].content_hash
            },
            "claims": {"claim-1": {"text": "本地优先 keeps private context local.", "citation_refs": ["source-1"]}},
            "slides": [{"action_title": "Restork 研究工作台", "claim_refs": ["claim-1"], "speaker_notes": []}]
        })
    }

    #[test]
    fn ships_native_and_ppt_master_compatibility_themes() {
        let themes = builtin_themes();
        assert_eq!(themes.len(), 10);
        let ids = themes
            .iter()
            .map(|theme| theme.theme_id)
            .collect::<std::collections::BTreeSet<_>>();
        let hashes = themes
            .iter()
            .map(|theme| theme.content_hash)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(ids.len(), themes.len());
        assert_eq!(hashes.len(), themes.len());
        assert!(themes.iter().all(|theme| theme.version == 1));
    }

    #[test]
    fn every_builtin_theme_changes_pptx_and_pdf_output_without_external_assets() {
        let mut pptx_hashes = std::collections::BTreeSet::new();
        let mut pdf_hashes = std::collections::BTreeSet::new();
        for theme in builtin_themes() {
            let mut value = deck();
            value["theme"] = json!({
                "theme_id": theme.theme_id,
                "version": theme.version,
                "content_hash": theme.content_hash,
            });
            let pptx = render_deck(&value, RenderFormat::Pptx).expect("pptx");
            let pdf = render_deck(&value, RenderFormat::Pdf).expect("pdf");
            assert_eq!(pptx.manifest.theme_hash, theme.content_hash);
            assert!(
                !pptx
                    .bytes
                    .windows(21)
                    .any(|part| part == b"TargetMode=\"External\"")
            );
            pptx_hashes.insert(pptx.manifest.artifact_hash);
            pdf_hashes.insert(pdf.manifest.artifact_hash);
        }
        assert_eq!(pptx_hashes.len(), 10);
        assert_eq!(pdf_hashes.len(), 10);
    }

    #[test]
    fn pptx_is_a_deterministic_macro_free_ooxml_zip() {
        let first = render_deck(&deck(), RenderFormat::Pptx).expect("pptx");
        let second = render_deck(&deck(), RenderFormat::Pptx).expect("pptx");
        assert_eq!(first.bytes, second.bytes);
        assert!(first.bytes.starts_with(b"PK\x03\x04"));
        assert!(
            first
                .bytes
                .windows(17)
                .any(|part| part == b"ppt/slides/slide1")
        );
        assert!(first.manifest.macro_free);
    }

    #[test]
    fn ppt_master_path_preserves_claims_as_role_aware_panels() {
        let theme = builtin_themes()
            .iter()
            .find(|theme| theme.theme_id == "ppt-master-mckinsey")
            .expect("PPT Master theme");
        let mut value = deck();
        value["theme"] = json!({
            "theme_id": theme.theme_id,
            "version": theme.version,
            "content_hash": theme.content_hash,
        });
        value["claims"] = json!({
            "claim-1": {"text": "A complete claim remains in one panel.", "citation_refs": ["source-1"]},
            "claim-2": {"text": "Words wrap inside that panel instead of becoming new panels.", "citation_refs": ["source-2"]},
        });
        value["slides"] = json!([{
            "role": "comparison",
            "action_title": "The compatibility path keeps page semantics",
            "claim_refs": ["claim-1", "claim-2"],
            "speaker_notes": []
        }]);

        let rendered = render_deck(&value, RenderFormat::Pptx).expect("pptx");
        assert_eq!(rendered.manifest.renderer_id, "restork-ppt-master-compat");
        assert_eq!(
            rendered
                .bytes
                .windows(b"Content panel".len())
                .filter(|part| *part == b"Content panel")
                .count(),
            2
        );
    }

    #[test]
    fn chart_and_table_roles_emit_drawingml_exhibits_without_external_parts() {
        let theme = builtin_themes()
            .iter()
            .find(|theme| theme.theme_id == "ppt-master-mckinsey")
            .expect("PPT Master theme");
        let mut value = deck();
        value["theme"] = json!({
            "theme_id": theme.theme_id,
            "version": theme.version,
            "content_hash": theme.content_hash,
        });
        value["claims"] = json!({
            "claim-north": {"text": "North | 42%", "citation_refs": ["source-1"]},
            "claim-south": {"text": "South | 27%", "citation_refs": ["source-2"]},
            "claim-table": {"text": "The exhibit uses verified evidence rows.", "citation_refs": ["source-3"]},
        });
        value["slides"] = json!([
            {
                "role": "chart",
                "action_title": "North leads the measured result",
                "claim_refs": ["claim-north", "claim-south"],
                "speaker_notes": [],
                "visuals": [],
            },
            {
                "role": "table",
                "action_title": "The comparison remains inspectable",
                "claim_refs": ["claim-table"],
                "speaker_notes": [],
                "visuals": [{
                    "kind": "table",
                    "alt_text": "Metric | Before | After\nLatency | 120 ms | 84 ms\nErrors | 12 | 3",
                    "asset_ref": null,
                }],
            },
        ]);

        let pptx = render_deck(&value, RenderFormat::Pptx).expect("pptx exhibits");
        let pdf = render_deck(&value, RenderFormat::Pdf).expect("pdf exhibits");
        assert!(
            pptx.bytes
                .windows(b"Bar 1".len())
                .any(|part| part == b"Bar 1")
        );
        assert!(
            pptx.bytes
                .windows(b"Bar 2".len())
                .any(|part| part == b"Bar 2")
        );
        assert!(
            pptx.bytes
                .windows(b"Exhibit table".len())
                .any(|part| part == b"Exhibit table")
        );
        assert!(
            pptx.bytes
                .windows(b"drawingml/2006/table".len())
                .any(|part| part == b"drawingml/2006/table")
        );
        assert!(
            !pptx
                .bytes
                .windows(b"c:chart".len())
                .any(|part| part == b"c:chart")
        );
        assert!(
            !pptx
                .bytes
                .windows(b"TargetMode=\"External\"".len())
                .any(|part| { part == b"TargetMode=\"External\"" })
        );
        assert!(
            pdf.bytes
                .windows(b"North".len())
                .any(|part| part == b"North")
        );
        assert!(
            pdf.bytes
                .windows(b"Latency".len())
                .any(|part| part == b"Latency")
        );
    }

    #[test]
    fn pdf_contains_one_unicode_page_and_a_valid_cross_reference() {
        let rendered = render_deck(&deck(), RenderFormat::Pdf).expect("pdf");
        assert!(rendered.bytes.starts_with(b"%PDF-1.7"));
        assert!(rendered.bytes.ends_with(b"%%EOF\n"));
        assert!(rendered.bytes.windows(4).any(|part| part == b"xref"));
        assert!(
            rendered
                .bytes
                .windows(b"/BaseFont /Helvetica".len())
                .any(|part| part == b"/BaseFont /Helvetica")
        );
        assert!(
            rendered
                .bytes
                .windows(b"keeps private context local.".len())
                .any(|part| part == b"keeps private context local.")
        );
        assert!(
            rendered
                .bytes
                .windows(b"/FontFile2 7 0 R".len())
                .any(|part| part == b"/FontFile2 7 0 R")
        );
        assert!(
            rendered
                .bytes
                .windows(b"/ToUnicode 8 0 R".len())
                .any(|part| part == b"/ToUnicode 8 0 R")
        );
        assert!(
            rendered
                .bytes
                .windows(b"+RestorkCJK".len())
                .any(|part| part == b"+RestorkCJK")
        );
        assert!(
            !rendered
                .bytes
                .windows(b"STSong-Light".len())
                .any(|part| part == b"STSong-Light")
        );
        assert!(rendered.bytes.len() < 512 * 1024, "font must be subset");
        assert!(
            rendered
                .manifest
                .validation_checks
                .contains(&"embedded_cjk_font_subset")
        );
        assert!(!rendered.bytes.windows(4).any(|part| part == b"FEFF"));
    }

    #[test]
    fn renders_a_frozen_user_theme_without_files_or_external_assets() {
        let snapshot = ThemeSnapshot::new(
            "theme-user-fixture",
            1,
            "Team review",
            "FFF7ED",
            "431407",
            "9A6B55",
            "EA580C",
            "E11D48",
            ThemeLayout::Narrative,
        )
        .expect("snapshot");
        let mut value = deck();
        value["theme"] = json!({
            "theme_id": snapshot.theme_id(),
            "version": snapshot.version(),
            "content_hash": snapshot.content_hash().expect("hash"),
        });
        value["theme_snapshot"] = serde_json::to_value(&snapshot).expect("serialize snapshot");

        let rendered = render_deck(&value, RenderFormat::Pptx).expect("custom theme pptx");
        assert!(rendered.manifest.macro_free);
        assert_eq!(
            rendered.manifest.theme_hash,
            snapshot.content_hash().expect("hash")
        );

        value["theme_snapshot"]["accent"] = json!("000000");
        assert!(render_deck(&value, RenderFormat::Pptx).is_err());
    }
}
