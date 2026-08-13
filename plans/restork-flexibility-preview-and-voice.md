# Restork 参数灵活性、预览交互与产品语气 — 实施计划

> Spec：[docs/specs/flexibility-preview-and-voice.zh-CN.md](../docs/specs/flexibility-preview-and-voice.zh-CN.md)
> 纪律：每 Gate 独立 PR；先写失败测试；安全边界枚举禁改；文案事实内容零削弱

## Gate F1 — 参数灵活性

- [ ] 失败测试：slide_count 1–60 边界 + 空值自动 + 61 拒绝（前端与 Core 双侧）
- [ ] 页数下拉 → number 输入（inputmode/min/max/就地错误/留空＝自动）；Core 值域同源常量
- [ ] 自动化 recurrence 增加 `every_n_days`（2–365）：Rust 严格反序列化 + 表单 + 序列化测试
- [ ] 时区 select → 可过滤 combobox（键盘可达，空值＝跟随系统）
- [ ] 安全边界枚举锁定测试（data_class/update_channel/priority/expertise/package_kind）
- [ ] 验收：FLEX-001~005

## Gate F2 — 统一预览层

- [ ] 失败测试：打开预览布局零位移；焦点困于 dialog 并返回触发器
- [ ] 共享 `preview-dialog` 组件（styles.css 复用 dialog 家族；窄屏全屏；reduced-motion 无过渡）
- [ ] 迁移：deck 逐页预览（←→ 翻页 + 页码）、报告草稿、知识库源文件、交接包文件内容
- [ ] 保留类 details 全部加 `max-height + overflow:auto`
- [ ] 下载按钮语法统一（dialog 内外同一套）
- [ ] 验收：PREV-001~004

## Gate F3 — 语气与温度（最后做，吸收 F1/F2 新字符串）

- [ ] `docs/voice.zh-CN.md` 落库（八条规则 + 温度分级表 + 好坏示例）
- [ ] 首批清单改写（交付物页副标题/ribbon/eyebrow、空库状态、Web 授权提示、完成引导行），PR 附 before/after 表
- [ ] 全量审查四类字符串：开始页、交付物、设置、错误/等待/空状态
- [ ] 新 `scripts/check_voice.py`：禁用词（系统/用户/本产品）+ 中文全角标点扫描，接入 CI
- [ ] 空状态抽查 10 处含下一步动词
- [ ] zh/en 双语同步（不允许直译腔）
- [ ] 验收：VOICE-001~004

## 证据（每 Gate PR 附）

- [ ] Dashboard typecheck/lint/vitest/build；Rust 测试（F1）
- [ ] `check_architecture.py`；F3 起 `check_voice.py`
- [ ] F2 截图：320/680/1440 三档预览开启前后对比（证明零位移）
- [ ] VoiceOver 走查记录（F2）

## 完成后

- [ ] 重跑 `$impeccable critique` 对照 28/40 基线（与 design-coherence 完成后合并复评）
- [ ] 回答 OPEN QUESTIONS：每 N 小时、导出单页图片、英文禁用词扫描
