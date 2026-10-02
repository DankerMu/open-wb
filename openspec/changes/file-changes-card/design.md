# Design: file-changes-card（#535）

## Context
- `web/src/features/chat/stream.ts`（787 行）：`ChatStepView`（`:20-26`）无 `changes`；快照映射的步骤字面量（`:109-115`）；`startStep`（`:177-193`）、`endStep`（`:195-221`）是包着 `replaceAssistant` 的状态级函数；`replaceAssistant`（`:252-282`）对不存在的消息用 `emptyAssistant`（无步骤）试算，更新函数原样返回时返回原状态。
- `stream-approvals.ts`、`stream-thinking.ts`：新事件的解码与**消息级**归约拆到独立文件，`stream.ts` 只留接线。
- `web/src/lib/session-contract.ts:164-188`：`parseFileChange`/`parseFileChanges` 是快照步骤 `changes` 的元素规则（严格键集、`edit` 计数为非负安全整数、`write` 计数为 `null`、`path` 非空、1..50 项），目前不导出。`ChatFileChange` 类型不导出，经 `ChatStep["changes"]` 取。
- 服务端：`store.ts:322-324` 的步骤查询 `ORDER BY s.ordinal ASC, s.id ASC`，快照里步骤按 ordinal 升序；`step.start` 按到达顺序追加。所以**视图的步骤数组次序就是 ordinal 次序**，视图不需要带 `ordinal`。`events.ts:231` 把 `files.changed` 紧排在同一步骤的 `step.end` 之前；`step.end` 不带 `changes`。`turn-control.ts:270-273`：#522 之前 `files.changed` 不发布。
- `conversation-view.tsx`（262 行）`MessageArticle`：`.chat-msg-main` 内依次为折叠块、`ApprovalBars`、`.chat-md`、步骤卡、错误、`已停止` 徽章、`MessageActions`。
- `page.tsx:631`：`selected`（当前会话，列表项优先、就绪快照兜底）已算好，带 `workspaceId`；`workspaces` 来自 `useWorkspaceList`，按 client 归属门控，读取中与失败为 `null`。
- 图标按钮的既有写法：`message-actions.tsx:26-36`（`Button size="icon" variant="ghost"`，`aria-label` 与 `title` 同文）。
- `logicalPath(account, dir)`：`web/src/features/files/file-meta.ts:52`。`/files` 只认 `?ws=`（`web/src/features/files/page.tsx:268`）。
- demo：`resource/workbuddy-live-demo.html:519-526`（样式）、`:2468-2476`（结构）。

## Decisions

### D1 `stream-steps.ts`（挪出，不改行为）
```ts
export type ChatStepView = {
  id: ChatStep["id"]; name: ChatStep["name"]; detail: ChatStep["detail"];
  output: ChatStep["output"]; changes: ChatStep["changes"]; status: ChatStep["status"];
};
type WithSteps = { steps: ChatStepView[] };
export function startStep<M extends WithSteps>(message: M, data: { stepId: number; name: string; detail: string }): M
export function endStep<M extends WithSteps>(message: M, data: { stepId: number; status: "done" | "failed"; output: string }): M
/** 只替换 `stepId` 那一步；步骤不存在时原样返回 `message`（同一引用）。 */
export function updateStep<M extends WithSteps>(message: M, stepId: number, update: (step: ChatStepView) => ChatStepView): M
```
函数体就是 `stream.ts` 里现在传给 `replaceAssistant` 的那两个回调，原样搬过去：`startStep` 新建的步骤多一个 `changes: null`；`endStep` 重建的步骤多一个 `changes: current.changes`（`step.end` 不带变更，`files.changed` 先于它到达，丢了卡片就永远不出现）。`endStep` 里「按 id 找步骤、找不到原样返回、复制数组替换一项」这一段抽成 `updateStep`，`endStep` 与 D2 的 `setStepChanges` 共用（否则两处几乎逐字相同，jscpd 会多一个克隆）。`stream.ts` 里两支变成 `replaceAssistant(state, event.data.messageId, (m) => startStep(m, event.data))` 与对应的 `endStep`。`endTurn` 留在 `stream.ts`。

### D2 `stream-artifacts.ts`
```ts
type FileChanges = NonNullable<ChatStep["changes"]>;
export type ChatFilesEvent = { type: "files.changed"; data: { messageId: number; stepId: number; files: FileChanges } };

export function decodeFilesChanged(value: unknown): ChatFilesEvent | undefined
// hasExactlyKeys(value, ["messageId", "stepId", "files"])、两个 id 为安全整数、parseFileChanges(value.files) 非 null

export function setStepChanges<M extends { steps: ChatStepView[] }>(message: M, data: { stepId: number; files: FileChanges }): M {
  return updateStep(message, data.stepId, (step) => ({ ...step, changes: data.files }));
}

/** 已结束步骤的变更按路径汇总：位置取首次出现，值取数组中最靠后的步骤（步骤数组即 ordinal 次序）。 */
export function summarizeChanges(steps: readonly ChatStepView[]): FileChanges[number][] {
  const byPath = new Map<string, FileChanges[number]>();
  for (const step of steps) {
    if (step.status === "running") continue;
    for (const change of step.changes ?? []) byPath.set(change.path, change);
  }
  return [...byPath.values()];
}
```
`Map#set` 对已有键保留原插入位置、替换值，正好是「位置取首次、值取最后」。

`applyChatEvent` 的新一支：`replaceAssistant(state, messageId, (m) => setStepChanges(m, event.data))`，不传会话状态。三条边界都落在 `replaceAssistant` 的既有分支上，不另写代码：
- 步骤不存在 → `setStepChanges` 原样返回 → 返回原 `state`。
- 消息不存在 → 对 `emptyAssistant`（无步骤）试算，原样返回 → 命中 `next === source && current === undefined` → 返回原 `state`，不补建。
- 指向 user 消息 → 入口即返回原 `state`。

上一条助手已终态时到达的未知回合 `files.changed` 仍由页面的 `isUnknownTurn` 改走重同步（它读 `event.data.messageId`，不用改）。

### D3 `stream.ts` 的行数
最小接线（不挪函数）试排并经 Biome 格式化后是 804 行：步骤字面量 `{ id, name, detail, output: "", status: "running" }` 现在 97 列，加一个键就被展开成每键一行。按 D1 挪出后约 750 行。不采用「把 `endStep` 的字面量改成展开运算符」来省行：那是为过线而改写既有代码。

### D4 `file-changes-card.tsx`
`FileChangesCard({ steps, workspace }: { steps: readonly ChatStepView[]; workspace: Workspace | null })`：
- 先调两个 hook：`account = useAuth().principal?.account`、`navigate = useNavigate()`；**之后**才 `const changes = summarizeChanges(steps)`，空数组返回 `null`（不留空容器）。次序不能反：同一个已挂载的卡片会从空汇总变成非空（步骤结束时），提前返回放在 hook 之前会违反 Hooks 规则。
- 一个判定决定行的形态：`workspace !== null && account !== undefined` → 前缀 `logicalPath(account, workspace.dir) + "/"`，有 `查看详情`；否则无前缀、无按钮。它覆盖会话未绑定、空间不在列表里、列表读取中、列表读取失败四种情况（会话页只在已登录时渲染，`account` 的判空只是类型收窄）。
- 结构：外层 `role="group"`，accessible name 为卡头文本 `文件变更（N 个）`（类名 `file-changes-card`）；卡头 `file-changes-head`；每行 `file-change-row`，按序：`edit` 且 `added > 0` → `span.file-change-add` 文本 `+<added>`；`edit` 且 `removed > 0` → `span.file-change-del` 文本 `-<removed>`；`write` → `span.file-change-kind` 文本 `写入`；`span.file-change-path` 文本为显示路径（`title` 同文，省略号截断时可看全）；可解析时行尾 `Button size="icon" variant="ghost"`，`aria-label` 与 `title` 为 `查看详情 <逻辑路径>`，内含 `Icon chevron-right`，点击 `navigate(`/files?ws=${workspace.id}`)`。
- 行的 key 用 `path`（汇总后唯一）。任何地方都不读 `workspace.root`。
- 卡头不带图标（proposal 偏差 7）。
- 注释里不写 `#535`、`#522` 这类写法：`ui-guardrails.test.ts:46` 等颜色守卫按 `#` 加 3–8 位十六进制扫 features 下的 `.tsx`/`.css`，注释也算；写成「issue 535」。

### D5 接线
- `page.tsx`：`<ConversationView … workspace={workspaces?.find((item) => item.id === selected?.workspaceId) ?? null} />`，+1 行。找到的是列表里的同一个对象，列表不重读时引用稳定，`MessageArticle` 的 `memo` 不失效。
- `conversation-view.tsx`：`workspace` 经 `ConversationView` → `MessageThread` → `MessageArticle`；助手分支在 `{error}` 之后、`已停止` 徽章之前渲染 `<FileChangesCard steps={message.steps} workspace={workspace} />`。user 分支不渲染。

### D6 样式（`messages.css`，530 行）
按 demo:519-526，只用既有 token：卡片 `border: 1px solid var(--wb-border-default); border-radius: 12px; overflow: hidden; background: var(--wb-bg-secondary)`；卡头 `padding: 9px 12px; border-bottom; font-size: 13px; font-weight: 600`；行 `display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 12.5px; border-bottom`，末行无底边；`+n` 用 `--wb-status-success-text`、`-n` 用 `--wb-status-error-text`，等宽 11px；`写入` 用次要文字色、11px；路径 `flex: 1; min-width: 0; font-family: var(--wb-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。卡片与上下相邻块的间距随 `.chat-msg-main` 既有的块间距。不写 `transition`、`outline`、字面颜色。`chat.css` 不动。

### D7 既有测试的改动
只给整对象断言里的**步骤视图**字面量（不带 `ordinal` 的那些）加 `changes`（proposal 偏差 1）。快照步骤字面量已有该键，不动。

## Must-preserve
- 其它九类事件的解码、归约、游标过滤、队列与恢复；`step.start` 不重复建步骤、`step.end` 不编造步骤、`detail` 不被 `step.end` 改写。
- 步骤卡的呈现（`chat-steps.test.tsx`）；折叠块、审批条、错误、`已停止` 徽章、操作行的行为与相对次序；`复制` 只复制正文。
- `parseFileChanges` 的规则不变，只加 `export`。

## Required evidence（`web/test/chat-page-file-changes.test.tsx`）
连接器与归约用 `chat-stream-support.ts` 的 `connectChat`/`FakeEventSource`；页面级用 `chat-page-support.tsx` 的 `renderChatPage`，工作空间列表与账号的搭法见 `chat-page-welcome-scene-support.tsx`、`chat-page-sidebar.test.tsx`。

- C1 游标与次序（Scenario「思考与文件变更事件严格解码」）：快照游标 1:3；thinking.delta(1:3) 不交付；thinking.delta(1:4)、files.changed(1:5) 按到达顺序交付，后者为 `{type:"files.changed", data:{messageId, stepId, files}}`；未知类型 `foo.bar`(1:6) 不交付、不重同步。其中 thinking.delta 的两帧与 `foo.bar` 是实现前就成立的护栏，红的是 files.changed(1:5) 的交付。
- C2 严格解码（表驱动；每例：`loadSnapshot` 调用 +1、`onEvent` 未收到、无 `onError`）：`files` 为 `[]`、为对象、51 项；元素 `kind` 未知、缺 `kind`、多一个键、`path` 为空串或非字符串；`edit` 的计数为 `null`、负数、小数；`write` 的计数为数字；顶层缺 `files`、多一个键；`messageId` 或 `stepId` 不是安全整数。
- C3 归约（Scenario「思考与文件变更归约」）：冻结的 running assistant 依次应用 thinking.delta×2、step.start(5, write)、files.changed(5, `a.html`)、files.changed(5, `b.html`)、step.end(5) → `thinking` 为 `先想`；步骤 5 的 `changes` 在第二次 files.changed 后仅含 `b.html`，step.end 之后仍是它；正文与会话状态不变；user 消息保持同一引用；输入未被修改。另一例从 `done` 会话出发（步骤已存在）：应用 files.changed 后 `changes` 已替换且会话状态仍为 `done`——running 会话看不出「没改会话状态」。
- C4 同一引用（都从 `done` 会话出发，否则会话状态被改写时看不出来）：files.changed 指向不存在的步骤（99）、视图中不存在的 messageId（同时断言消息数不变）、user 消息 id → 三者都 `toBe(state)`（实现前走 `default` 分支也成立，是护栏）。挪文件的护栏（实现前后都绿，钉住 `startStep`/`endStep` 改成消息级之后的引用同一性）：重复的 step.start、指向不存在步骤的 step.end、指向不存在消息的 step.end（同时断言不补建消息）→ 三者都 `toBe(state)`。
- C5 视图形状：`chatStateFromSnapshot` 逐值带出步骤 `changes`（`null` 与数组各一）；step.start 新建的步骤 `changes` 为 `null`；`turn.start` 复位后步骤为空（后者是护栏）。
- C6 `summarizeChanges`：running 步骤不计；`done`、`failed`、`stopped` 步骤都计；同一路径取靠后步骤的值、位置取首次（`a`、`b`、再 `a` → 次序 `a`、`b`，`a` 的值是第三步的）；全无变更 → `[]`；输入不被修改。
- C7 事件到达顺序：step.start → files.changed → step.end 之后页面上该消息出现卡片；只到 files.changed 时没有（Scenario「仅在步骤结束后出现」）。断言 step.end 之前步骤卡已显示为运行中（证明事件已生效）。
- C8 `turn.end stopped` 时仍在 running 的步骤变为 `stopped`，其已收到的 `changes` 随之出卡。
- C9 内容与跳转（Scenario「卡片内容与跳转」）：账号 `zhangsan`，空间 `dir` 为 `proj`、`root` 为一个可辨识的绝对路径；快照两步骤的 `changes` 为 `src/app.ts`（+2 −1 edit）与 `out/index.html`（write）→ 名为 `文件变更（2 个）` 的 group；第一行文本含 `+2`、`-1`、`zhangsan/proj/src/app.ts`，第二行含 `写入`、`zhangsan/proj/out/index.html` 且没有 `+`/`-` 计数；页面 `innerHTML` 不含那个 `root`；步骤卡内没有 `.file-change-row`；最后点 `查看详情 zhangsan/proj/src/app.ts`，路由位置变为 `/files?ws=<该空间 id>`（客户端导航；`/api/workspaces` 的桩是可重复应答且包含该空间的函数路由，否则 files 页会改写 `?ws=`；绝对根的断言放在点击之前）。
- C10 去重（Scenario「同一消息多步骤同一路径」）：两步骤先后改 `a.md`（`+1`；`+4 −2`）→ `文件变更（1 个）`，行含 `+4`、`-2`，不含 `+1`。
- C11 不可解析（Scenario「空间不可解析」）：会话 `workspaceId` 不在列表里；会话 `workspaceId` 为 `null`；列表读取失败；列表读取中（响应挂起）→ 卡片仍在，行文本恰为相对路径，页面上没有名字以 `查看详情` 开头的按钮。列表随后读取成功 → 行变为逻辑路径并出现按钮。
- C12 计数：`edit` 的 `added: 0, removed: 3` → 只有 `-3`；`added: 0, removed: 0` → 该行没有 `.file-change-add`/`.file-change-del`；`write` → 只有 `写入`。
- C13 次序（Scenario「助手块次序」）：`stopped` 助手消息带 `thinking`、一条已结算审批、正文 `部分回答`、一个带 `changes` 的已结束 `write` 步骤 → `.chat-msg-main` 的**全部**子元素按序为 `details.thinking-block`、`div.chat-approvals`、`.chat-md`、步骤卡、文件变更卡、`助手消息 已停止` 徽章、操作行；`failed` 助手消息（错误文案只能经 SSE `error` 事件注入，快照映射的 `error` 恒为 `null`）→ 步骤卡、错误文案、文件变更卡、操作行这一段的次序；`复制` 的参数恰为正文。
- C14 其它面：user 消息（即使视图里带步骤）不渲染卡片；没有任何 `changes` 的消息不渲染卡片（这两条是护栏）；`role="group"` 的 accessible name 恰为卡头文本。
- C15 静态样式：`.file-change-path` 含 `text-overflow: ellipsis` 与 `min-width: 0`；`.file-change-add`/`.file-change-del` 用上述两个 token；`chat.css` 不含 `file-change`（护栏）。

基线运行：测试文件导入实现前不存在的 `stream-artifacts.js`，直接跑会在导入阶段整个失败。跑基线时在沙箱里临时放一个不导出任何东西的空壳 `stream-artifacts.ts`（不进补丁），让各用例逐例给出红绿；报告里逐条列出基线即绿的护栏。

变异自检（实现者在沙箱里做，做完还原，写进报告；每个至少打红一例）：去掉 `DATA_EVENTS` 的新条目；解码接受 `[]`；解码不查顶层键集；解码不用 `parseFileChanges`（放过未知 `kind`）；`endStep` 把 `changes` 置回 `null`；`startStep` 不设 `changes`；`setStepChanges` 追加而非替换；`setStepChanges` 对不存在的步骤造一个步骤；files.changed 一支传 `"running"` 作会话状态（由 C3 的 `done` 会话一例与 C4 打红）；快照映射不带 `changes`；`summarizeChanges` 计入 running 步骤；取首次的值而非最后的值；位置取最后而非首次；空汇总也渲染卡片；前缀用 `workspace.root`；不可解析时仍渲染 `查看详情`；导航到不带 `ws` 的 `/files`；卡片放到错误之前；卡片放到 `已停止` 徽章之后；`added: 0` 也显示 `+0`；user 消息也渲染卡片。

## 已知残留
1. #522 合入前服务端不发布 `files.changed`，流式路径只有本刀的 jsdom 证据；真实链路由 #522、8.1（`make smoke`）与 8.2a（ui-walk）承担。
2. `查看详情` 只到空间，不定位到文件（`/files` 没有路径参数，父规格明文）。
3. 页面级的挂载/推事件辅助函数在 `chat-thinking.test.tsx` 里是文件私有的，本刀的测试要另写；写法须与之不同到不触发 jscpd（178 不增），或抽进新的 support 文件只供本刀用。
4. 工作空间列表重读成功后列表项是新对象，所有助手消息会重渲染一次（`memo` 的 `workspace` 属性变了）。
5. 路径过长时截断显示省略号，全文在 `title` 与按钮名里；窄屏下看不到全路径。
6. 卡片的真实浏览器呈现由 8.2a 的 ui-walk 承担。

## Seams under test
- 纯函数：`chatStateFromSnapshot`、`applyChatEvent`、`summarizeChanges`。
- 连接器：`connectSessionEvents` + `FakeEventSource`。
- jsdom 页面 fixture：卡片的出现时机、内容、次序、导航、降级。
- 静态 CSS 文本。
