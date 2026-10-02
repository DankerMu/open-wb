# Design: thinking-fold-block（#534）

## Context
- `web/src/features/chat/stream.ts`（773 行）：`ChatMessageView`（`:27-35`）无 `thinking`；`chatStateFromSnapshot`（`:102-121`）不拷贝它；`turn.start` 复位字面量（`:124-138`）与 `emptyAssistant`（`:229-239`）；`DATA_EVENTS`（`:79-88`）八类；`decodeEvent`（`:666-685`）；`replaceAssistant`（`:241-270`）对不存在的消息用 `emptyAssistant` 补建、对 user 消息返回原状态。
- `stream-approvals.ts`（120 行）是「新事件的解码与消息级归约拆到独立文件」的先例：导出事件类型、`decodeXxx(value)`、`(message, data) => message` 归约，`stream.ts` 只留接线。
- `conversation-view.tsx`（258 行）`MessageArticle`（`:76-136`）：`.chat-msg-main` 内依次为 `ApprovalBars`、`.chat-md`、步骤卡、错误、`已停止` 徽章、`MessageActions`。按 `message.id` 为 key、`memo`。
- `复制` 读 `message.content`（`conversation-view.tsx:131`），与 thinking 无关。
- 页面的 `isUnknownTurn`（`stream.ts:262-275`）读 `event.data.messageId`，对任何带 `messageId` 的事件都成立。
- demo 原型：`resource/workbuddy-live-demo.html:539-545`（样式）、`:2383-2386`（结构）。

## Decisions

### D1 视图字段
`ChatMessageView` 加 `thinking: ChatMessage["thinking"]`。`chatStateFromSnapshot` 取快照原值（含空串）；`turn.start` 复位字面量与 `emptyAssistant` 为 `null`。必有键，不做可选（proposal 偏差 1）。

### D2 `stream-thinking.ts`
照 `stream-approvals.ts` 的形状，只导出三样：
- `ChatThinkingEvent = { type: "thinking.delta"; data: { messageId: number; delta: string } }`
- `decodeThinkingDelta(value: unknown): ChatThinkingEvent | undefined`：`hasExactlyKeys(value, ["messageId", "delta"])`、`messageId` 安全整数、`delta` 为非空字符串；否则 `undefined`。
- `appendThinking<M extends { thinking: string | null }>(message: M, delta: string): M`：返回 `{ ...message, thinking: (message.thinking ?? "") + delta }`，不改输入。

`stream.ts` 的接线：`ChatEvent` 联合加 `ChatThinkingEvent`；`DATA_EVENTS` 加 `"thinking.delta"`；`decodeEvent` 加一支；`applyChatEvent` 加一支 `replaceAssistant(state, messageId, (m) => appendThinking(m, delta))`（不传 `sessionStatus`，会话状态不变）。由此：不存在的 assistant 补建（running、正文空、`thinking` 为该 delta），user 消息返回同一引用——都是 `replaceAssistant` 的既有行为，不另写分支。归约器不按消息状态设门（`text.delta` 也不设）。

`decodeEvent` 返回 `undefined` 之后的路径不动：`onDataFrame` 把非法 payload 当作重同步触发，不交付。

预算：`stream.ts` 预计 +15 行左右（≤800）。若超，把更多内容挪进 `stream-thinking.ts`，不压缩既有代码。

### D3 `thinking-block.tsx` 与开合状态
```tsx
export function ThinkingBlock({ running, text }: { running: boolean; text: string }) {
  const [open, setOpen] = useState(running);
  return (
    <details className="thinking-block" onToggle={(event) => setOpen(event.currentTarget.open)} open={open}>
      <summary className="thinking-summary"><Icon name="chevron-right" size={14} />深度思考过程</summary>
      <div className="thinking-body">{text}</div>
    </details>
  );
}
```
`MessageArticle` 在 `<ApprovalBars>` 之前渲染：`message.thinking ? <ThinkingBlock key={message.status} running={message.status === "running"} text={message.thinking} /> : null`。

- 开合是 React 状态，初值取自挂载时的消息状态；`key={message.status}` 让每次状态迁移重新挂载，从而拿到新初值（running → 展开，终态 → 收起）。`thinking.delta`、`text.delta`、`step.*`、`approval.*` 与同状态的快照重同步都不改 `status`，不重新挂载，用户的选择留在状态里。
- 不用 effect 去写 DOM 的 `open`，也不依赖「React 不重写未变的属性」。
- 用户点击 summary 由浏览器切换 `open` 并触发 `toggle`，`onToggle` 把 DOM 的值同步回状态。
- 主体是 `div` 里的一个文本节点（React 转义），不经 `MarkdownView`。类名沿用 demo 的 `thinking-block`/`thinking-body`（规格钉了前者）。
- `Icon` 不带 label 即装饰性（`aria-hidden`，`web/src/ui/icon.tsx:106-114`）。

### D4 样式（`messages.css`，486 行）
按 demo:539-545：`.thinking-block { border-left: 3px solid var(--wb-border-default); padding: 4px 12px; margin-bottom: 8px; }`；summary `display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12.5px; color: var(--wb-text-secondary); user-select: none; list-style: none;` 加 `::-webkit-details-marker { display: none; }`；图标 `transition: transform 0.2s`，`.thinking-block[open]` 下 `rotate(90deg)`；`.thinking-body { margin-top: 6px; font-size: 12.5px; line-height: 20px; color: var(--wb-text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }`。图标的过渡加进既有的 `@media (prefers-reduced-motion: reduce)` 块（`messages.css:445`）为 `transition: none`。不写 `outline`（summary 用浏览器默认焦点环）。`chat.css` 不动。

### D5 既有测试的改动
只在整对象断言的视图字面量里加 `thinking: null`（proposal 偏差 1）。快照字面量（带 `createdAt` 的）在 5.1 时已有该键，不动。

## Must-preserve
- 其它八类事件的解码、归约、游标过滤、队列与恢复；未知事件类型仍被忽略且不触发重同步。
- `复制` 只复制正文；审批条、步骤卡、错误、`已停止` 徽章、操作行的行为与相对次序。
- `page.tsx` 不动；`isUnknownTurn` 不动。

## Required evidence（`web/test/chat-thinking.test.tsx`）
连接器与归约用 `chat-stream-support.ts` 的 `connectChat`/`FakeEventSource`；页面级用 `chat-page-support.tsx` 的 `renderChatPage`（`chat-copy.test.tsx`、`chat-steps.test.tsx`、`chat-approval-bar.test.tsx` 的既有搭法）。

- T1 游标过滤：快照游标 1:3；thinking.delta(1:3) 不交付；thinking.delta(1:4) 交付 `onEvent`，事件为 `{type:"thinking.delta", data:{messageId, delta}}`；未知类型 `foo.bar`(1:5) 不交付、`loadSnapshot` 调用次数不变。
- T2 严格解码（表驱动）：`delta` 为 `""`、为数字、缺失；多一个键；`messageId` 为 `1.5`、为字符串；data 不是 JSON。每一例：`loadSnapshot` 调用次数 +1（重同步），`onEvent` 未收到该事件，无 `onError`。
- T3 归约追加：冻结的 running assistant 状态依次应用 `先`、`想` → `thinking` 为 `先想`；正文、步骤、会话状态不变；user 消息与 `steps` 数组保持同一引用；输入未被修改。快照 `thinking` 为 `null` 的消息应用 `x` → `x`。
- T4 快照映射：`chatStateFromSnapshot` 对助手消息逐值带出 `thinking`（字符串、`null`、空串各一条），user 消息为 `null`。
- T5 复位与边界：再次 `turn.start` → `thinking` 为 `null`；指向 user 消息 id 的 thinking.delta → 同一引用；视图中不存在的 messageId → 末尾补建 `{role:"assistant", status:"running", content:"", thinking:"y", steps:[], approvals:[], error:null}`，会话状态不变。
- T6 流式（Scenario「流式展开、终态收起」）：running 助手（`thinking` 为 `null`）起初没有 `details.thinking-block`；推 thinking.delta `先想一想` → 折叠块出现，是 `.chat-msg-main` 的第一个子元素且在 `.chat-md` 之前，summary 文本 `深度思考过程`，`open` 为 true，主体文本 `先想一想`；再推正文 delta 与 `turn.end done` → `open` 为 false，主体文本仍在 DOM 且不变；点 `复制` → `clipboard.writeText` 的参数恰为正文，不含思考文本。
- T7 快照（Scenario「快照中的思考与截断标记」）：三条 done 助手消息，`thinking` 分别以 `…（已截断）` 结尾、为 `null`、为空串 → 只有第一条有折叠块且收起；点 summary 后展开，主体文本末尾恰为 `…（已截断）`（测试里写字面量，不从 server 导入）。
- T8 手动保留（Scenario「用户手动切换保留」）：running 期间点 summary 收起 → 推两条 thinking.delta、一条 text.delta、一条 step.start → 仍收起；再点 → 展开，主体含全部文本。另一例：done 消息的折叠块由用户展开，随后触发一次同快照的重同步（`FakeEventSource` 再次 `open`）→ 仍展开。
- T9 其它迁移：`turn.end stopped` → 收起；`error` 后 `turn.end failed` → 收起；从快照打开 running 消息（`thinking` 非空）→ 展开；对同一消息再次 `turn.start` → 折叠块消失。
- T10 次序（Scenario「助手块次序」）：`stopped` 助手消息带 `thinking`、一条已结算审批、正文 `部分回答`、一个已结束 `bash` 步骤 → `.chat-msg-main` 的子元素按序为 `details.thinking-block`（收起）、审批条 group、`.chat-md`、步骤卡、`助手消息 已停止` 徽章、操作行；`复制` 的参数恰为 `部分回答`。
- T11 纯文本：`thinking` 为 `**粗** <b>x</b>\n  缩进` → 主体 `textContent` 逐字相同，折叠块内没有 `strong`、`b` 元素；`messages.css` 的 `.thinking-body` 规则含 `white-space: pre-wrap`。
- T12 静态样式：summary 隐藏默认标记（`list-style: none` 与 `::-webkit-details-marker`）；`.thinking-block[open]` 下图标旋转；reduced-motion 块里图标 `transition: none`；`chat.css` 不含 `thinking-`。

变异自检（实现者在沙箱里做，做完还原，写进报告）：去掉 `DATA_EVENTS` 的新条目；解码接受空 `delta`；解码不查键集；`turn.start` 不复位 `thinking`；`chatStateFromSnapshot` 不带 `thinking`；去掉 `key={message.status}`；去掉 `onToggle`；`open` 恒取 `running`（不用状态）；折叠块放到审批条之后；主体改走 `MarkdownView`；空串也渲染。每个变异至少让一例变红。

一次性真实浏览器观察（Chromium，vite preview + 路由 mock，不入库）：done 消息的折叠块初始收起，点击展开、再点收起；running 消息（快照）初始展开，点击收起后在一次事件流重连引发的重同步之后仍收起；主体保留换行。

## 已知残留
1. 状态迁移时折叠块重新挂载：迁移那一刻焦点若在 summary 上会丢到 `body`。
2. 终态消息收到 thinking.delta 仍会追加（归约器不按状态设门，与 `text.delta` 一致）；服务端在 `turn.end` 之前冲刷，正常不会发生。
3. `isSafeInteger` 在 `stream.ts`、`stream-approvals.ts` 之外多一份私有拷贝（jscpd 的最小片段以下；若触发基线则改从 `stream-approvals.ts` 导出复用）。
4. 折叠块收起时主体仍在 DOM 里（`<details>` 的原生行为），浏览器的页内查找会自动展开它。

## Seams under test
- 纯函数：`chatStateFromSnapshot`、`applyChatEvent`。
- 连接器：`connectSessionEvents` + `FakeEventSource`（交付、丢弃、重同步）。
- jsdom 页面 fixture：折叠块的出现、次序、开合、`复制`。
- 静态 CSS 文本。
