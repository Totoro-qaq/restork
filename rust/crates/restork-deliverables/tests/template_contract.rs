use restork_deliverables::{
    DeliverableError,
    template::{
        ArchiveEntryMetadata, ArchiveLimits, ArchiveRelationship, TemplateArchiveMetadata,
        scan_template_archive,
    },
};

fn hash(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn safe_archive() -> TemplateArchiveMetadata {
    TemplateArchiveMetadata::new(
        "brand.pptx",
        hash('a'),
        [
            ArchiveEntryMetadata::new(
                "[Content_Types].xml",
                1_000,
                3_000,
                Some("application/xml"),
                false,
            ),
            ArchiveEntryMetadata::new(
                "ppt/presentation.xml",
                2_000,
                5_000,
                Some("application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"),
                false,
            ),
            ArchiveEntryMetadata::new(
                "ppt/slides/slide1.xml",
                1_000,
                4_000,
                Some("application/vnd.openxmlformats-officedocument.presentationml.slide+xml"),
                false,
            ),
            ArchiveEntryMetadata::new(
                "ppt/slideLayouts/slideLayout1.xml",
                1_000,
                4_000,
                Some("application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"),
                false,
            ),
        ],
        [ArchiveRelationship::new(
            "ppt/slides/slide1.xml",
            "../slideLayouts/slideLayout1.xml",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
            false,
        )],
    )
    .unwrap()
}

#[test]
fn accepts_a_bounded_macro_free_local_template() {
    let report = scan_template_archive(&safe_archive(), &ArchiveLimits::default()).unwrap();
    assert_eq!(report.entry_count(), 4);
    assert_eq!(report.total_uncompressed_bytes(), 16_000);
}

#[test]
fn rejects_macro_enabled_archives_and_embedded_ole() {
    let macro_archive = TemplateArchiveMetadata::new("brand.pptm", hash('a'), [], []).unwrap();
    assert!(matches!(
        scan_template_archive(&macro_archive, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));

    let disguised_macro = TemplateArchiveMetadata::new(
        "brand.pptx",
        hash('a'),
        [
            ArchiveEntryMetadata::new("[Content_Types].xml", 10, 10, None, false),
            ArchiveEntryMetadata::new("ppt/presentation.xml", 10, 10, None, false),
            ArchiveEntryMetadata::new("ppt/vbaProject.bin", 10, 10, None, false),
        ],
        [],
    )
    .unwrap();
    assert!(matches!(
        scan_template_archive(&disguised_macro, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));

    let archive = TemplateArchiveMetadata::new(
        "brand.pptx",
        hash('a'),
        [
            ArchiveEntryMetadata::new("[Content_Types].xml", 10, 10, None, false),
            ArchiveEntryMetadata::new("ppt/presentation.xml", 10, 10, None, false),
            ArchiveEntryMetadata::new("ppt/embeddings/oleObject1.bin", 10, 10, None, false),
        ],
        [],
    )
    .unwrap();
    assert!(matches!(
        scan_template_archive(&archive, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));
}

#[test]
fn rejects_path_traversal_and_external_relationships() {
    let traversing = TemplateArchiveMetadata::new(
        "brand.pptx",
        hash('a'),
        [ArchiveEntryMetadata::new(
            "../escape.xml",
            10,
            10,
            None,
            false,
        )],
        [],
    )
    .unwrap();
    assert!(matches!(
        scan_template_archive(&traversing, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));

    let mut external = safe_archive();
    external.replace_relationships([ArchiveRelationship::new(
        "ppt/slides/slide1.xml",
        "https://tracker.invalid/pixel",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
        true,
    )]);
    assert!(matches!(
        scan_template_archive(&external, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));

    let mut escaping_relationship = safe_archive();
    escaping_relationship.replace_relationships([ArchiveRelationship::new(
        "ppt/slides/slide1.xml",
        "../../../outside.xml",
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
        false,
    )]);
    assert!(matches!(
        scan_template_archive(&escaping_relationship, &ArchiveLimits::default()),
        Err(DeliverableError::UnsafeTemplate { .. })
    ));
}

#[test]
fn rejects_zip_bomb_metadata() {
    let archive = TemplateArchiveMetadata::new(
        "brand.pptx",
        hash('a'),
        [
            ArchiveEntryMetadata::new("[Content_Types].xml", 10, 10, None, false),
            ArchiveEntryMetadata::new("ppt/presentation.xml", 1, 100_000, None, false),
        ],
        [],
    )
    .unwrap();

    assert!(matches!(
        scan_template_archive(&archive, &ArchiveLimits::default()),
        Err(DeliverableError::ArchiveLimitExceeded { .. })
    ));
}
