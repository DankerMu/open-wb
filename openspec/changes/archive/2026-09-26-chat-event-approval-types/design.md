# Design: chat-event-approval-types（#453）

父设计：D5「事件次序」、D6「事件与快照契约同刀」。

- **Change surface**：`server/src/sessions/events.ts` 的 `ChatEvent<StepId>` 联合（新增两成员）。ring（`stream/ring-buffer.ts`）与 SSE（`stream/sse.ts`）不改。
- **Must preserve**：既有六类事件形状与 SSE 帧；ring 的 `turn.start`/`turn.end` 特判（`ring-buffer.ts:56-58`）只针对这两类，新事件按普通事件保留/编号；`Last-Event-ID` `min−1` 回放、`replay.gap`、「无 cursor 从活跃 turn.start 起」规则；纯归约器 `applyFrame` 的输出集合不变（它不产生审批事件）。
- **Must add/change**：`{type:"approval.request"; data:{messageId:number; approvalId:number; tool:string; title:string; expiresAt:number}}` 与 `{type:"approval.resolved"; data:{messageId:number; approvalId:number; decision:"allow"|"deny"|"timeout"}}`；SSE `event:` 名等于 `type`（由既有 SSE 写帧逻辑自然得出，不加特判）。
- **Governing invariant**：审批事件是普通 ring 事件——与其它事件同序号空间、同回放与保留规则，ring/SSE 对其类型透明。
- **Sibling surfaces**：
  - 生产者：supervisor（4.3/4.6，本刀无）。
  - 类型消费者：`server/src/sessions/supervisor.ts:643-690` `persistEvent` 的 `switch`——未开 `noImplicitReturns`、返回类型含 `undefined`，联合扩张后两新成员落空返回 `undefined`，且该路径不可达（归约器不产生审批事件）；本刀 `supervisor.ts` **零改动**（issue PR Boundary），穷尽处理归 4.3 #464。`app.ts:66`、`sessions/index.ts:28` 的 `onEvent` 回调签名随联合自然扩展，无需改动。
  - ring：`ring-buffer.ts` `RetainedEvent = {id} & ChatEvent<number>`，自动涵盖。
  - web：`web/src/features/chat/stream.ts` 联合（5.3 负责，本刀不改）。
- **Seams under test**（写死）：既有入 ring 的唯一路径是 fake-omp 帧 → supervisor → `persistEvent(applyFrame(...))`，发不出审批事件，且 generation ring 是 supervisor 私有字段。故采用：`openBareSession`（既有 SSE 测试 helper，真实 app/鉴权/`sse.ts`）+ `vi.spyOn(fixture.app.sessions.supervisor, "subscribe")`，由测试自持的真实 `new RingBuffer(epoch)` 支撑——stub 返回 `{mode, replay: ring.since(cursor, {turnRunning}).events, unsubscribe}` 并捕获 `deliver` 回调，用于实时推送 `ring.latest()`（或新发布事件）。鉴权、`sse.ts` 写帧与 `RingBuffer` 均为真实实现；无 cursor 场景的 `turnRunning` 由 stub 给 `true`（真实值来自 store `activeTurn`，`supervisor.ts:477`）。supervisor 的 `#fanout`/`#readReplay` 不在本测试覆盖范围内（由既有 SSE 测试覆盖，事件类型透明）。
- **Required evidence**：
  - 发布 `turn.start` → `approval.request{messageId:1,approvalId:7,tool:"bash",title:"t",expiresAt:1700000060000}` → `approval.resolved{messageId:1,approvalId:7,decision:"allow"}` → `turn.end{messageId:1,status:"done"}` → ring 读出四者 seq 连续、payload `toEqual` 原样、两审批事件位于 `turn.end` 前。
  - 以 request 前一 id 作 `Last-Event-ID` 订阅 → 恰按序收到 `event: approval.request`、`event: approval.resolved`、`event: turn.end` 各一次，`data` 为原 payload JSON。
  - 无 cursor 订阅（仅发布了 turn.start 与 request，回合未结束）→ 回放首帧为 turn.start 且含 approval.request；随后发布 resolved → 以下一 seq 实时到达。
  - 三种 `decision` 值各发布一次 resolved 经 SSE 读回值不变（类型层 `decision` 只接受三值由 typecheck 证明：一处 `// @ts-expect-error` 断言非法值被拒）。
- **Non-goals**：生产者与发布纪律、归约器、web。
- **Review focus**：ring/SSE/supervisor 零改动；payload 字段名/类型与父 spec 逐字一致。
