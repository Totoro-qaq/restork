use serde_json::Value;

#[test]
fn rust_build_consumes_the_checked_in_cross_runtime_schema_bundle() {
    let source = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../contracts/restork-v1.schema.json"
    ));
    let bundle: Value = serde_json::from_str(source).expect("valid schema bundle");

    assert_eq!(bundle["bundle_version"], 1);
    assert_eq!(bundle["protocol"], "restork-v1");
    assert_eq!(bundle["schemas"]["TaskSpec"]["additionalProperties"], false);
}
