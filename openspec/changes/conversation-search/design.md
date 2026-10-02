# Design: conversation-search（#538）

## Context
- `topbar-actions.ts`（44 行）：`CHAT_TOPBAR_ACTIONS` 三个槽位（`rename`、`search`、`artifacts`），`chatTopbarActions(slots)` 按常量次序产出已填槽位，槽位值是 `Pick<TopbarAction, "expanded" | "onSelect">`；`chatTopbar(selected, openRename, openArtifacts)` 填 `rename` 与 `artifacts`，`selected` 为空时返回 `{}`。`page.tsx:635` `useTopbar(chatTopbar(selected, sessionActions.openRename, artifacts.open))`。
- `web/src/lib/topbar.tsx:20-26`：`TopbarAction { key, label, icon, expanded?, onSelect(trigger) }`；`expanded` 参与可比较字段（`sameActions`），变化即换 state；shell（`routes/shell/topbar.tsx:15-33`）给每个按钮 `aria-expanded={action.expanded}`、`key={action.key}`，容器在「有标题且 actions 非空」时渲染——`selected` 一直有值时按钮节点不重挂。
- `scroll-follow.tsx`（119 行）：`useScrollFollow(ref, content)` 持有 `pinned` ref 与 `showJump`；`onScroll`（`:49-60`）按距底重算：≤4px → 贴底并隐藏按钮；否则解除贴底，距底 > `clientHeight` 时显示按钮。`settle`（`:25-41`）在内容或尺寸变化后执行：贴底则 `scrollTop = scrollHeight`，否则保持位置。`FollowTranscript({ children, content })`（`:103-119`）只在 `conversation-view.tsx:235` 使用，`key={requestedSessionId}`（切换会话即重挂）。
- `conversation-view.tsx`（286 行）：`MessageArticle`（`memo`，`:85`）的两个 `<article>`（用户 `:112`、助手 `:121`）只有 `aria-label` 与 `chat-msg*` 类；`MessageThread`（`:157`）按 `historyView.messages` 原序渲染，`key={message.id}`。`.chat-main` 的子节点依次是三个 alert、`FollowTranscript`（或欢迎态内容）、`Composer`。
- 消息 id：`stream.ts:21-22` `ChatMessageView.id` 是数字，测试夹具里用户消息为 `-3`、助手为 `0`（`web/test/chat-stream-support.ts:21-22,69`）——**`0` 与负数都是合法 id**。
- `page.tsx`（694 行）：`historyView`（`ChatState | null`，`:631`）、`selected`（`:632`，有当前会话且标题已知时有值——来自列表项或已就绪的历史快照，`session-path.ts:30-41`）；`ChatPage` 的认知复杂度在 Biome 上限 15（`?.` 不计）。
- 样式：`chat.css` 797/800 行，新样式进 `messages.css`（696 行）。`.chat-main` 是 `display:flex; flex-direction:column; gap:8px; overflow:hidden`（`chat.css:260-267`），alert 用 `flex: none`（`:269-272`）。token `--wb-brand-primary-subtle` 浅色与深色都有定义（`web/src/styles/tokens.css:49,206`）。feature CSS 不得出现颜色字面量与 `--wb-palette-*`（颜色守卫，注释也算）。
- 基元：`Input variant="search"`（`web/src/ui/input.tsx`）渲染 `div.ui-input.ui-input--search`（宽 240px，`input.css:26-32`）内含搜索图标与 `input[type=search]`，`className` 落在根 div，`ref` 与其余属性落在内层 input。图标 `search`、`chevron-up`、`chevron-down`、`x` 已注册（`web/src/ui/icon.tsx`）。feature 里的图标按钮写法：`<Button aria-label title size="icon" variant="ghost">`（`message-actions.tsx:26-35`）。
- 输入法：`composer.tsx:55-56` 用 `event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229` 跳过组合期间的 Enter。
- 侧栏的当前会话按钮也带 `aria-current="true"`（`web/test/chat-page-session-rename-pin.test.tsx:180`）——测试里判断高亮要限定在 `article` 上。
- 既有测试对 banner 按钮的整表断言：`web/test/chat-page-session-rename-pin.test.tsx:470,487,527,539`、`web/test/chat-page-artifacts-panel.test.tsx:101,108,265`；`chatTopbar` 的单元调用在 `chat-page-artifacts-panel.test.tsx:123-131`。`web/test/chat-scroll-follow.test.tsx:15-58` 的滚动度量 mock 是该文件私有的。jscpd 扫 `web/**/*.{ts,tsx}`（含测试），门禁是重复占比 ≤3%；当前 178 个克隆，子刀沿用「克隆数不增」的自我约束。
- demo：`resource/workbuddy-live-demo.html:1945-1952`（搜索框与按钮）、`:2002-2031`（开合、Enter/Shift+Enter/Escape、计数与 toast；`:2020` 每条消息至多计一次，即 demo 也按匹配消息计数）、`:323-328`（样式）。

## Decisions

### D1 `search-match.ts`
```ts
export function matchMessages(
  messages: readonly { id: number; content: string }[],
  query: string,
): number[]
```
`query === ""` → `[]`；否则 `needle = query.toLowerCase()`，按原序返回 `content.toLowerCase().includes(needle)` 的消息 id。只读 `id` 与 `content`——步骤、thinking、审批、错误在类型上就不可见。不 trim、不正则、不发请求。

### D2 `scroll-follow.tsx`：句柄
```ts
export type TranscriptHandle = { scrollToMessage(id: number): void };
export function FollowTranscript({ children, content, handleRef }: {
  children: ReactNode; content: unknown; handleRef: Ref<TranscriptHandle>;
})
```
`useImperativeHandle(handleRef, …)` 暴露：
```ts
scrollToMessage(id) {
  const target = ref.current?.querySelector(`[data-message-id="${id}"]`);
  if (!target) return;
  target.scrollIntoView({ block: "center" });
  onScroll();
}
```
- `onScroll()` 就是用户滚动时的那次重算（Context）。**跳转后同步调用它，不等浏览器的 scroll 事件**：scroll 事件下一帧才派发，其间到达的流式增量会走 `settle`，而 `pinned` 还是 `true`，转录被拽回底部，跳转丢失。随后真正到达的 scroll 事件再算一次，结果相同。
- 不无条件解除贴底：跳到最后一条消息时浏览器滚到底（居中不了），距底 ≤4px → 仍贴底、继续跟随。
- 选择器里只有数字 id（`-3`、`0` 都在引号内，合法）。
- `useScrollFollow` 的其余逻辑、`回到最新` 按钮、`settle` 不动。

### D3 `conversation-search.tsx`
```tsx
export function useConversationSearch(
  sessionId: string | undefined,   // page 传 selected?.id
  view: ChatState | null,
): {
  slot: { expanded: boolean; onSelect(trigger: HTMLElement): void };
  currentId: number | null;
  handleRef: RefObject<TranscriptHandle | null>;
  box: ReactNode;
}
```
- **状态只有一份**：`state: { sessionId: string; query: string; currentId: number | null } | null`（`null` = 关闭），外加两个 ref：`trigger`（打开时的顶栏按钮）与 `handleRef`。
- **以 `selected?.id` 为键**：渲染期校正 `if (state !== null && state.sessionId !== sessionId) setState(null);`（同组件 state 的渲染期调整，同 7.6 的 `useArtifactsPanel`）。切换会话、回到欢迎态、标题变为未知（顶栏按钮消失）都使键变化 → 关闭并清空；回到原会话时状态已是 `null`，不会重开。由此得到不变量「搜索框打开 ⇒ 顶栏处于第二态 ⇒ 打开它的那个按钮节点仍在文档中」（Context：`selected` 有值期间按钮不重挂），关闭时的焦点归还不会落空。
- **派生，不存**：`matches = matchMessages(view?.messages ?? [], state.query)`；`index = currentId === null ? -1 : matches.indexOf(currentId)`；计数器 `${index + 1}/${matches.length}`。所有判断用 `=== null` / `=== -1`，不用真值判断（id 可以是 `0`）。
- **原当前不再匹配**：渲染期校正 `if (state.currentId !== null && index === -1) setState({ ...state, currentId: null });`——清掉而不是只在显示上隐藏，这样该消息之后重新匹配也不会自动恢复（规格「直到下一次前进/后退」）。
- **滚动只发生在事件处理器里**，没有任何以 `currentId` 或 `matches` 为依赖的 effect：
  - 查询变化：`first = matchMessages(messages, value)[0] ?? null`；`setState({ ...state, query: value, currentId: first })`；`first !== null` 时 `handleRef.current?.scrollToMessage(first)`。
  - 前进/后退：`n === 0` 时不做事；前进取 `matches[(index + 1) % n]`（无当前时 `index = -1` → 第一条），后退取 `matches[(index <= 0 ? n : index) - 1]`（无当前或在第一条 → 末条）；`setState` 后 `scrollToMessage`。
  - 消息集合变化只经过上面的派生与渲染期校正——这条路径上没有 `scrollToMessage` 的调用点，「重算不触发滚动」由结构保证。
- **开合**：`slot.onSelect(el)`：已打开 → `el.focus()` 后 `setState(null)`；未打开且 `sessionId` 有值 → `trigger.current = el`，`setState({ sessionId, query: "", currentId: null })`。`close()`（Escape、`关闭`）：`trigger.current?.focus()` 后 `setState(null)`。显式 `focus()` 是因为 Safari 里鼠标点击不聚焦按钮（jsdom 的 `fireEvent.click` 同样不聚焦，测试借此覆盖）。
- **搜索框**（模块私有组件，只在打开时挂载）：
  ```tsx
  <div aria-label="对话内搜索" className="chat-search" role="search">
    <Input aria-label="搜索对话内容" className="chat-search-field" placeholder="搜索对话内容"
           variant="search" ref={input} value={query} onChange=… onKeyDown=… />
    <span aria-live="polite" className="chat-search-count">{`${index + 1}/${total}`}</span>
    <Button aria-label="上一个" title="上一个" disabled={total === 0} size="icon" variant="ghost">…chevron-up</Button>
    <Button aria-label="下一个" …>…chevron-down</Button>
    <Button aria-label="关闭" …>…x</Button>
  </div>
  ```
  计数器的子节点是**一个**模板字符串（写成 `{a}/{b}` 会渲染成三个文本节点，非 atomic 的 live region 只播报变化的那个节点，`1/3`→`2/3` 会被读成「2」）。挂载 effect 里 `input.current?.focus()`。`onKeyDown`：组合输入（`isComposing` 或 `keyCode === 229`）直接返回；`Enter` → `preventDefault()`，`shiftKey ? 后退 : 前进`；`Escape` → `preventDefault()`（`type="search"` 的原生行为是清空输入）后关闭。按键只挂在输入框上（规格「焦点在输入框时」）。
  - `role="search"` 显式写在 `div` 上：`<search>` 元素的隐式 role 在 jsdom 的查询与旧浏览器里不可靠。若 Biome `useSemanticElements` 报，用 `biome-ignore` 附这条理由。
- hook 体内的分支拆成小函数（如 `stepTarget(matches, index, dir)`），保持每个函数的认知复杂度 ≤15。实现者可以调整内部形状，但「状态一份、以 `selected?.id` 为键、滚动只在处理器里、`=== null` 判断」是硬约束。

### D4 `conversation-view.tsx`
- `ConversationViewProps` 增 `search: { box: ReactNode; currentId: number | null; handleRef: Ref<TranscriptHandle> }`。
- `{search.box}` 作为 `.chat-main` 的第一个子节点（三个 alert 之前）。
- `<FollowTranscript content={historyView} handleRef={search.handleRef} key={requestedSessionId}>`。
- `MessageThread` 收 `currentId`，给每个 `MessageArticle` 传 `current={message.id === currentId}`（布尔值，`memo` 下只有前后两条重渲染）。
- 两个 `<article>`：`data-message-id={message.id}`；`current` 时加 `aria-current="true"` 与类 `chat-msg--search-current`，否则两者都不出现（不输出 `aria-current="false"`）。

### D5 `topbar-actions.ts`
`chatTopbar(selected, openRename, search, openArtifacts)`，参数次序同槽位次序；`search` 是 `{ expanded: boolean; onSelect(trigger: HTMLElement): void }`，原样填入 `search` 槽。注释里的「`重命名` 与 `产物面板`」改成三者。`CHAT_TOPBAR_ACTIONS` 与 `chatTopbarActions` 不动。

### D6 `page.tsx`（694 → 697）
```ts
import { useConversationSearch } from "./conversation-search.js";
…
const search = useConversationSearch(selected?.id, historyView);
useTopbar(chatTopbar(selected, sessionActions.openRename, search.slot, artifacts.open));
…
<ConversationView … search={search} … />
```
`ChatPage` 不新增分支。

### D7 样式（`messages.css`）
- `.chat-search`：`flex: none; align-self: flex-end; display: flex; align-items: center; gap: 6px; max-width: 100%`。
- `.chat-search .chat-search-field`：`flex: 1 1 240px; width: auto; min-width: 0`（基元根的 240px 固定宽在 390px 视口放不下输入框 + 计数 + 三个按钮）。
- `.chat-search-count`：`flex: none; font-family: var(--wb-mono); font-size: 11px; color: var(--wb-text-secondary)`（demo:325）。
- `.chat-msg--search-current`：`background: var(--wb-brand-primary-subtle); box-shadow: 0 0 0 6px var(--wb-brand-primary-subtle)`（背景与同色外扩，等效于带 6px 内边距的底色而不改变布局；demo `.cs-mark` 用的同一 token）。`border-radius: 8px` 只写在 `.chat-msg-assistant.chat-msg--search-current` 上，用户气泡保留自己的圆角（实现时定下的写法）。
- 只用 token，无颜色字面量。实现者按真实渲染微调数值，上面的结构（`flex: none`、可收缩的输入框、token 底色）是约束。

### D8 既有测试的改动
- `web/test/chat-page-session-rename-pin.test.tsx:470,487,527`：`["重命名", "产物面板"]` → `["重命名", "对话内搜索", "产物面板"]`；`:539`：`["打开导航", "重命名", "产物面板"]` → `["打开导航", "重命名", "对话内搜索", "产物面板"]`。
- `web/test/chat-page-artifacts-panel.test.tsx:101,108,265`：同样的整表断言；P1 的两个 `chatTopbar(...)` 调用（`:124`、`:131`）补上 `search` 参数；`:133` 的键序期望多一项 `search`；`:134` 起取 `artifacts` 的下标由 `report.actions?.[1]` 变 `[2]`，「`artifacts` 不带 `expanded`」的断言保留。
- 其它既有测试零 diff，`web/test/chat-scroll-follow.test.tsx` 尤其不动。新测试需要的滚动度量 mock 与 `scrollIntoView` stub 写在新的 support 里；jscpd 若报新克隆，改新写的那份的形状，不去抽既有文件。

## Governing invariant
1. **滚动的唯一入口是用户动作**：`scrollToMessage` 只在查询变化、前进、后退三个事件处理器里调用；任何由消息集合变化引起的重渲染都不滚动。
2. **跳转与贴底状态在同一次调用里一致**：`scrollToMessage` 返回时，`pinned` 与 `回到最新` 已反映跳转后的位置；不存在「已跳走但仍贴底」的窗口。
3. **至多一条高亮**：`currentId` 是单值，`current` 由 `message.id === currentId` 派生。
4. **搜索框打开 ⇒ 顶栏第二态**：状态以 `selected?.id` 为键，按钮消失时搜索框必然已关闭。
5. **贴底跟随规则不变**：`chat-scroll-follow.test.tsx` 零 diff 全绿。

## Sibling surfaces
- `useArtifactsPanel`（7.6）：同样是「hook 持状态 + 顶栏槽位 + 渲染期校正」；本刀不改它。两者可同时存在：抽屉是模态层，打开时搜索输入框不可达；抽屉关闭后搜索框状态不受影响。
- `RenameDialog`（7.2a）：同上，模态。
- `回到最新` 按钮（`jumpToLatest`）：跳转后出现的按钮点击后回到底部并恢复贴底；不清除搜索高亮（高亮与滚动位置无关）。
- 侧栏当前会话按钮的 `aria-current="true"`：与消息高亮同名属性、不同元素。
- `Composer`：搜索输入框与 composer 文本框是两个独立输入；搜索框的 Enter 不发送消息（按键只在搜索输入框上处理并 `preventDefault`）。

## Must-preserve
- 贴底跟随与 `回到最新` 的全部既有规则（`chat-scroll-follow.test.tsx` 零 diff）。
- 消息 `<article>` 的既有 accessible name、类名与子结构；`MessageArticle` 仍是 `memo`。
- `重命名`、`产物面板` 的行为与焦点归还；欢迎态无任何顶栏按钮。
- `page.tsx` ≤ +10 行、`ChatPage` 复杂度不变；所有文件 ≤800 行；knip 零新增、jscpd 不增。

## Required evidence
`web/test/search-match.test.ts`：
- **U1** 规格 Scenario 的夹具（用户 `帮我做 Report` id `-3`、助手 `**report** 已生成，report 共 3 页` id `0` 且带一个 output 含 `report` 的步骤、用户 `谢谢`）→ `matchMessages(…, "REPORT")` 为 `[-3, 0]`。
- **U2** 空查询 → `[]`（包括存在 `content === ""` 的消息时）。
- **U3** 大小写双向不敏感；查 Markdown 源而非渲染文本（`**report**` 只匹配助手）；`thinking`、`error`、步骤 `detail`/`output` 含查询而 `content` 不含 → 不匹配；查询不 trim（`" report"` 与 `"report"` 结果不同的一组）。
- **U4** 结果保持转录次序；id `0` 与负数原样返回。

`web/test/chat-page-search*.test.tsx`（真实 `AppShell` + `ChatPage`，banner 在场）：
- **S1 打开**：点击 `对话内搜索` → `main` 内出现 `role="search"`（名 `对话内搜索`），不在 banner 内，且就是 `.chat-main` 的 `firstElementChild`；输入框（`role="searchbox"`，名与 placeholder `搜索对话内容`）是 `document.activeElement`；区域内子节点次序为输入框、计数器、`上一个`、`下一个`、`关闭`，三个按钮的图标类分别含 `lucide-chevron-up`、`lucide-chevron-down`、`lucide-x`；计数器 `0/0` 且 `aria-live="polite"`；`上一个`/`下一个` 禁用、`关闭` 可用；顶栏按钮 `aria-expanded` 由 `"false"` 变 `"true"`。
- **S2 计数**（Scenario「计数为匹配消息数」）：输入 `REPORT` → `1/2`；输入 `不存在` → `0/0` 且两按钮禁用；从打开到结束 `fetchMock` 调用数与 `EventSource` 实例数不变。
- **S3 键盘循环与关闭**（Scenario）：3 条匹配，Enter×3、Shift+Enter → `2/3`、`3/3`、`1/3`、`3/3`；Escape → 无 `role="search"`、无 `article[aria-current]`、无 `.chat-msg--search-current`、焦点在顶栏按钮、`aria-expanded="false"`；再打开 → 输入框空、`0/0`。
- **S4 按钮**：`下一个`/`上一个` 的循环与按键一致；`关闭`（`fireEvent.click`，事先不聚焦任何按钮）→ 关闭且焦点在顶栏按钮；再点顶栏按钮（已打开时）→ 关闭、清空、焦点在顶栏按钮。
- **S5 组合输入**（Scenario）：`keyDown` 带 `isComposing: true` 的 Enter 与 Escape、带 `keyCode: 229` 的 Enter → 计数器不变、搜索框仍在；随后普通 Enter 生效。
- **S6 标记**：每条消息的 `article` 都带 `data-message-id`，值等于消息 id（含 `-3` 与 `0`）；任一时刻 `article[aria-current="true"]` 至多一条，且它同时带 `chat-msg--search-current`；非当前消息没有 `aria-current` 属性；当前为 id `0` 的消息时高亮与 `i` 正确（真值判断的变异在此失败）。
- **S7 跳转调用**：`scrollIntoView` stub 记录（目标的 `data-message-id`、参数）：输入有匹配的查询 → 恰一次，目标为第一条匹配，参数 `{ block: "center" }`；Enter → 再一次，目标为下一条；输入无匹配的查询 → 不调用；全程无 Toast。
- **S8 流式更新不抢滚动**（Scenario）：运行中会话，输入查询使当前为第 1 条（`1/1`，stub 把 `scrollTop` 设到非底部位置）；随后内容变高并到达流式增量、助手正文新出现匹配 → `1/2`、高亮仍在原消息、`scrollIntoView` 调用数不变、`scrollTop` 保持在跳转后的值。
- **S9 原当前不再匹配**（Scenario）：快照重载（经 `web/test/chat-unknown-turn.test.tsx` 那条 resync 路径或等效的 ready→ready 重载）后当前消息正文不再含查询 → `0/n`、无高亮、`scrollIntoView` 调用数不变；**再重载一次使该消息重新匹配** → 仍是 `0/n`、无 `article[aria-current]`、`scrollIntoView` 调用数不变（「只派生、不清 `currentId`」的实现在此失败；重载可用 `FakeEventSource.emitGap()`，`web/test/chat-stream-support.ts:193`）；Enter → `1/n`、第一条匹配高亮；另一组从无当前按 Shift+Enter → `n/n`、末条高亮。
- **S10 跳走后不拽回**（Scenario「跳转滚动并高亮」第二组）：度量 mock 下转录贴底；`scrollIntoView` stub 把 `scrollTop` 设到顶部且**不派发 scroll 事件**；输入查询 → `回到最新` 出现；随后内容变高并到达流式增量 → `scrollTop` 保持、`回到最新` 仍在。（去掉 D2 的同步重算，此用例必须失败。）
- **S11 跳到底部仍跟随**（Scenario）：stub 把 `scrollTop` 设到距底 ≤4px → `回到最新` 不出现；内容变高并到达增量 → `scrollTop` 跟到新的底部。（把同步重算换成「无条件解除贴底」，此用例必须失败。）
- **S12 切换会话**（Scenario）：搜索框打开且有高亮时在侧栏选另一会话 → 无 `role="search"`、无 `article[aria-current]`、按钮 `aria-expanded="false"`；选回原会话 → 仍无搜索框；再打开 → 输入框空。
- **S13 欢迎态**：搜索框打开时导航到 `/` → 无搜索框；banner 无这些按钮；再进入会话 → 关闭态。
- **S14 全序**（Scenario「顶栏入口」「顶栏重命名入口」）：`/?session=<id>` 且标题已知 → banner 内 heading 之后恰三个按钮，次序 `重命名` → `对话内搜索` → `产物面板`，无 `更多`，`对话内搜索` 的图标类含 `lucide-search`、带 `aria-expanded="false"`，另两个按钮不带 `aria-expanded`；≤760px → `["打开导航", "重命名", "对话内搜索", "产物面板"]`；欢迎态无任何这些按钮。
- **S15 历史未读到**：历史请求挂起（标题来自列表）时打开 → `0/0`；输入查询后历史到达 → `0/n`（无当前、无高亮、`scrollIntoView` 未被调用）；Enter → `1/n`。另一组历史读取失败（页面上有 `role="alert"`）时打开 → 搜索框在该 alert 之前（仍是 `.chat-main` 的第一个子节点）、计数器 `0/0`、输入查询不抛错。
- **S16 `chatTopbar` 单元**：`chatTopbar(undefined, …)` 为 `{}`；有会话时产出三项，键序 `rename`、`search`、`artifacts`，只有 `search` 带 `expanded`（值原样透传），`search` 的 `onSelect` 收到 trigger。
- **S17 找不到消息节点**：直接渲染 `FollowTranscript`（带 `handleRef`，子节点里有一个 `data-message-id="1"` 的元素），`scrollToMessage(1)` 调用 stub 一次、`scrollToMessage(999)` 不抛错、不调用 `scrollIntoView`、`回到最新` 的显隐不变。
- 既有：`chat-scroll-follow.test.tsx` 零 diff 全绿；D8 列出的期望更新后两个既有文件全绿。

实现前就成立的护栏（不计入 RED）：无（U、S 全部依赖新文件或新按钮；基线上 21 个用例失败、`search-match.test.ts` 收集失败）；D8 的既有断言在实现前为绿、实现后按 D8 更新。

实现时在规格之外补的断言：S1 断言计数器 `childNodes.length === 1` 与三个按钮的 `title`；S5 断言 Enter / Escape 调了 `preventDefault()`；S7 多一组「当前匹配仍是同一条消息时，查询变化与 Enter 仍各滚动一次」（否则「按 `currentId` 触发的 effect 取代处理器滚动」的实现杀不掉）；S10 末尾点 `回到最新` 后回到底部且高亮不变；S15 失败组断言搜索框是 `firstElementChild` 且其后紧跟 alert；S17 在转录区之外另放一个带 `data-message-id` 的元素，证明查询只在自己的转录区内。S16 合成一个用例（`chatTopbar(undefined, …)` 为 `{}` 在基线就成立，单列会是基线绿）。

## 变异自检
实现者在沙箱里对产品代码做了 39 个变异（脚本与日志不入库），全部至少使一个用例变红，无存活：`scrollToMessage` 去掉同步重算（S8、S10、S17）、改成无条件解除贴底（S10、S11、S17）、去掉找不到节点的返回（S17）；只派生不清 `currentId`（S9 第二次重载）；加滚动 effect（S5、S7–S11、S15）；id 的真值判断（S6）；状态不按会话为键（S12、S13）；关闭不聚焦顶栏按钮（S3、S4）；组合输入期间处理按键（S5）；demo 的后退公式（S9）；`matchMessages` 搜步骤输出 / thinking / trim（U3）、去掉一侧 `toLowerCase()`（U1、U3、S2）；搜索框放到 alert 之后（S15 失败组）；`aria-current="false"`（S6）；`chatTopbar` 槽位去掉 `expanded` / 填错槽（S14、S16）；计数器三个文本节点（S1、S2）；chevron 互换（S1）。

## 真实浏览器观察（Chromium，一次性，结果进 PR）
jsdom 没有布局，下面这些只能在浏览器里看（mock API，1440 / 390 / dark）：
1. 超过三屏、首末两条消息匹配、转录贴底：输入查询后第一条匹配的 `article` 矩形落在 `.chat-transcript` 的可视矩形内、带 `aria-current`；`回到最新` 出现；`window.scrollY`、`document.scrollingElement.scrollTop` 以及四个 `overflow: hidden` 的祖先（`.chat-page`、`.chat-layout`、`.chat-main`、`main`）的 `scrollTop` 仍为 0（`scrollIntoView` 也会滚动 `overflow: hidden` 的祖先，这里确认没有）。Enter 后最后一条在可视范围内、`回到最新` 消失。
2. 390px：搜索框不溢出（`documentElement.scrollWidth <= clientWidth`，`关闭` 按钮在视口内）；顶栏三按钮与标题不重叠。
3. Escape 在 `type="search"` 输入框里关闭搜索框（不是只清空）；焦点落在顶栏 `对话内搜索` 按钮；Tab 次序为输入框 → `上一个` → `下一个` → `关闭`。
4. 浅色与深色下高亮消息的底色都与未高亮的不同（计算样式），用户气泡与助手消息各看一次；高亮的外扩没有被转录区裁成不可辨。
5. 打开/关闭搜索框时贴底的转录仍贴底（转录区变矮一行，由既有的尺寸变化重算处理）。

**观察结果**（Chromium，mock API，生产构建，1440 / 390 / 1440-dark，脚本不入库）：1–5 全部成立。输入查询后首条匹配完整落在转录可视矩形内、`回到最新` 出现，Enter 后末条可见且按钮消失，Shift+Enter 回到首条；`window`、`document` 与四个祖先的 `scrollTop` 全程为 0；390px 无横向溢出，搜索框占 x=42–370；Tab 次序为输入框 → `上一个` → `下一个` → `关闭`；Escape 与 `关闭` 都关掉搜索框并把焦点还给顶栏按钮，再打开时输入框为空、`0/0`；两种主题下用户气泡与助手消息的高亮底色都与未高亮不同；全程无 Toast；贴底的转录在搜索框开合时保持贴底。另见「已知残留」7–9。

## 已知残留
1. 超过一屏高的消息居中后看不到开头（规格值 `block: "center"`）；消息级高亮不指出消息内的具体位置（Non-goal）。
2. 焦点在 `上一个`/`下一个`/`关闭` 按钮上时按 Escape 不关闭搜索框（规格只规定焦点在输入框时）。
3. 只在 Chromium 里观察；Safari/Firefox 的 `scrollIntoView({ block: "center" })` 与 `type="search"` 的原生外观未验证（本机只装了 Playwright 的 Chromium）。
4. 输入法组合期间每次按键都会按组合中的文本重算匹配并跳转（如拼音中间态）；组合结束后以最终文本为准。demo 的 200ms 防抖未移植。
5. 匹配的是 Markdown 源：查 `**` 会命中带加粗的消息，查渲染后才相邻的文字（跨标记）会漏（规格如此）。
6. `（已停止生成）`、错误文案等不在 `content` 里的可见文本搜不到（规格如此）。
7. `type="search"` 的输入框在 Chromium 里有原生的清空按钮（输入框内的 ×），与搜索框右端的 `关闭` 相邻：前者清空查询（计数回到 `0/0`），后者关闭搜索框。这是 `Input variant="search"` 基元的既有外观，未改基元。
8. ≤760px 时 `.chat-thread` 左右内边距为 0，高亮的 6px 外扩在左右两侧被转录区裁掉；高亮仍清楚可辨。
9. **既有问题，非本刀引入**：1440px 下打开一个长会话，转录区停在距底 56px（顶栏高度）且不处于贴底状态；此时打开搜索框，转录保持位置（未贴底的既有规则）而不是跟到底部。基线构建同样如此，390px 不出现。已另建 issue 跟踪，本刀不处理。
10. 点 `回到最新` 后搜索高亮不变、焦点落在 `body`（该按钮点击后卸载的既有行为）。

## Seams under test
- `fetch` mock 与 `FakeEventSource`（既有 support）：证明「不发请求」与流式路径。
- 滚动度量 mock + `scrollIntoView` stub：jsdom 无布局、无 `scrollIntoView`、不派发 scroll 事件。它们证明的是「调用了谁、调用后贴底状态如何」，不证明真实几何——那部分由「真实浏览器观察」1、5 覆盖。
- 输入法：jsdom 用带 `isComposing`/`keyCode` 的合成 `keydown`；真实输入法未在浏览器里驱动。
