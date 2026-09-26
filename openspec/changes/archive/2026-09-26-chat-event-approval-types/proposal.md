# Proposal: chat-event-approval-types（#453）

## Why
父 change `s1c-turn-control-governance` tasks 3.2（epic #448）。审批条需要两类 SSE 事件 `approval.request`/`approval.resolved`；它们是 server/web 共享的公共事件契约，须先进入 `ChatEvent` 联合并证明 ring/SSE 无改动即透传、回放，供 4.3（生产）与 5.3（web 归约）消费。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 公共 SSE 事件联合是 server/web 共享契约)
Blast radius: 全部 SSE 订阅方——若新事件未按普通 ring 事件编号/回放，刷新后审批条丢失或重复；若联合形状与 web 解析不一致，5.3 起跨端漂移。
Selected risk packs: Public API / CLI / script entry（SSE 事件契约）；Schema / columns / units / field names（payload 字段与类型）；Legacy compatibility / examples（既有六类事件与 ring/SSE 行为不变）；Concurrency / shared state / ordering（ring seq 次序与回放）
Evidence floor: 新建 server vitest 测试文件：向测试自持的真实 RingBuffer 发布四事件并经 subscribe spy 接入的真实 SSE 端点读回（seq 连续、payload 原样、`event:` 名、`Last-Event-ID` 回放恰一次、无 cursor 从 turn.start 起含 request、resolved 实时到达）；正向断言先红（typecheck 或运行时）后绿；`make typecheck`、`npm test --workspace server`、`make lint`、`make anti-drift` 退出 0；ring/SSE 既有测试零改动。

## What Changes
- `server/src/sessions/events.ts`：`ChatEvent` 联合新增 `approval.request{messageId:number, approvalId:number, tool:string, title:string, expiresAt:number}` 与 `approval.resolved{messageId:number, approvalId:number, decision:"allow"|"deny"|"timeout"}`。
- 新建测试文件。ring（`stream/ring-buffer.ts`）与 SSE（`stream/sse.ts`）零改动。

## Capabilities
- ADDED `chat-stream`「审批事件发布」（部分交付）：事件形状、普通 ring 事件与 SSE 帧名；发布纪律（落库后发布、失败不发布、并行、无应答结算）归 4.3 #464 / 4.6 #474。

## Impact
- 仅类型联合 + 新测试；纯归约器 `applyFrame` 不产生新事件（审批帧不进归约，3.1）；web 联合归 5.3。

## Non-goals
- 事件生产者、发布纪律、归约器改动、web 解析与归约。
