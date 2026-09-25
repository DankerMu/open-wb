# Proposal: chat-welcome-state（#289）

## Why
S1e 组 4 的 4.4。依赖 #282（2.2 顶栏与 hero `<h1>` 归属）与 #288（4.3 composer 卡），两者都已合入。

审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把欢迎态列为实现偏差。现在的欢迎态（`web/src/features/chat/conversation-view.tsx:213-215`）只有 hero `<h1>` 和 composer。demo 欢迎页（demo:2537-2567）另有以下几块：
- 快捷 chip 行
- `不知道做什么，试试最佳实践案例` 五张卡与 `换一批`
- 免责声明

父 design 决策 8（D8）已拍板：
- 静态数据放 `features/chat/welcome-content.ts`，内容为 demo `QUICK_PROMPTS` 默认场景组（demo:1221-1239）、`PLAYBOOKS` 七项（demo:2553-2561）与卡片 prompt 映射（demo:2674）。
- 显示五张卡，`换一批` 在七项内轮换。

## What Changes
- 新 `web/src/features/chat/welcome-content.ts`，每项都标注 demo 行号来源：
  - `WELCOME_QUICK_PROMPTS`：日常办公场景的六个 chip，每项 `{ label, icon, prompt }`。
  - `PLAYBOOKS`：七项，每项 `{ title, desc, icon, prompt }`。
- 新 `web/src/features/chat/welcome.tsx`，有两个导出：
  - `WelcomeIntro({ onPick })`：hero `<h1>` 与 chip 行。
  - `WelcomePlaybooks({ onPick })`：最佳实践区与免责声明。它有本地轮换状态：起点 `index % 7`，取五项。
  - 点击 chip 或卡片只调用 `onPick(prompt)`，不发送。
- `conversation-view.tsx`：
  - 欢迎态时，transcript 槽位渲染 `WelcomeIntro`，composer 之后渲染 `WelcomePlaybooks`；有会话时两者都不渲染。
  - `onPick` 接既有的 `onChangeDraft`。
  - `Composer` 在两种状态下保持同一树位置，不因欢迎态与会话态切换而重挂载。
- `web/src/ui/icon.tsx`：图标映射补 `sparkles`、`zap`、`code`、`file-spreadsheet`、`file-chart-line` 五个 lucide 图标。父 D3 与 ui-primitives 契约规定映射为"本仓用到的图标"，本刀用到这五个。
- `chat.css`：chip 行、卡片行、最佳实践头、免责声明、欢迎态纵向排布，只用语义 token，注明来源 demo:341-359,402-414。
- 测试：
  - `web/test/chat-page.test.tsx` 增欢迎态结构、只填不发、轮换三组用例。
  - `web/test/ui-icon-brand.test.tsx` 的 `ICON_NAMES` 补五项。

## Non-goals
- 场景胶囊与按场景切换（S1c）。
- chip 行 `›` 展开按钮与选中态高亮：只在多场景下有意义，S1c 一并处理。
- `查看更多`：目标 `/center` 未交付。
- `换一批` 的 toast。
- 选中卡片后把焦点移到输入框。
- 附件、模型、麦克风、工作空间足栏。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底：
  - 在首段后插入父 delta 的 **Welcome state** 段（原句照搬）；
  - 新增父 delta Scenario「欢迎态与静态引导」（原句照搬）。

## Impact
- 新文件：`web/src/features/chat/{welcome.tsx,welcome-content.ts}`。
- 修改：
  - `web/src/features/chat/{conversation-view.tsx,chat.css}`；
  - `web/src/ui/icon.tsx`（只加映射）；
  - `web/test/{chat-page.test.tsx,ui-icon-brand.test.tsx}`。
- 不加依赖（lucide-react 已在），不动服务端、`web/e2e/**`、`chat/page.tsx`。

## 与 oracle 偏差留痕
- issue 的 Key interfaces 写 `WELCOME_QUICK_PROMPTS: string[]` 与 `Welcome({onPick})`。
  - 本刀改为 `{ label, icon, prompt }[]`：chip 显示名与填入的 prompt 不同（demo `QUICK_PROMPTS` 是 label→prompt 映射），`string[]` 装不下。
  - 组件拆为 `WelcomeIntro` 与 `WelcomePlaybooks`：demo 的顺序是 hero、chip、composer、最佳实践。若用单个 `Welcome` 包住 composer 槽位，composer 在欢迎态与会话态之间会换父节点而重挂载，发送建会话时 textarea 焦点与 DOM 身份丢失；拆成两段后 composer 保持在 `chat-main` 下的固定位置。
- demo 卡片是 `div` 加 click。本刀用 `<button>`，键盘可达，composer 锁定期间与 chip 一同禁用。
- demo 的 `filePresentation` 图标（demo:979）在 lucide 无同名，用形状最近的 `file-chart-line` 替身。
- demo 的最佳实践区与免责声明以 `position:absolute` 贴底（demo:403,414）。本刀用普通文档流放在 composer 之下，避免与窄屏布局和 composer 重叠。视觉对比由 6.3a 截图签收。

## Risk triage
- 欢迎态新增的按钮文本可能与既有 jsdom、ui-walk 定位冲突。已 grep：
  - ui-walk 在 `/` 上定位的是 `新建会话`、`给助手发消息`、`发送`/`生成中`、会话项，都不是任何 chip 或卡片文本的子串。
  - RTL 的 `getByRole` 默认 exact。
- `chat-page-lifecycle.test.tsx:166` 断言全页 heading 列表恰为 hero。最佳实践头不得用 `h1`，design 规定为 `p`。
- composer 重挂载会破坏既有焦点与键盘用例（`chat-page.test.tsx` 键盘组）。由固定树位置保证，design 要求一条身份断言钉住。
