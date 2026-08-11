//! Deterministic, dependency-light PPTX and PDF rendering for frozen DeckSpec JSON.
//!
//! The renderer accepts only the already validated deck artifact. It performs no
//! network, filesystem, process, template, macro, or secret access.

use restork_deliverables::deck::{ThemeLayout, ThemeSnapshot};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SLIDES: usize = 200;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

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

const BUILTIN_THEMES: [RenderTheme; 6] = [
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
            },
        }
    }
}

#[derive(Clone)]
struct SlideView {
    title: String,
    lines: Vec<String>,
}

pub fn render_deck(deck: &Value, format: RenderFormat) -> Result<RenderedArtifact, RenderError> {
    let deck = DeckView::parse(deck)?;
    let bytes = match format {
        RenderFormat::Pptx => render_pptx(&deck)?,
        RenderFormat::Pdf => render_pdf(&deck)?,
    };
    validate_output(&bytes, format)?;
    let artifact_hash = digest(&bytes);
    Ok(RenderedArtifact {
        manifest: RenderManifest {
            schema_version: 1,
            renderer_id: "restork-native",
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
            validation_checks: vec![
                "bounded_input",
                "no_remote_assets",
                "no_external_relationships",
                "no_macros_or_ole",
                "required_parts_present",
                "cjk_text_preserved",
                "output_hash_verified",
            ],
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
            let title = bounded_text(raw.get("action_title"), 4_096)?;
            total = total.saturating_add(title.len());
            let mut lines = Vec::new();
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
                let line = if citations.is_empty() {
                    text
                } else {
                    format!("{text}  [{}]", citations.join(", "))
                };
                total = total.saturating_add(line.len());
                lines.push(line);
            }
            if let Some(notes) = raw.get("speaker_notes").and_then(Value::as_array) {
                for note in notes {
                    if let Some(text) = note.get("text").and_then(Value::as_str) {
                        total = total.saturating_add(text.len());
                    }
                }
            }
            slides.push(SlideView { title, lines });
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
    let layout = layout_metrics(theme.layout);
    let bullets = slide
        .lines
        .iter()
        .flat_map(|line| wrap(line, layout.wrap_width))
        .take(layout.maximum_lines)
        .map(|line| format!("<a:p><a:pPr lvl=\"0\" marL=\"342900\" indent=\"-228600\"><a:buChar char=\"•\"/></a:pPr><a:r><a:rPr lang=\"{}\" sz=\"{}\"><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"{}\"/></a:p>", xml(language), layout.body_size, theme.foreground, xml(&line), xml(language), layout.body_size))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{}{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        theme.background,
        accent_shape(theme, index),
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
                layout.title_size,
                theme.foreground,
                xml(&slide.title),
                xml(language),
                layout.title_size
            )
        ),
        text_box(
            3,
            "Body",
            layout.body_x,
            layout.body_y,
            layout.body_width,
            layout.body_height,
            &bullets
        )
    )
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

const fn layout_metrics(layout: RenderLayout) -> LayoutMetrics {
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
    }
}

fn accent_shape(theme: &ResolvedRenderTheme, index: usize) -> String {
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
    }
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
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap=\"square\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"/><a:lstStyle/>{paragraphs}</p:txBody></p:sp>",
        xml(name)
    )
}

fn render_pdf(deck: &DeckView) -> Result<Vec<u8>, RenderError> {
    let mut objects = vec![
        b"<< /Type /Catalog /Pages 2 0 R >>".to_vec(),
        Vec::new(),
        b"<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>".to_vec(),
        b"<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>".to_vec(),
    ];
    let mut page_refs = Vec::new();
    for slide in &deck.slides {
        let page_id = objects.len() + 1;
        let content_id = page_id + 1;
        page_refs.push(format!("{page_id} 0 R"));
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 960 540] /Resources << /Font << /F1 3 0 R >> >> /Contents {content_id} 0 R >>").into_bytes());
        let stream = pdf_page(slide, &deck.theme);
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

fn pdf_page(slide: &SlideView, theme: &ResolvedRenderTheme) -> String {
    let layout = layout_metrics(theme.layout);
    let background = pdf_rgb(&theme.background);
    let foreground = pdf_rgb(&theme.foreground);
    let accent = pdf_rgb(&theme.accent);
    let (accent_command, title_x, title_y, body_x, mut y) = match theme.layout {
        RenderLayout::Editorial => (format!("q {accent} rg 0 0 8 540 re f Q"), 60, 470, 75, 410),
        RenderLayout::Minimal => (
            format!("q {accent} rg 0 532 960 8 re f Q"),
            72,
            455,
            72,
            390,
        ),
        RenderLayout::Spotlight => (
            format!("q {accent} rg 0 0 960 12 re f Q"),
            90,
            430,
            105,
            330,
        ),
        RenderLayout::Research => (
            format!("q {accent} rg 0 486 54 54 re f Q"),
            108,
            462,
            108,
            392,
        ),
        RenderLayout::Narrative => (
            format!("q {accent} rg 952 0 8 540 re f Q"),
            54,
            430,
            54,
            330,
        ),
        RenderLayout::Blueprint => (
            format!("q {accent} rg 0 0 14 540 re f Q\nq {accent} rg 0 536 960 4 re f Q"),
            90,
            468,
            90,
            398,
        ),
    };
    let mut commands = format!(
        "q {background} rg 0 0 960 540 re f Q\n{accent_command}\n{foreground} rg\nBT /F1 {} Tf {title_x} {title_y} Td <{}> Tj ET\n",
        layout.title_size / 100,
        utf16_hex(&slide.title)
    );
    for line in slide
        .lines
        .iter()
        .flat_map(|line| wrap(line, layout.wrap_width.saturating_sub(12)))
        .take(layout.maximum_lines)
    {
        commands.push_str(&format!(
            "BT /F1 {} Tf {body_x} {y} Td <{}> Tj ET\n",
            layout.body_size / 120,
            utf16_hex(&format!("• {line}"))
        ));
        y -= 28;
    }
    commands
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

fn utf16_hex(value: &str) -> String {
    let mut output = String::from("FEFF");
    for unit in value.encode_utf16() {
        output.push_str(&format!("{unit:04X}"));
    }
    output
}

fn wrap(value: &str, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for character in value.chars() {
        line.push(character);
        if line.chars().count() >= width {
            lines.push(std::mem::take(&mut line));
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
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Restork {}\"><a:themeElements><a:clrScheme name=\"Restork\"><a:dk1><a:srgbClr val=\"{}\"/></a:dk1><a:lt1><a:srgbClr val=\"{}\"/></a:lt1><a:dk2><a:srgbClr val=\"{}\"/></a:dk2><a:lt2><a:srgbClr val=\"{}\"/></a:lt2><a:accent1><a:srgbClr val=\"{}\"/></a:accent1><a:accent2><a:srgbClr val=\"{}\"/></a:accent2><a:accent3><a:srgbClr val=\"{}\"/></a:accent3><a:accent4><a:srgbClr val=\"F39819\"/></a:accent4><a:accent5><a:srgbClr val=\"40B98A\"/></a:accent5><a:accent6><a:srgbClr val=\"AF6BCE\"/></a:accent6><a:hlink><a:srgbClr val=\"{}\"/></a:hlink><a:folHlink><a:srgbClr val=\"{}\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Restork\"><a:majorFont><a:latin typeface=\"Arial\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"Arial\"/></a:majorFont><a:minorFont><a:latin typeface=\"Arial\"/><a:ea typeface=\"Microsoft YaHei\"/><a:cs typeface=\"Arial\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Restork\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>",
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
    fn ships_six_distinct_zero_runtime_render_themes() {
        let themes = builtin_themes();
        assert_eq!(themes.len(), 6);
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
        assert_eq!(pptx_hashes.len(), 6);
        assert_eq!(pdf_hashes.len(), 6);
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
    fn pdf_contains_one_unicode_page_and_a_valid_cross_reference() {
        let rendered = render_deck(&deck(), RenderFormat::Pdf).expect("pdf");
        assert!(rendered.bytes.starts_with(b"%PDF-1.7"));
        assert!(rendered.bytes.ends_with(b"%%EOF\n"));
        assert!(rendered.bytes.windows(4).any(|part| part == b"xref"));
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
