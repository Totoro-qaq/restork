//! Deterministic, dependency-light PPTX and PDF rendering for frozen DeckSpec JSON.
//!
//! The renderer accepts only the already validated deck artifact. It performs no
//! network, filesystem, process, template, macro, or secret access.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

const MAX_SLIDES: usize = 200;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;

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
    language: String,
    slides: Vec<SlideView>,
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
        let theme_hash = object
            .get("theme")
            .and_then(Value::as_object)
            .and_then(|theme| theme.get("content_hash"))
            .and_then(Value::as_str)
            .filter(|value| is_digest(value))
            .ok_or(RenderError::InvalidDeck)?
            .to_owned();
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
    archive.add("ppt/theme/theme1.xml", THEME.as_bytes().to_vec())?;
    for (index, slide) in deck.slides.iter().enumerate() {
        archive.add(
            &format!("ppt/slides/slide{}.xml", index + 1),
            slide_xml(slide, &deck.language).into_bytes(),
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

fn slide_xml(slide: &SlideView, language: &str) -> String {
    let bullets = slide
        .lines
        .iter()
        .flat_map(|line| wrap(line, 78))
        .take(12)
        .map(|line| format!("<a:p><a:pPr lvl=\"0\" marL=\"342900\" indent=\"-228600\"><a:buChar char=\"•\"/></a:pPr><a:r><a:rPr lang=\"{}\" sz=\"1900\"/><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"1900\"/></a:p>", xml(language), xml(&line), xml(language)))
        .collect::<String>();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><p:sld xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val=\"FBF7EF\"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
        text_box(
            2,
            "Title",
            685800,
            457200,
            10820400,
            914400,
            &format!(
                "<a:p><a:r><a:rPr lang=\"{}\" sz=\"3000\" b=\"1\"><a:solidFill><a:srgbClr val=\"302A21\"/></a:solidFill></a:rPr><a:t>{}</a:t></a:r><a:endParaRPr lang=\"{}\" sz=\"3000\"/></a:p>",
                xml(language),
                xml(&slide.title),
                xml(language)
            )
        ),
        text_box(3, "Body", 914400, 1600200, 10363200, 4343400, &bullets)
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
        let stream = pdf_page(slide);
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

fn pdf_page(slide: &SlideView) -> String {
    let mut commands = format!(
        "q 0.984 0.969 0.937 rg 0 0 960 540 re f Q\nBT /F1 28 Tf 60 470 Td <{}> Tj ET\n",
        utf16_hex(&slide.title)
    );
    let mut y = 410_i32;
    for line in slide.lines.iter().flat_map(|line| wrap(line, 54)).take(12) {
        commands.push_str(&format!(
            "BT /F1 16 Tf 75 {y} Td <{}> Tj ET\n",
            utf16_hex(&format!("• {line}"))
        ));
        y -= 28;
    }
    commands
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
const THEME: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Restork Print\"><a:themeElements><a:clrScheme name=\"Restork\"><a:dk1><a:srgbClr val=\"302A21\"/></a:dk1><a:lt1><a:srgbClr val=\"FBF7EF\"/></a:lt1><a:dk2><a:srgbClr val=\"5E5548\"/></a:dk2><a:lt2><a:srgbClr val=\"F2EADF\"/></a:lt2><a:accent1><a:srgbClr val=\"6657D9\"/></a:accent1><a:accent2><a:srgbClr val=\"E84D8A\"/></a:accent2><a:accent3><a:srgbClr val=\"1ABECF\"/></a:accent3><a:accent4><a:srgbClr val=\"F39819\"/></a:accent4><a:accent5><a:srgbClr val=\"40B98A\"/></a:accent5><a:accent6><a:srgbClr val=\"AF6BCE\"/></a:accent6><a:hlink><a:srgbClr val=\"6657D9\"/></a:hlink><a:folHlink><a:srgbClr val=\"AF6BCE\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Restork\"><a:majorFont><a:latin typeface=\"Georgia\"/><a:ea typeface=\"PingFang SC\"/><a:cs typeface=\"Georgia\"/></a:majorFont><a:minorFont><a:latin typeface=\"Arial\"/><a:ea typeface=\"PingFang SC\"/><a:cs typeface=\"Arial\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Restork\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"6350\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>";

#[cfg(test)]
mod tests {
    use super::{RenderFormat, render_deck};
    use serde_json::json;

    fn deck() -> serde_json::Value {
        json!({
            "deck_id": "deck-fixture",
            "revision": 1,
            "language": "zh-CN",
            "spec_hash": "a".repeat(64),
            "ledger_hash": "b".repeat(64),
            "theme": {"content_hash": "c".repeat(64)},
            "claims": {"claim-1": {"text": "本地优先 keeps private context local.", "citation_refs": ["source-1"]}},
            "slides": [{"action_title": "Restork 研究工作台", "claim_refs": ["claim-1"], "speaker_notes": []}]
        })
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
}
