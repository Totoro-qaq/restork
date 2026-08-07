//! A ratchet on the crate's shape.
//!
//! `lib.rs` reached 9,464 lines while owning every one of the 104 routes, and the
//! consolidation spec requires it to shrink rather than grow. Splitting it once
//! is not enough: without a gate it simply regrows, which is exactly what
//! happened between Stage 1 and Stage 6.
//!
//! The ceilings below MUST only ever be lowered.

use std::{fs, path::Path};

/// Generous enough that ordinary edits pass, tight enough that a new domain has
/// to become its own module instead of being appended to the root.
const LIB_MAXIMUM_LINES: usize = 4_200;

/// No single module should become the next `lib.rs`.
const MODULE_MAXIMUM_LINES: usize = 3_600;

fn line_count(path: &Path) -> usize {
    fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
        .lines()
        .count()
}

fn source_dir() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
}

#[test]
fn the_crate_root_stays_split() {
    let lib = source_dir().join("src/lib.rs");
    let lines = line_count(&lib);
    assert!(
        lines <= LIB_MAXIMUM_LINES,
        "src/lib.rs is {lines} lines, over the {LIB_MAXIMUM_LINES} ceiling. \
         Move a domain into its own module rather than raising this number."
    );
}

#[test]
fn no_module_becomes_the_next_monolith() {
    let source = source_dir().join("src");
    let mut oversized = Vec::new();
    for entry in fs::read_dir(&source).expect("read src") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|value| value.to_str()) != Some("rs") {
            continue;
        }
        if path.file_name().and_then(|value| value.to_str()) == Some("lib.rs") {
            continue;
        }
        let lines = line_count(&path);
        if lines > MODULE_MAXIMUM_LINES {
            oversized.push(format!("{}: {lines} lines", path.display()));
        }
    }
    assert!(
        oversized.is_empty(),
        "modules over the {MODULE_MAXIMUM_LINES} line ceiling:\n{}",
        oversized.join("\n")
    );
}

/// The domain modules must actually be reachable, so a split cannot be faked by
/// leaving an orphaned file on disk.
#[test]
fn every_domain_module_is_declared() {
    let lib = fs::read_to_string(source_dir().join("src/lib.rs")).expect("read lib.rs");
    for module in [
        "agent_tools",
        "automation_api",
        "catalog_api",
        "config_api",
        "daily_api",
        "feature_api",
        "session_api",
    ] {
        assert!(
            lib.contains(&format!("mod {module};")),
            "src/lib.rs does not declare `mod {module};`"
        );
    }
}
