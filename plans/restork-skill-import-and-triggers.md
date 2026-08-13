# Restork 第三方技能导入与触发 — 实施计划

> Spec：[docs/specs/skill-import-and-triggers.zh-CN.md](../docs/specs/skill-import-and-triggers.zh-CN.md)
> 纪律：每 Gate 独立 PR；先写失败测试；绝对路径与文件内容不进 Dashboard JS；`main.ts` 不破架构预算

## Gate S1 — 导入与兼容性报告（Core 先行）

- [x] 失败测试：SKILL.md 解析边界（缺 name/空正文/超 64KB/文件数 >40/二进制拒绝）
- [x] Core：`package_kind:"skill"` 的解析器（front-matter + 正文 + references + stripped 清单）
- [x] Core：`extension_install_preview` 返回 imported/stripped/notice 三段结构；劝阻阈值（指令 <200 字符且有剥离）
- [x] Core：包内容哈希与来源记录进修订
- [x] Desktop：原生文件夹导入命令（grant 式句柄，路径不出原生层）；build.rs/capabilities 同步
- [x] Web 回退：多文件上传路径（MIME/扩展名白名单）
- [x] Dashboard：扩展中心「从文件夹导入」入口 + 兼容性报告渲染（✓/✗/说明行 + 劝阻二次确认）
- [x] 哨兵扫描：路径/内容不进 JS 载荷、日志、诊断
- [x] 验收：SKILL-001/002/003/004/005（自动化契约与边界已通过；真实包演示仍列在人工证据项）

## Gate S2 — 开始页 chip 与 ⌘K（依赖 S1）

- [x] 失败测试：分词匹配（命中 ≤2 展示、>2 静默、布局零位移）
- [x] `POST /v1/runs` 增加可选 `skill_ids[]`：存在性/enabled/≤8 校验，冻结进 manifest；契约测试（未知字段仍拒绝）
- [x] `features/skillSuggest.ts`：本地匹配 + chip 渲染（toggle、aria-pressed、固定占位行）
- [x] ⌘K：已启用技能自动注册条目；选中→开始页预挂技能+default_mode+聚焦；停用即移除
- [x] Run 详情/trace 显示「使用的技能」（名称+修订哈希）
- [x] 验收：SKILL-006/007/009/010

## Gate S3 — 对话内建议（依赖 S2）

- [x] 失败测试：无确认 → manifest 无技能；确认 → 下一次 Run 携带
- [x] 对话回合下方建议行（复用 chip 组件）；模型输出不能直接激活
- [x] 验收：SKILL-008

## 证据（每 Gate PR 附）

- [x] Rust fmt/clippy/-D warnings/测试；Dashboard typecheck/lint/vitest/build
- [x] route-coverage 不变；`check_architecture.py` 通过
- [x] 哨兵扫描输出（S1、S2）
- [ ] 用 ppt-master、cobsidian 两个真实包做端到端演示记录（含一次劝阻案例）

## 完成后

- [x] 回答 OPEN QUESTIONS：keywords 兜底、重复导入策略、多动作条目（见 Spec「已决问题」）
- [ ] 观察真实使用中的 chip 命中质量，再决定是否提供 keywords 编辑入口
