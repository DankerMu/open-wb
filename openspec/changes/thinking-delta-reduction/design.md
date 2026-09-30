# Design: thinking-delta-reduction（#514）

父设计：design D5「决定（归约，纯）」、D6「持久化与发布次序」（联合扩展那一刀先加显式 `undefined` 分支）、D11（新事件类型对旧 web 安全）。行号为 origin/master。

- **Change surface**：`server/src/sessions/events.ts` 的 `ChatEvent`（:6-~40）、`applyFrame` 的 `message_update` 分派（:96-97）与 `applyTextDelta`（:138-155）；`server/src/sessions/turn-control.ts` `persistEvent`（:218-270）；`server/test/session-events.test.ts:98-128` 期望值；两个新测试文件。
- **Must preserve**：
  - `applyFrame(state, frame)` 返回 `{state, events}` 形状与所有既有映射（turn.start、text.delta、step.start/end、turn.end、error、approval 事件、`applyStop`/`applyFailure`）逐字不变；终态后一切帧无事件。
  - `text_delta` 行为：同一 `started` 门、同一角色门（`message.role` 缺省或 `"assistant"` 才产出）、`delta` 须为字符串（空串 text_delta 仍按现状产出——本刀不改 text 语义）。
  - `persistEvent` 对既有类型的 store 调用与返回值不变；`supervisor.ts` 零改动（`#commit` 对返回 `undefined` 的事件不 `#publish`，现状）。
  - `session-events.test.ts` 只改期望值且行数不增长；其余测试零改动。
- **Must add/change**：
  - 类型：
    ```ts
    | { type: "thinking.delta"; data: { messageId: number; delta: string } }
    | { type: "files.changed"; data: { messageId: number; stepId: StepId; files: { path: string; added: number | null; removed: number | null; kind: "edit" | "write" }[] } }
    ```
    （如抽出 `FileChange`，不导出——仅 `events.ts` 内部使用，避免 knip 新增；`files.changed` 本刀无生产者。）
  - 归约：`message_update` 分派改为一个处理 assistant 更新的函数：先过 `started` 门与角色门，再按 `assistantMessageEvent.type`：`text_delta` 且 `delta` 为字符串 → 现状 `text.delta`；`thinking_delta` 且 `delta` 为**非空**字符串 → `thinking.delta{messageId: state.messageId, delta}`；其它（`thinking_start`、`thinking_end`、空串或非字符串 thinking delta、`toolcall_*` 等）→ 无事件、`state` 原样返回（同一引用）。不在 state 中记录任何 thinking 文本或计数。认知复杂度 ≤15。
  - `persistEvent`：`case "thinking.delta": case "files.changed": return undefined;`（注释说明 3.3/3.4 分别替换；本刀不落库、不发布，保证 3.2 起的原始路径不外泄）。注：该 switch 并非由 typecheck 强制穷举（已缺 `approval.*` 分支、无 `noImplicitReturns`），显式分支是文档与 3.3/3.4 的替换锚点；闸门实际由证据 7 守卫。本刀不加 `never` default（会连带要求处理 `approval.*`，超出范围）。
  - 删除 `session-events.test.ts:124-128` 的 `message_update{assistantMessageEvent:{type:"thinking_delta",delta:"hmm"}}` 帧（−5 行，期望序列不变）；`:101` 顶层 `{type:"thinking_delta"}` 帧保留为噪声，用例标题中「dropping thinking」随之仍成立，可不改。thinking 夹在 text/tool 之间的交错序列由 `session-events-thinking.test.ts` 证据 1 覆盖。
- **Sibling surfaces**：`stream/ring-buffer.ts` 的 `retain` 以展开复制事件，不按类型分支；`approvals.ts` 的 `Extract<…"approval.request">` 不受影响；`app.ts`/`sessions/index.ts` 的 `onEvent` 签名只引用联合类型。无需改动。
- **Required evidence**（RED-first：证据 1、证据 3 中「message 缺省/无 role → 产出」、证据 9；typecheck-red（运行时为守卫）：证据 7；characterization 守卫（实现前即绿，记录）：证据 2、3 中 user 角色半、4、5、6、8）：
  - `server/test/session-events-thinking.test.ts`（纯归约，冻结输入）：
    1. 绑定状态 `agent_start` 后依次：`thinking_start`、`thinking_delta "先"`、`thinking_delta "想"`、`thinking_delta ""`、`thinking_end`、`text_delta "答"` → 事件恰为 `[thinking.delta 先, thinking.delta 想, text.delta 答]`，messageId 均为绑定值；空 delta、start/end 帧各自单独施加时返回的 `state` 与输入 `===` 且无事件。
    2. 另一独立状态：`agent_start` 之前的 `thinking_delta` → 无事件、state `===`。
    3. 角色门：`message.role === "user"` 的 thinking_delta → 无事件；`message` 缺省或无 role → 产出（同 text_delta 现状）。
    4. 非字符串 delta（数字、null、缺省）→ 无事件。
    5. `message_end` 的 content 含 `{type:"thinking"}` 与 `{type:"redactedThinking"}` 块 → 事件与不含这些块时相同（不产出 thinking.delta）；终态（`agent_end` 终态之后）的 thinking_delta → 无事件。
    6. 不累积：处理大量 thinking_delta 后 `JSON.stringify(state)` 不含任何 delta 文本；输入帧冻结（`Object.freeze` 深冻结）不抛错，返回事件的 `data` 与输入不别名。
  - `server/test/session-persist-new-events.test.ts`：
    7. 直接调用 `persistEvent`（`turn-control.ts` 导出）：以 `persistEvent(store, 41, event, toolIds, nextOrdinal, settled)` 调用（`settled` 为空数组、store 为所有方法都记录调用的替身），对 `thinking.delta` 与 `files.changed` 各一次 → 返回 `undefined`、替身零调用、`toolIds.size` 不变、`nextOrdinal` 未被调用、`settled` 仍为空。
    8. 真实子进程：以 `createRealFakeRuntime("thinking")`（`session-supervisor-helpers.ts:88`，fake-omp `thinking` 场景帧形状对照 v18.0.10）+ `openRecordingSession` 跑一回合；断言 `onEvent` 序列无 `thinking.delta`、`text.delta`/`turn.end` 照常；该会话 stream cursor 的序号等于 `onEvent` 事件数（thinking 未消耗序号，按 supervisor 既有读 cursor/ring 的公开方法）；`SELECT content, thinking FROM chat_messages WHERE id=<assistant>` 为正文与 `NULL`。
    9. `session-events.test.ts` 改期望值后全绿（改动前该用例在实现后会红——记录）。
