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

## 本轮已修复（五项遗留清零，PR #109）

| 项 | 原状 | 修复后 |
| --- | --- | --- |
| 页面 topbar（major） | 页面标题藏在各页内部，语境不一致 | shell 层加 topbar：页面名 + 一句话副标题，随视图切换（zh/en）；品牌字标降级为 strong，topbar 页面名成为全屏唯一 h1（对齐 v4 结构，a11y 同步） |
| 仪表盘结构（major） | 4 指标卡 + 模型卡 + 三列卡的卡片阵列 | 时钟 + 天气组成横带（实线分隔）；日历 + 每日一曲双栏平铺；指标去卡片改墨色大数字；模型台去卡片平铺 |
| 运行页状态筛选（major） | 只有运行/审批 tab | 加「全部 / 进行中 / 待确认」筛选行（带计数），待确认直达审批子视图 |
| 强调色总量（major） | 对话页紫色按钮群 + 导航紫徽章并存，超 5% 上限 | 导航计数徽章改纸灰底墨色字；对话页 +/⌕/先看看 改线框 secondary；发送保留主色平涂；ribbon 仅审批留淡红（警示语义）；天气温度改纯墨色 |
| 任务页 kicker（minor） | 缺 v4 的 kicker 说明行 | 补「本机可编辑。知识库里的 Markdown 任务要先预览差异，确认后才写入。」 |

### 暂缓（接受现状）

- 对话页线程消息为气泡卡（v4 为平铺时间戳式）——气泡可读性尚可。
- 设置页保留一层子卡片（称呼与外观）——组件卡保留符合约定。

## 验证记录

- vitest 301/301；spacing-grid、eslint 通过（PR #109 CI 全绿：13 pass + 5 release 门禁跳过）
- headless 截图复核：仪表盘/运行/任务/对话 1440px zh-CN 对照 v4 原稿
- demo 页支持 `?startup=start&view=<view>&locale=zh-CN` 直达任意页面
- 已随本机构建替换 /Applications/Restork.app，冒烟确认加载新资源哈希
