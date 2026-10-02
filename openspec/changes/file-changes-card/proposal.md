# Proposal: file-changes-card（#535，父 tasks 7.5a）

## Why
快照的步骤已带 `changes`（5.1），服务端归约器也声明了 `files.changed` 事件，但 web 不认这个事件（`web/src/features/chat/stream.ts:82-92` 的 `DATA_EVENTS` 没有它），步骤视图也不带 `changes`（`stream.ts:20-26`），用户看不到一次回复改了哪些文件。本刀把它接成助手消息里的 `文件变更（N 个）` 卡。

服务端目前还不发布 `files.changed`（`server/src/sessions/turn-control.ts:270-273`：#522 之前既不落库也不入 ring），父 design D11 允许两端任意先后。本刀合入后，卡片只会出现在快照已带 `changes` 的步骤上；流式路径由本刀的 jsdom 用例证明，跨进程证据归 #522 与 8.2a。

## What Changes
- 新建 `web/src/features/chat/stream-artifacts.ts`：`files.changed` 严格解码、消息级归约 `setStepChanges`、按消息汇总的纯函数 `summarizeChanges`。
- 新建 `web/src/features/chat/stream-steps.ts`：步骤视图类型与 `startStep`/`endStep`，从 `stream.ts` 原样挪出并改成消息级（`(message, data) => message`，同 `stream-approvals.ts` 的形状）；步骤视图加 `changes`。
- `stream.ts`：`ChatEvent`、`DATA_EVENTS`、`decodeEvent`、`applyChatEvent` 各加 `files.changed` 一支；快照映射带出步骤 `changes`；`step.start`/`step.end` 两支改为经 `replaceAssistant` 调用挪出的函数。
- `web/src/lib/session-contract.ts`：`parseFileChanges` 加 `export`（一个词），供事件解码复用同一条元素规则。
- 新建 `web/src/features/chat/file-changes-card.tsx`；`conversation-view.tsx` 在错误之后、`已停止` 徽章之前渲染它，并把当前会话的空间传下去；`page.tsx` 把当前会话的 `workspaceId` 在工作空间列表里解析出的空间作为 `workspace` 属性传入（+1 行）。
- `messages.css`：卡片样式（demo:519-526）。
- 新建 `web/test/chat-page-file-changes.test.tsx`。

## Fixture
- Level: `expanded`。
- Review priority: contract——汇总规则（只汇总已结束步骤、按路径去重取靠后的值、位置取首次）、逻辑路径不泄露绝对根、助手块全序。

## Spec deltas
- ADDED `turn-artifacts`「文件变更卡」。
- MODIFIED `chat-web`「纯会话视图归约」：步骤视图带 `changes`、九类 → 十类、files.changed 归约、`step.start`/`step.end` 对 `changes` 的处理；Scenario「思考归约」并入文件变更部分并改回父名「思考与文件变更归约」。
- MODIFIED `chat-web`「事件流消费与续流」：九类 → 十类、`files.changed` 严格键集；Scenario 改回父名「思考与文件变更事件严格解码」并并入文件变更部分。
- MODIFIED `chat-web`「会话页」：Assistant block order 加文件变更卡；Scenario「助手块次序」加卡片一项。
- MODIFIED `chat-web`「步骤 args 与输出分栏」：Scenario「步骤变更字段贯穿」的 THEN 补「变更只出现在文件变更卡」。

## Non-goals
- 服务端 `files.changed` 的推导、归属、落库与发布（3.2、3.4、#522）；快照步骤 `changes` 键的解析规则（5.1，本刀只加 `export`）。
- 产物卡及其卡位（7.5b）、产物面板（7.6）、`/files` 按路径深链、ui-walk 写入卡步骤（8.2a）。
- `approval-bar.tsx`、`thinking-block.tsx`、`stream-approvals.ts`、`stream-thinking.ts`、files feature 页面、`web/src/ui/**`、server 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **既有测试有改动**：issue 写「既有测试零 diff」「既有测试文件不增长」。步骤视图加了必有键 `changes` 之后，既有的整对象步骤视图断言都少一个键（`web/test/chat-stream.test.ts`、`chat-stream-stopped.test.ts`、`chat-stream-recovery.test.ts`、`session-contract-metadata.test.ts` 里不带 `ordinal` 的步骤字面量）。这些字面量各加 `changes: null`（或该用例应有的值），别的不动。同 #534 偏差 1。
2. **多一个新产品文件 `stream-steps.ts`，`stream.ts` 的改动不止 `DATA_EVENTS`**：issue 的 PR Boundary 写「新建两个产品文件 + `DATA_EVENTS` 条目与接线」。`stream.ts` 现为 787 行，按最小接线试排后是 804 行（步骤字面量加一个键被 Biome 展开），超过 800 的上限。不靠压缩既有代码过线：把 `startStep`/`endStep` 与步骤视图类型挪进 `stream-steps.ts`，函数体不变，只把外层的 `replaceAssistant` 留在 `stream.ts`。父 design D11「`stream.ts` 只增 `DATA_EVENTS` 条目与接线」写于 717 行时。
3. **`session-contract.ts` 加一个 `export`**：issue 写「不触碰 `session-contract.ts`」。规格要求事件里 `files` 的规则与快照步骤 `changes` 相同；`parseFileChanges`（`session-contract.ts:185-188`）就是那条规则。在 `stream-artifacts.ts` 里重写一份会多一处真相来源并触发 jscpd。事件因此同样受 1..50 项的上限约束（服务端上限也是 50，父 turn-artifacts Scenario「上限」）。
4. **`page.tsx` 的接线**：+1 行（`workspace` 属性：`workspaces?.find(...)`，当前会话取既有的 `selected`）。Principal 由卡片自己经 `useAuth()` 取（`composer-footer.tsx:51` 的先例）。
5. **只并入父 delta 的文件变更卡部分**：Assistant block order 与 Scenario「助手块次序」不含产物卡；turn-artifacts Scenario「空间不可解析」去掉「也不渲染产物卡」；「产物卡」「产物面板」两条 Requirement 归 7.5b、7.6。
6. 子 delta 另加父文未写的可观察行为：files.changed 指向不存在的消息时也返回同一引用（不补建消息）、不改会话状态；`step.start` 新建步骤的 `changes` 为 `null`，`step.end` 保留已有 `changes`；空间列表读取中与读取失败同样按「不可解析」处理；user 消息不渲染文件变更卡；解码拒绝面列全。
7. **卡头不带图标**：demo 的卡头有一个 `git` 图标（demo:2470），规格只点名了行尾按钮的 `chevron-right`，本刀卡头只有文本。
8. **跨 feature 深导入 `logicalPath`**（`../files/file-meta.js`）：同 #533 偏差 8。

## Impact
- web：三个新产品文件、`stream.ts`/`conversation-view.tsx`/`page.tsx`/`messages.css`/`session-contract.ts` 改动、一个新测试文件（可拆出一个 support 文件）、四个既有测试文件的步骤视图字面量加键。server 无改动。
- 运行时：无新增请求。#522 合入前卡片只在快照步骤已带 `changes` 时出现。
- 依赖：#517、#523（5.1）、#529、#530、#534、A #480 已合并。
