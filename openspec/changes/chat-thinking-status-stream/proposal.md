# Proposal: chat-thinking-status-stream

## Why

#910：owner 在 2026-10-06 验收会话页时提出两件事。

1. 发出消息后、回答到达之前，助手消息里只有一个闪烁的方块光标，看不出在做什么。
2. 思考内容要攒满 2048 字节或 2 秒才发一批，所以折叠块最多晚 2 秒才出现，之后一段一段地跳出来。

另外，正文是上游每来一个片段就发一条事件，长回答自己就可能把每会话 1000 条的事件环冲满。

现状是按规格实现的（chat-web「消息线程」的光标条文、thinking-fold 的 2048 字节 / 2000ms 合并规则），所以要改的是规格本身。

## What Changes

- **等待指示**：回合已开始、这条助手消息还没有任何可见内容（思考块、正文、工具调用组、审批记录、错误或重试提示）时，显示一行带流光的 `正在思考…`（`role="status"`）。第一块可见内容出现后消失，同一回合不再出现。不区分模型是否支持推理（owner 2026-10-06 / 2026-10-14）。
- **正文光标换成小圆点**：运行中、等待指示不显示时，正文末尾显示一个小圆点，替换方块光标。在 `prefers-reduced-motion: reduce` 下不做动画。
- **思考标题与时长**：
  - 折叠块标题在思考进行中为带流光的 `正在思考…`，一段思考结束后为 `已思考 N 秒`；没有时长数据的消息（历史消息、异常中断）为 `深度思考过程`。
  - 时长由**服务端**记录。一段思考从服务端收到该段第一条思考增量开始，到收到 omp 的 `thinking_end` 帧或同一回合下一个非思考事件（含回合结束）为止，取先到者（模型流式生成工具参数的时间不计入）；多段累计成毫秒数。
  - 时长落库到新的可空列 `chat_messages.thinking_ms`（迁移 044），随快照返回。每段结束时发布新事件 `thinking.end{messageId, thinkingMs}`（owner 2026-10-14）。
  - 异常回合按回合结束时刻计；无法恢复结束时刻的（宿主进程在段开着时退出、infra fault）为 `null`，标题 `深度思考过程`：每段开始时服务端先把该列清空，闭段才写入累计值（owner 2026-10-13 Q9；design D3）。
- **事件按 250ms 时间窗合并**（**行为变化，非破坏**：事件拼接后的全文不变，变的只是切分）：
  - 正文与思考用**同一个合并器**（owner 2026-10-14）。某一类增量空闲后的第一段立即发布；之后同一类每 250ms 至多发一条，期间到达的片段合成一条。即将发布任何其它事件之前、回合结束之前立即冲刷，保持先后次序。
  - 合并器在落库之前，所以快照仍等于已发布的前缀。正文落库照旧 2048 字节 / 2000ms 攒批；思考照旧先落库后发布，只是节奏从 2 秒变为至多每 250ms 一次（owner 2026-10-14）。32768 码点上限与截断标记不变。
  - 思考的 2048 字节阈值取消。
- **前端平滑**：运行中的正文与思考按 assistant-ui `useSmooth` 的规则逐字展开（owner 2026-10-14）：每字间隔 = min(5ms, 250ms ÷ 积压字数)，积压越多越快。
  - 回合进入终态时立刻补齐，不拖尾。
  - 打开或重连一条运行中的消息时，已有文本立即显示，只有之后到达的部分逐字展开。
  - `prefers-reduced-motion: reduce` 下不做逐字展开。
  - `复制` 与对话内搜索以已收到的全文为准。
- **思考的流式预览**（owner 2026-10-13 Q15 启用）：运行中且展开时，折叠块主体限高 `12rem`，盒内自动贴到最新一行；用户在盒内向上滚动则暂停贴底。终态仍是限高 `12rem`、盒内滚动、不自动贴底。转录区的贴底跟随与 `回到最新` 不受影响（design D7 说明冲突如何消除）。
- **证据**：
  - 合并规则用注入时钟测。
  - 受控假上游新增一个按节奏逐段吐片段的标记；用官方 omp 的服务端测试断言「事件数远少于片段数、首段立即发布、拼接逐字相同」。
  - ui-walk 断言等待指示、小圆点、标题变化与预览贴底。
  - 冒烟断言快照里有 `thinkingMs`。
- **验收清单**：改写描述光标与 `深度思考过程` 的行，新增等待指示、思考标题、平滑与预览的行，全部 `待签`。
- **不做**：思考内容的 Markdown 渲染与复制（#910 范围外）；在等待模型的其它时段（工具执行完、等下一轮响应时）显示指示（owner 2026-10-14）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `thinking-fold`：
  - 改写「thinking.delta 合并发布与持久化」：250ms 时间窗、共用合并器、取消字节阈值。
  - 改写「深度思考折叠块呈现」：标题三态、流式预览、逐字展开。
  - 改写「reasoning 前提与真运行时取证」：只改一处过时的合并说明。
  - 新增「思考时长记录与下发」「迁移 044 思考时长列」。
- `chat-stream`：
  - 改写「思考与文件变更事件发布」：事件联合加 `thinking.end`，合并节奏改为指向新要求。
  - 新增「正文与思考增量的时间窗合并」。
- `chat-web`：
  - 改写「API 客户端扩展」：消息 DTO 严格键集加 `thinkingMs`，与服务端同刀。
  - 改写「纯会话视图归约」：十三类事件，视图字段 `thinkingMs` / `thinkingActive`。
  - 改写「事件流消费与续流」：解码 `thinking.end`。
  - 改写「会话页源码模块划分」：`runtime-convert` 透传两字段。
  - 改写「消息线程」：等待指示、小圆点、正文逐字展开。
- `chat-harness`：
  - 改写「UI 走查会话元数据」：终态折叠块标题为 `已思考 N 秒`。
  - 新增「等待与思考呈现的冒烟与走查」：冒烟 `thinkingMs`，走查小圆点、等待指示、预览与标题变化。
- `omp-test-harness`：
  - 新增「受控上游节奏与闸门停点标记」：`WORKBUDDY_PACE`、`WORKBUDDY_THINK_LONG`、`WORKBUDDY_HOLD_AT`。
  - 改写「Isolated bounded upstream dialogue gate」「受控上游思考与写入标记」：各加一句指向新要求。
- `chat-sessions`：改写「会话 REST」：消息形状、严格键集与 fork 拷贝列表加 `thinkingMs` / `thinking_ms`。
- `turn-control`：改写「从此处分叉 REST」：拷贝断言加 `thinkingMs`。

chat-sessions 的另外两条要求在本 change 之后仍成立：「会话持久化与回合刷盘」的正文落库规则（2048 字节 / 2000ms），以及「Complete snapshot overlap boundary」：合并器在 `appendDelta` 之前，store 只看到已发布的增量。不改，理由见 design「规格影响」。

## Impact

- **服务端**：
  - 新模块：合并器 `server/src/sessions/delta-coalescer.ts`，取代 `thinking-buffer.ts` 的阈值逻辑；思考时长 `server/src/sessions/thinking-span.ts`。
  - 调整 `supervisor.ts` 的 `#commit` / `#publish` 冲刷点；`store-thinking.ts` 加时长写入；新增 `server/src/core/db/migrations/044_chat_message_thinking_ms.sql`。
  - 快照的 `MessageView` 与 REST 形状加 `thinkingMs`；`events.ts` 的 `ChatEvent` 加 `thinking.end`。
- **web**：
  - `web/src/lib/session-contract.ts`（`thinkingMs`）。
  - `web/src/features/chat/stream.ts` / `stream-thinking.ts`（解码与归约）。
  - `message-thread.tsx`（等待指示、小圆点、平滑）。
  - `thinking-fold.tsx`（应用层标题、预览、平滑）。
  - `smooth-text.tsx`（新，应用层的 `useSmooth` 包装，正文与思考共用）。
  - `message-waiting.tsx`（新，等待指示与判据）。
  - 拷入层不改（design D8）。
- **测试与夹具**：
  - `server/test/support/fake-upstream.mjs` 与新模块 `fake-upstream-pace.mjs`（`WORKBUDDY_PACE`、`WORKBUDDY_THINK_LONG`、`WORKBUDDY_HOLD_AT`）。
  - `thinking-buffer.test.ts` / `session-thinking.test.ts` 等改为新节奏。
  - ui-walk 的光标与折叠块步骤。
  - `smoke/session-meta.hurl`。
- **文档**：
  - `docs/acceptance/functional-checklist.md`。
  - `docs/adr/0013-assistant-ui-frontend-rebuild.md` 补一条：正文逐字显现重新启用。
- **线协议**：
  - 新增一类 SSE 事件 `thinking.end`。旧客户端按「未知事件保持原状态」忽略它，不破坏既有消费者。
  - 快照消息多一个字段 `thinkingMs: number | null`。
- **依赖**：无新增（`useSmooth` 来自已安装的 `@assistant-ui/react`）。
- **CI**：`.github/scripts/ci-uid-isolation.sh` 的官方 omp 用例列表加一个文件，`scripts/test-ci-harness.sh` 的钉子同步改（tasks 2.5）。

## 流程记录

```text
Issue type: feature
Pipeline: stage-change-pipeline（owner 2026-10-13 Q11：#910 走完整流水线）；grill 2026-10-13 已过（Q9、Q15），设计期开放项 2026-10-14 由 owner 逐条裁定
Tracking: #910 为父 issue，Stage 5 在其下建子 issue；#910 在全部子 issue 合并后关闭（不是 Epic）
```
