//! A ratchet on the crate's shape.
//!
//! `lib.rs` reached 9,464 lines while owning every one of the 104 routes, and the
//! consolidation spec requires it to shrink rather than grow. Splitting it once
//! is not enough: without a gate it simply regrows, which is exactly what
//! happened between Stage 1 and Stage 6.
//!
//! The ceilings below MUST only ever be lowered.

use std::{collections::BTreeSet, fs};

/// Generous enough that ordinary edits pass, tight enough that a new domain has
/// to become its own module instead of being appended to the root.
const LIB_MAXIMUM_LINES: usize = 4_200;

/// No single module should become the next `lib.rs`.
const MODULE_MAXIMUM_LINES: usize = 3_600;

/// Every module in `src/`, listed explicitly.
///
/// An allowlist rather than a directory walk, for two reasons. It keeps the
/// ceilings applied to known names instead of to paths assembled from a
/// directory scan, and it makes adding a module a deliberate act:
/// `every_module_is_accounted_for` fails until a new file appears here.
const MODULES: &[&str] = &[
    "agent_tools",
    "automation_api",
    "catalog_api",
    "config_api",
    "daily_api",
    "feature_api",
    "session_api",
];

/// Reads one file from `src/` by name. The name always comes from [`MODULES`] or
/// is the literal `lib.rs`, never from a directory listing.
fn source_line_count(file_name: &str) -> usize {
    let path = format!("{}/src/{file_name}", env!("CARGO_MANIFEST_DIR"));
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {path}: {error}"))
        .lines()
        .count()
}

fn module_file_names() -> BTreeSet<String> {
    let source = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
    fs::read_dir(&source)
        .unwrap_or_else(|error| panic!("read {source}: {error}"))
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".rs") && name != "lib.rs")
        .collect()
}

#[test]
fn the_crate_root_stays_split() {
    let lines = source_line_count("lib.rs");
    assert!(
        lines <= LIB_MAXIMUM_LINES,
        "src/lib.rs is {lines} lines, over the {LIB_MAXIMUM_LINES} ceiling. \
         Move a domain into its own module rather than raising this number."
    );
}

#[test]
fn no_module_becomes_the_next_monolith() {
    let oversized: Vec<String> = MODULES
        .iter()
        .filter_map(|module| {
            let lines = source_line_count(&format!("{module}.rs"));
            (lines > MODULE_MAXIMUM_LINES).then(|| format!("{module}.rs: {lines} lines"))
        })
        .collect();
    assert!(
        oversized.is_empty(),
        "modules over the {MODULE_MAXIMUM_LINES} line ceiling:\n{}",
        oversized.join("\n")
    );
}

/// A new module must join the ratchet, and a listed one must not vanish. Without
/// this, the allowlist above would silently stop covering the crate.
#[test]
fn every_module_is_accounted_for() {
    let on_disk = module_file_names();
    let listed: BTreeSet<String> = MODULES.iter().map(|m| format!("{m}.rs")).collect();

    let unlisted: Vec<&String> = on_disk.difference(&listed).collect();
    assert!(
        unlisted.is_empty(),
        "these modules exist but are not in MODULES, so no ceiling applies to them: {unlisted:?}"
    );

    let missing: Vec<&String> = listed.difference(&on_disk).collect();
    assert!(
        missing.is_empty(),
        "MODULES lists files that no longer exist: {missing:?}"
    );
}

/// The domain modules must actually be reachable, so a split cannot be faked by
/// leaving an orphaned file on disk.
#[test]
fn every_domain_module_is_declared() {
    let lib = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("read lib.rs");
    for module in MODULES {
        assert!(
            lib.contains(&format!("mod {module};")),
            "src/lib.rs does not declare `mod {module};`"
        );
    }
}
