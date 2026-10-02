# Proposal: thinking-fold-block（#534，父 tasks 7.4）

## Why
服务端已经合并发布 `thinking.delta`、把思考落到 `chat_messages.thinking` 并在快照里给出（#519、#523），web 的快照解析也已带 `thinking` 键（5.1）。但会话页不认 `thinking.delta`（`web/src/features/chat/stream.ts:79-88` 的 `DATA_EVENTS` 没有它，作为未知类型被忽略），聊天视图也不带 `thinking`（`stream.ts:27-35`、`:102-121`），所以思考内容到了浏览器就丢了。本刀把它接成用户可见的 `深度思考过程` 折叠块。

## What Changes
- 新建 `web/src/features/chat/stream-thinking.ts`：`thinking.delta` 严格解码与消息级纯归约（追加到 `thinking`，`null` 视为空串）。
- `stream.ts`：消息视图加 `thinking: string | null`（快照原值；`turn.start` 与补建的 assistant 为 `null`）；`ChatEvent` 联合、`DATA_EVENTS`、`decodeEvent`、`applyChatEvent` 各加 `thinking.delta` 一支，接到新模块。游标过滤、队列、恢复不动。
- 新建 `web/src/features/chat/thinking-block.tsx`：`<details class="thinking-block">`，summary `深度思考过程` + 装饰性 `chevron-right`，主体纯文本。开合：running 展开、终态收起、两次状态迁移之间保留用户的手动选择。
- `conversation-view.tsx`：助手块最前（审批条之前）渲染折叠块；`thinking` 为 `null` 或空串不渲染。
- `messages.css`：折叠块样式（demo:539-545）。`chat.css` 不动（797/800）。
- 新建 `web/test/chat-thinking.test.tsx`。

## Fixture
- Level: `expanded`（issue 建议；`thinking.delta` 走事件流的严格解码与恢复路径，折叠块有开合状态机）。
- Review priority: contract——严格解码的拒绝面（→ 重同步而非静默丢弃）与开合状态机。

## Spec deltas
- ADDED `thinking-fold`「深度思考折叠块呈现」。
- MODIFIED `chat-web`「纯会话视图归约」：视图带 `thinking`、八类 → 九类、`turn.start` 复位、thinking.delta 追加；Scenario「思考归约」。
- MODIFIED `chat-web`「事件流消费与续流」：八类 → 九类、`thinking.delta` 严格键集；Scenario「思考事件严格解码」。
- MODIFIED `chat-web`「会话页」：**Assistant block order** 一段（只含本刀已有的部件）；Scenario「助手块次序」。

## Non-goals
- 服务端的合并发布、落库、32K 上限（3.1、3.3，已合并）；快照 `thinking` 键解析（5.1，已合并）；`session-contract.ts` 不动。
- `files.changed` 解码、步骤 `changes` 视图、文件变更卡与产物卡（7.5a、7.5b）。
- 对话内搜索对 thinking 的排除（7.7）；ui-walk 折叠块步骤（8.2a）。
- `stream-approvals.ts`、`approval-bar.tsx`、`page.tsx`、`web/src/ui/**`、`web/src/lib/**`、server 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **既有测试有改动**：issue 写「既有测试零 diff」「既有测试文件不增长」。消息视图加了必有键 `thinking` 之后，既有的整对象断言（`toEqual`/`toStrictEqual` 的视图字面量）都少一个键：`web/test/chat-stream.test.ts`、`chat-stream-connection.test.ts`、`chat-stream-stopped.test.ts`、`chat-stream-approvals.test.ts` 与 `chat-stream-support.ts` 的 `userView`。这些字面量各加一行 `thinking: null`，别的不动（`approvals` 落地时 `userView` 也是这样加的）。不采用「值为 null 时省略该键」来保住零 diff：父文写的是 `thinking: string|null`。
2. **视图中不存在的 `messageId`：补建而非忽略**。issue 的 In Scope 与验收写「未知消息忽略并返回同一引用」；父 chat-web delta 写「不存在的 assistant 按消息事件补建」，父 Scenario 里「返回同一引用」说的是指向不存在步骤的 `files.changed`。按父规格走，与 `text.delta` 一致：忽略会让随后的正文事件补建出一条没有思考的消息，实时视图就和重载快照不一样了。指向 user 消息的 `thinking.delta` 返回同一引用（既有「不得重写 user 消息」）。上一条助手已终态时到达的未知回合事件仍由页面的 `isUnknownTurn` 重同步（`stream.ts:262-275`，读 `event.data.messageId`，无需改）。
3. **`stream.ts` 的改动不止 `DATA_EVENTS`**：issue 写「`stream.ts` 只在 `DATA_EVENTS` 增 `thinking.delta` 并接线」。视图类型、`chatStateFromSnapshot`、两处复位字面量、`ChatEvent` 联合、`decodeEvent` 与 `applyChatEvent` 各一处也必须动（接线的全部落点）；解码与追加的逻辑本身在新模块。
4. **只并入父 delta 的 thinking 部分**：归约器是九类不是十类（`files.changed` 归 7.5a）；步骤视图不加 `changes`；Assistant block order 与 Scenario「助手块次序」不含文件变更卡与产物卡；父 Scenario「思考与文件变更归约」「思考与文件变更事件严格解码」在子 delta 里叫「思考归约」「思考事件严格解码」，7.5a 再并入文件变更部分并改回父名。
5. **thinking-fold「深度思考折叠块呈现」去掉「不参与对话内搜索（见 conversation-search）」一句**：主规格还没有 conversation-search，这句由 7.7 加回。
6. 子 delta 另加父文未写的可观察行为：从快照打开 running 消息为展开；手动选择不被「同状态的快照重新同步」重置；解码拒绝面列全（`delta` 空串、非字符串、缺失、多键、`messageId` 非安全整数）；thinking.delta 不改会话状态。

## Impact
- web：两个新产品文件、`stream.ts`/`conversation-view.tsx`/`messages.css` 改动、一个新测试文件、五个既有测试文件各加若干行 `thinking: null`。server、shell、`page.tsx` 无改动。
- 运行时：无新增请求；带思考的回合多渲染一个折叠块。
- 依赖：#517、#519、#523（5.1）、#529（7.0）、A #489、#480 已合并。
