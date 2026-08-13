//! Strip skill instruction bodies from Dashboard-facing JSON.
//!
//! Storage keeps the full `SkillManifest` so run spawn can inject instructions.
//! HTTP responses must not include those bodies or reference file contents.

use restork_storage::{ExtensionPage, ExtensionRecord, ExtensionRevisionRecord};
use serde_json::Value;

pub(crate) fn record(record: ExtensionRecord) -> Value {
    redact_value(serde_json::to_value(record).unwrap_or(Value::Null))
}

pub(crate) fn page(page: ExtensionPage) -> Value {
    redact_value(serde_json::to_value(page).unwrap_or(Value::Null))
}

pub(crate) fn records(items: Vec<ExtensionRecord>) -> Value {
    redact_value(Value::Array(
        items
            .into_iter()
            .map(|item| serde_json::to_value(item).unwrap_or(Value::Null))
            .collect(),
    ))
}

pub(crate) fn revisions(items: Vec<ExtensionRevisionRecord>) -> Value {
    redact_value(serde_json::json!({ "items": items }))
}

pub(crate) fn redact_manifest(manifest: &mut Value) {
    let Some(object) = manifest.as_object_mut() else {
        return;
    };
    object.remove("instructions");
    if let Some(references) = object.get_mut("references").and_then(Value::as_array_mut) {
        for item in references {
            if let Some(reference) = item.as_object_mut() {
                reference.remove("content");
            }
        }
    }
}

pub(crate) fn redact_value(mut value: Value) -> Value {
    redact_in_place(&mut value);
    value
}

fn redact_in_place(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                redact_in_place(item);
            }
        }
        Value::Object(object) => {
            let is_skill = object.get("package_kind").and_then(Value::as_str) == Some("skill");
            if is_skill && let Some(manifest) = object.get_mut("manifest") {
                redact_manifest(manifest);
            }
            for child in object.values_mut() {
                redact_in_place(child);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn skill_record() -> Value {
        json!({
            "package_id": "ppt-master",
            "package_kind": "skill",
            "manifest": {
                "display_name": "ppt-master",
                "keywords": ["ppt"],
                "default_mode": "research",
                "instructions": "Keep every claim cited",
                "references": [{
                    "path": "references/outline.md",
                    "sha256": "ab",
                    "content": "# Outline"
                }],
                "import_report": {
                    "imported": [{
                        "kind": "instructions",
                        "bytes": 24,
                        "sha256": "cd"
                    }],
                    "stripped": []
                }
            },
            "manifest_hash": "aa",
            "state": "enabled"
        })
    }

    #[test]
    fn skill_http_json_drops_instruction_bodies_and_keeps_hashes() {
        let redacted = redact_value(skill_record());
        let manifest = &redacted["manifest"];
        assert!(manifest.get("instructions").is_none());
        assert!(manifest["references"][0].get("content").is_none());
        assert_eq!(manifest["references"][0]["sha256"], "ab");
        assert_eq!(manifest["import_report"]["imported"][0]["sha256"], "cd");
        assert_eq!(manifest["display_name"], "ppt-master");
        assert_eq!(manifest["keywords"][0], "ppt");
        assert_eq!(manifest["default_mode"], "research");
        let encoded = redacted.to_string();
        assert!(!encoded.contains("Keep every claim cited"));
        assert!(!encoded.contains("# Outline"));
    }

    #[test]
    fn mcp_http_json_is_left_intact() {
        let original = json!({
            "package_id": "paper-mcp",
            "package_kind": "mcp",
            "manifest": {
                "instructions": "not a skill body",
                "tools": [{"id": "search"}]
            }
        });
        let redacted = redact_value(original.clone());
        assert_eq!(redacted, original);
    }

    #[test]
    fn bootstrap_extension_array_is_redacted() {
        let redacted = redact_value(json!([skill_record()]));
        assert!(redacted[0]["manifest"].get("instructions").is_none());
    }
}
