# Restork Dashboard × v4 原稿 · 逐页还原度审计

- 日期：2026-08-16
- 方法：v4 原型（`design/restork-shell-redesign-v4.html` + tokens/css）逐 section 阅读，对照 dashboard demo 页九视图 headless 截图（1440px，zh-CN）；分级沿用 impeccable critique（critical / major / minor）；边界遵循 `docs/specs/hallmark-product-expression.zh-CN.md`（强调色单屏 ≤5%、纸面平铺、打字机字体只留字标与短印记）。

## 本轮已修复（随本文件同 PR 合入）

| 项 | 原状 | 修复后 |
| --- | --- | --- |
| 左下身份区（critical，用户点名） | 纯文字按钮，无头像无箭头 | 墨色圆角方块头像（打字机风首字母）+ 称呼/「本机工作台」+ 上箭头，顶部细线分隔，结构对齐 v4 `.identity` |
| 页面级大卡片（critical，结构性） | 每页内容包在圆角阴影大卡片 + 红色装订线（paper-card）里 | `.paper-card.full-card` 平铺到纸面：去边框/背景/阴影/装订线；组件级小卡片保留 |
| 页面角标 ribbon（major，强调色） | CORE STATE / LOCAL·EDITABLE / ON DEVICE 等彩色白字色块 | full-card 头部 ribbon 收敛为 muted 小字，无色块 |
| 响应式 | 紧凑断点 full-card 仍有 36px 左内边距 | 补 `.paper-card.full-card { padding-left: 0 }` |

此前两轮已修：字标（打字机风 Restork）、导航分组标签可见、开始页衬线大标题/复盘提示/模式提示行/示例平铺/状态条彩点（#106、#107）。

## 遗留差异（按优先级）

### major

1. **无页面 topbar**。v4 每页顶部有「页面名 + 一句话副标题」（如 任务 / 本机待办）。app 页面标题藏在各页内部，语境不一致。需在 shell 层加 topbar，触及所有页面渲染入口，单独一轮做。
2. **仪表盘结构**。v4 是「时钟横带 + 双栏平铺」，app 是 4 指标卡 + 模型卡 + 三列卡的卡片阵列——正是 Hallmark spec 点名的模板骨架。重做涉及数据布局，单独一轮。
3. **运行页缺状态筛选行**。v4 有「全部 3 / 进行中 2 / 待确认 1」筛选，app 只有运行/审批 tab。
4. **强调色总量仍偏高**。对话页紫色按钮群（+、搜索、发送、先看看）、导航计数紫徽章并存，超 5% 上限；建议计数徽章改墨色、次要按钮改 secondary。

### minor

5. 任务页缺 v4 的 kicker 说明行（「本机可编辑。知识库里的 Markdown 任务要先预览差异…」），现有 muted 角标只表意一半。
6. v4 对话页左栏顶部为新建对话表单，app 一致 ✓；但 v4 线程消息为平铺时间戳式，app 为气泡卡——气泡可读性尚可，暂缓。
7. 设置页仍有一层子卡片（称呼与外观）。组件卡保留符合约定，观感可接受。

## 验证记录

- vitest 301/301；spacing-grid、eslint 通过
- headless 截图：开始/仪表盘/运行/任务/对话/知识库/交付物/自动化/设置 九页 1440px zh-CN
- demo 页支持 `?startup=start&view=<view>&locale=zh-CN` 直达任意页面
