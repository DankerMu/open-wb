# Proposal: thinking-delta-reduction（#514）

## Why
父 change `s1c-session-metadata-presentation` tasks 3.1（epic #509，design D5「决定（归约，纯）」、D6「联合扩展那一刀先加显式 `undefined` 分支」、D11）。深度思考折叠（3.3）与文件变更卡（3.2/3.4）都需要 `ChatEvent` 先有 `thinking.delta` 与 `files.changed` 两型；现行 `applyTextDelta`（`server/src/sessions/events.ts:138-155`）只认 `text_delta`，`thinking_delta` 被当噪声丢弃。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: `ChatEvent` 是 SSE 公共契约的类型源（ring buffer、`onEvent`、app 装配）；归约改错会改变既有 `text.delta`/step 事件序列或让 thinking 漏入正文；`persistEvent` 若对新两型不显式返回 `undefined`，3.2 起归约器产出的原始绝对路径可能被发布到 SSE。
Selected risk packs: Public API / CLI / script entry（`ChatEvent` 联合与 SSE 事件类型）；Legacy compatibility / examples（既有归约序列、`session-events.test.ts` 仅改期望值）；Schema / columns / units / field names（两型 payload 字段与类型）；Error handling / rollback / partial outputs（本刀不落库、不发布的闸门）
Evidence floor: 新建 `server/test/session-events-thinking.test.ts` 与 `server/test/session-persist-new-events.test.ts` 覆盖 design「Required evidence」；`session-events.test.ts` 仅改期望值、不增长；其它 chat-stream/supervisor 测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `server/src/sessions/events.ts`：`ChatEvent<StepId>` 增 `thinking.delta{messageId, delta}` 与 `files.changed{messageId, stepId: StepId, files: {path, added: number|null, removed: number|null, kind: "edit"|"write"}[]}`；`message_update` 分派在 `text_delta` 之外识别 assistant `thinking_delta`（非空字符串 delta）→ 恰一条 `thinking.delta`，与 `text_delta` 同一 `started` 门与 assistant 角色门；不累积、不合并。
- `server/src/sessions/turn-control.ts` `persistEvent`（A #487 后的位置，非 `supervisor.ts`）：为两型加显式分支，均返回 `undefined`、不调用 store。`supervisor.ts` 不改。
- `server/test/session-events.test.ts`：删除 `session-events.test.ts:124-128` 的 `message_update{assistantMessageEvent:{type:"thinking_delta",delta:"hmm"}}` 帧（−5 行，期望序列不变）；`:101` 顶层 `{type:"thinking_delta"}` 帧保留为噪声，用例标题中「dropping thinking」随之仍成立，可不改。thinking 夹在 text/tool 之间的交错序列由 `session-events-thinking.test.ts` 证据 1 覆盖。
- 两个新测试文件。

## Capabilities
- MODIFIED `chat-stream`「纯协议事件归约」：以主 spec 为底，只并入父 delta 中 3.1 的部分——两型 payload 定义、字符串字段扩展、thinking 映射句与过滤句改写、「Text and thinking content SHALL NOT be accumulated」、Scenario「Thinking deltas map one-to-one」。父 delta 的 `command_output` 段与 Scenario「Command output becomes assistant text」（10.3）、`edit`/`write` 候选推导段与 Scenario「Edit and write details yield raw candidates」（3.2）、step output 措辞「dropped from output」（3.2）留给各自切片。thinking-fold「thinking.delta 合并发布与持久化」是新能力的 ADDED Requirement，整体归 3.3，本刀不建该 spec；delta 中对它的括注是对 3.3 将新增 Requirement 的前向引用，3.3 归档前悬空。另加一句过渡条款：在 thinking 与文件变更的 supervisor 切片落地前，supervisor 既不持久化也不发布这两型、不占用 ring 序号（3.3/3.4 以父 delta 替换）。

## Impact
- `events.ts`、`turn-control.ts` 与测试；不触碰 `store*.ts`、`stream/`、`supervisor.ts`、web。本刀后 `thinking.delta` 由归约器产出但不落库、不发布（SSE 与快照不变）。

## Non-goals
- thinking 合并/落库/上限/发布（3.3）；`files.changed` 产出（3.2）与归属/落库/发布（3.4）；快照投影（5.1）；web 解码（7.4/7.5a）；`command_output` 映射（10.3）。
