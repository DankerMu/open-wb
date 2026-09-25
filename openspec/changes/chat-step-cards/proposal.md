# Proposal: chat-step-cards（#287）

## Why
S1e 组 4 的 4.2，依赖 #275（`Icon`），已合入。审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把步骤卡列为实现偏差。现状（`web/src/features/chat/conversation-view.tsx:80-104`）有三处不符：
- 步骤卡头只有名称和英文状态 `running|done|failed`（`aria-label` `<step> <status>`）。
- 没有图标，也没有摘要。
- JSON 形态的 detail 放进默认**展开**的 `<details>`，非 JSON 直接铺开。

父 design 决策 8（D8）已拍板：
- 纯函数 `summarizeStepDetail(detail)`；
- 步骤徽章 `role=status`，可见中文加 accessible name `<step> <状态>`；
- ui-walk 的 `bash running|bash done` 定位同 PR 改为中文。

两处行数上限让本刀必须先拆文件（CSS 受 AGENTS 约定与 4.1 移交约束，ts 受 size-guard 与 pre-commit 约束）：
- `features/chat/chat.css` 已 784 行（4.1 移交，见父 tasks 4.2 行），加步骤卡样式会超过 800 行上限。
- `web/e2e/ui-walk.spec.ts` 已 802 行，pre-commit 的 size-guard 会拒绝任何暂存它的提交；本刀必须改它。

## What Changes
- **拆文件（行为不变）**：
  - 新 `web/src/features/chat/messages.css`：从 `chat.css` 原样移入消息区规则，即 `.chat-thread`、`.chat-msg*`、`.chat-md*`、`.chat-caret`、`.chat-step*`，以及它们在 `≤760px` 下的规则。
  - `styles.css` 在 `chat.css` 之后 `@import` 它。
  - 新 `web/e2e/ui-walk-gate.ts`：从 `ui-walk.spec.ts` 原样移出假上游 gate 控制函数（`controlOrigin`、`controlHeaders`、`gateUrl`、`armGate`、`releaseGate`、`deleteGate`、`gatePhase`），spec 改为 import。
- **新 `web/src/features/chat/step-summary.ts`**：`summarizeStepDetail(detail: string): string`，规则见 design，已写入子 delta。
- **`conversation-view.tsx` 的 `StepCard`**：
  - 卡头：bash 用 `Icon terminal`，其余用 `Icon wrench`；名称；徽章 `p[role=status]`，可见文本为 `SESSION_STATUS_LABEL[step.status]`（`运行中|已完成|失败`），`aria-label` 为 `<name> <中文状态>`，running 时加 `ui-pulse`。
  - 摘要行：摘要非空时渲染。
  - 原始 detail：非空时放进默认**折叠**的 `<details>`，summary 为 `原始输出`，正文 `pre`。
  - 保持 `section[aria-label=<name>]`。
- **`messages.css`**：步骤卡头、徽章色、摘要行与折叠区样式，只用语义 token，来源 demo:448-460。
- **测试**：
  - 新 `web/test/step-summary.test.ts`（表驱动）。
  - 新 `web/test/chat-steps.test.tsx`（卡片结构）。
  - `web/test/chat-page.test.tsx:132,166,167` 把 `bash running`/`bash done` 改为中文。
  - `web/test/chat-messages.test.tsx` 中读取 CSS 的路径从 `chat.css` 改为 `messages.css`。
- **ui-walk**：
  - `web/e2e/ui-walk.spec.ts` 中 `bash running`/`bash done`（`:756-757,797`）改为 `bash 运行中`/`bash 已完成`。
  - 顺带关闭 #366：助手正文定位从 `pair.assistant.locator("p").first()` 收窄到 `pair.assistant.locator(".chat-md")`（`:750,:796`），测试不再依赖助手块内正文与步骤卡的先后顺序。

## Non-goals
- 非 bash 工具的专用摘要形态（父 design Not yet specified）。
- 步骤耗时与 todo（spec 明确不伪造）。
- demo 执行卡的整卡折叠开关与计数 `(n/m)`（demo 的 exec 是多步清单，本仓每步一卡）。
- 调整助手块内正文与步骤卡的顺序。
- 会话列表状态（4.3 已合入）。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底：
  - 删去旧句 "Steps SHALL display name/detail and running/done/failed; no fabricated time or todo state."；
  - 在 Messages 段后插入 **Step cards** 段；
  - 新增 Scenario「步骤卡呈现」。
  - Step cards 段以父 delta 原句为底，补三处摘要规则细化（本刀"一次定调"）：
    - `text` 优先于 `content`，与 JSON 键序无关；
    - 首键值写作 `<key>: <value>`，非字符串值 JSON 编码；
    - 非对象 JSON 按非 JSON 规则处理，结果取首个非空行并 trim。
- MODIFIED `verification-harness`：Requirement「UI 走查（Playwright）」以已晋升文本为底，只把 Scenario「真正回合中刷新并持久完成」THEN 中的 "bash和session均done" 改为父 delta 原句：bash 步骤徽章 `role=status` 名 `bash 已完成`，会话列表当前项 status 文本 `已完成`。后者已由 #288 在 ui-walk 落地，本刀补齐前者。该 Requirement 的其余部分（双 project 等）属 6.1，不在此动。

## Impact
- 新增：
  - `web/src/features/chat/{step-summary.ts,messages.css}`
  - `web/e2e/ui-walk-gate.ts`
  - `web/test/{step-summary.test.ts,chat-steps.test.tsx}`
- 修改：
  - `web/src/features/chat/{conversation-view.tsx,chat.css}`
  - `web/src/styles.css`（加一行 import）
  - `web/e2e/ui-walk.spec.ts`
  - `web/test/{chat-page.test.tsx,chat-messages.test.tsx}`
- 不加依赖，不动服务端、`web/src/ui/**`、`page.tsx`、`stream.ts`。

## 与 oracle 偏差留痕
- demo 执行卡（demo:2218-2242）是可折叠的多步清单，带计数与整卡开关。本仓一步一卡，卡头不做开关，原始输出以 `<details>` 折叠承载，符合父 delta。
- demo 运行态颜色用 `--wb-palette-blue-8`；feature 层禁用 palette，改用语义 token `--wb-brand-primary-deep`（现有 running 色）。

## Risk triage
- ui-walk 完成 oracle 依赖徽章可访问名：jsdom 与 e2e 必须同 PR 改名。CI ui-walk 与 3.3 证明。
- 拆 CSS 改变层叠顺序：`messages.css` 在 `chat.css` 之后引入，两者选择器不重叠；`≤760px` 规则随所属选择器一起迁移，避免后引入的基础规则覆盖先引入文件里的媒体规则（如 `.chat-msg-user { max-width }`）。
- 拆 e2e：纯函数原样移动，gate 生命周期（arm → release → finally delete）不变，3.3 证明。
- 摘要解析不可信文本：`JSON.parse` 失败即走非 JSON 分支，不抛出；按码点截断，不切断代理对。
