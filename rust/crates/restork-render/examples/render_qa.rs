use std::{env, fs, path::PathBuf};

use restork_render::{RenderFormat, builtin_theme, render_deck};
use serde_json::json;

fn main() {
    let theme_id = env::args()
        .nth(1)
        .unwrap_or_else(|| "ppt-master-mckinsey".to_owned());
    let output = env::args()
        .nth(2)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("artifacts/ppt-master-compat-qa"));
    let language = env::args().nth(3).unwrap_or_else(|| "en-US".to_owned());
    let theme = builtin_theme(&theme_id).expect("known built-in theme");
    let (claims, slides) = if language == "zh-CN" {
        (
            json!({
                "claim:local": {"text": "Restork 在本机保留证据账本和交付物审批记录。", "citation_refs": ["source:brief"]},
                "claim:roles": {"text": "兼容渲染器会保留封面、比较、时间线、架构和结论等页面角色。", "citation_refs": ["source:brief"]},
                "claim:preview": {"text": "预览卡片与导出的幻灯片使用同一套角色化视觉语法。", "citation_refs": ["source:brief"]},
                "claim:safety": {"text": "导出结果保持确定性、无宏，并且不包含外部关系。", "citation_refs": ["source:brief"]},
                "claim:north": {"text": "北区 | 42%", "citation_refs": ["source:brief"]},
                "claim:south": {"text": "南区 | 27%", "citation_refs": ["source:brief"]},
                "claim:table": {"text": "关键指标以结构化表格保留。", "citation_refs": ["source:brief"]}
            }),
            json!([
                {"role": "title", "action_title": "PPT Master 兼容渲染已成为真实导出路径", "claim_refs": ["claim:roles"]},
                {"role": "evidence", "action_title": "证据与交付物审批仍然留在 Restork 内部", "claim_refs": ["claim:local", "claim:safety"]},
                {"role": "comparison", "action_title": "原生与兼容渲染器服务于不同的演示需求", "claim_refs": ["claim:local", "claim:roles", "claim:preview", "claim:safety"]},
                {"role": "timeline", "action_title": "一份演示稿从引用提纲走向预览与批准导出", "claim_refs": ["claim:local", "claim:roles", "claim:preview", "claim:safety"]},
                {"role": "architecture", "action_title": "角色化布局位于证据账本与 OOXML 导出之间", "claim_refs": ["claim:local", "claim:roles", "claim:safety"]},
                {"role": "chart", "action_title": "北区在已核验结果中领先", "claim_refs": ["claim:north", "claim:south"]},
                {"role": "table", "action_title": "关键指标保持可审阅与可编辑", "claim_refs": ["claim:table"], "visuals": [{"kind": "table", "alt_text": "指标 | 之前 | 之后\n延迟 | 120 ms | 84 ms\n错误 | 12 | 3", "asset_ref": null}]},
                {"role": "conclusion", "action_title": "先预览真实构图，再导出同一套视觉系统", "claim_refs": ["claim:preview", "claim:safety"]}
            ]),
        )
    } else {
        (
            json!({
                "claim:local": {"text": "Restork keeps the evidence ledger and artifact approval local.", "citation_refs": ["source:brief"]},
                "claim:roles": {"text": "The compatibility renderer preserves title, comparison, timeline, architecture and conclusion roles.", "citation_refs": ["source:brief"]},
                "claim:preview": {"text": "Preview cards use the same role-aware visual grammar as exported slides.", "citation_refs": ["source:brief"]},
                "claim:safety": {"text": "Exports remain deterministic, macro-free and free of external relationships.", "citation_refs": ["source:brief"]},
                "claim:north": {"text": "North | 42%", "citation_refs": ["source:brief"]},
                "claim:south": {"text": "South | 27%", "citation_refs": ["source:brief"]},
                "claim:table": {"text": "Key metrics remain in a structured table.", "citation_refs": ["source:brief"]}
            }),
            json!([
                {"role": "title", "action_title": "PPT Master compatibility is now a real render path", "claim_refs": ["claim:roles"]},
                {"role": "evidence", "action_title": "Evidence and artifact approval stay inside Restork", "claim_refs": ["claim:local", "claim:safety"]},
                {"role": "comparison", "action_title": "Native and compatibility renderers serve different presentation needs", "claim_refs": ["claim:local", "claim:roles", "claim:preview", "claim:safety"]},
                {"role": "timeline", "action_title": "A deck moves from cited outline to preview to approved export", "claim_refs": ["claim:local", "claim:roles", "claim:preview", "claim:safety"]},
                {"role": "architecture", "action_title": "Role-aware layout sits between the evidence ledger and OOXML export", "claim_refs": ["claim:local", "claim:roles", "claim:safety"]},
                {"role": "chart", "action_title": "North leads the verified result", "claim_refs": ["claim:north", "claim:south"]},
                {"role": "table", "action_title": "Key metrics stay inspectable and editable", "claim_refs": ["claim:table"], "visuals": [{"kind": "table", "alt_text": "Metric | Before | After\nLatency | 120 ms | 84 ms\nErrors | 12 | 3", "asset_ref": null}]},
                {"role": "conclusion", "action_title": "Preview the real composition, then export the same visual system", "claim_refs": ["claim:preview", "claim:safety"]}
            ]),
        )
    };
    let deck = json!({
        "deck_id": "ppt-master-compat-qa",
        "revision": 1,
        "language": language,
        "spec_hash": "a".repeat(64),
        "ledger_hash": "b".repeat(64),
        "theme": {
            "theme_id": theme.theme_id,
            "version": theme.version,
            "content_hash": theme.content_hash
        },
        "claims": claims,
        "slides": slides
    });
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).expect("create output directory");
    }
    for format in [RenderFormat::Pptx, RenderFormat::Pdf] {
        let rendered = render_deck(&deck, format).expect("render fixture");
        let path = output.with_extension(format.extension());
        fs::write(&path, &rendered.bytes).expect("write rendered fixture");
        println!(
            "{} {} {} {}",
            path.display(),
            rendered.manifest.renderer_id,
            rendered.manifest.byte_count,
            rendered.manifest.artifact_hash
        );
    }
}
