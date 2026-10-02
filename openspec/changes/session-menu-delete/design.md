# Design: session-menu-delete（#532）

## 基线（master 31615cb）
- `session-menu.tsx`（43 行）：`Menu` 两项；`MenuItem` 支持 `danger`（`web/src/ui/menu.tsx:5-10`、`:32` 的 `ui-menu-item--danger`）。`trash`、`triangle-alert` 图标已注册（`web/src/ui/icon.tsx:78`、`:91`）。
- `session-actions.ts`（196 行）：`useSessionActions(client, setListState, setHistoryState)`；fence = 已挂载、未 abort、`client === clientRef.current`（`:107-111`，另加同类请求的序号）；卸载时 abort `controllersRef` 里的全部请求（`:54-62`）。
- `page.tsx` **672 行**（本刀上限 682）。`useSessionActions` 在 `:71` 调用，早于 `closeSource`（`:90-94`）与 `refreshList`（`:143-181`）的定义。`requestedSessionId` 的 effect（`:376-425`）在它变为 null 时 `abortHistory()`、`closeSource()`、把历史置 `idle`、清 `streamError`（`:397-404`），并清理本 client 的在途 create/send（`:388-396`）。以 replace 移除 `?session=` 的先例：初始 GET 404（`:316-322`）。
- `deleteSession(id, options?)`（`web/src/lib/api-sessions.ts:138-151`）：不带 body 与 `Content-Type`；恰 204 为成功，其它 2xx 抛 `requestFailed`，非 2xx 抛信封 `ApiError`（401 先走 `onUnauthorized`）。
- `ConfirmDialog`（`web/src/ui/confirm-dialog.tsx`）：`role="alertdialog"`、无右上关闭、遮罩不关闭、Escape = 取消；`pending` 时确认按钮 `loading`（禁用 + `aria-busy`），取消按钮与 Escape 仍可用；`cancelText`、`children`、`returnFocus` 可传。请求中的先例：`web/src/features/auth/footer.tsx:88-105`（`cancelText={pending ? "关闭" : "取消"}` + 提示行）。
- 服务端（父 design D3）：DELETE 对 running 会话先停止再删，最长约 16 s；占用被 regenerate/fork/stop/另一 DELETE 持有时 409 `session_busy`（文案 `会话正在生成，请稍候`，`server/src/core/errors/index.ts:11`）；删除过程中该会话的事件流连接被服务端 `raw.end()` 结束、不写事件。
- 层级：Menu 1600、Dialog 1400 高于导航 Drawer 1360；本刀不用 `Popover`，不受 #715 影响。shell 的导航覆盖层不随程序化 `navigate()` 关闭（`web/src/routes/shell/app-shell.tsx:18-30`，只有导航项、选择会话与 `新建会话` 经 `onNavigate` 关闭它）。

## Governing invariant
列表里的条目只因两件事消失：一次列表读取的整表替换，或属于当前 client 的 `DELETE` 得到 204。删除不做乐观更新；对每个 (client, 会话) 同一时刻至多一个在途 `DELETE`。「是否为当前选中会话」在响应到达时读取，页面收尾（关闭事件流 → replace 移除 `?session=`）只在那一刻它确是当前会话时发生。不属于当前 client 或页面已卸载时到达的响应一律丢弃。

## Sibling surfaces
- `requestedSessionId` 的 effect（`page.tsx:376-425`）：replace 之后由它完成其余收尾（abort 历史读取、历史置 `idle`、清 `streamError`、清在途 create/send）。本刀不改它，也不在 hook 里重复这些步骤。
- `page.tsx:582-604`（事件流把当前会话 `status` 同步进 `listState`）：条目移除后 `find` 不到即原样返回，不会把条目加回来。
- `refreshList`（`page.tsx:143-181`，整表替换）及其调用点 `page.tsx:192`、`:503`、`turn-actions.ts:196`、`:337`、`:387`：在 DELETE 之前发出、晚于 204 到达的读取会把条目带回来（已知残留 2）。
- `selectedSession()`（`session-path.ts`）：条目移除后、replace 生效前的那一次渲染里回退到快照会话，顶栏仍显示标题；effect 把历史置 `idle` 后进入欢迎态。
- 7.2a 的重命名/置顶（同一 hook）：被删会话的在途 PATCH 响应到达时 `merge` 找不到条目，不会加回来；其 Toast 照常出现（已知残留 4）。
- `turn-actions.ts` 的在途操作（发送、停止、重新生成、fork）：replace 之后它们的 `requestedSessionRef` 检查失败而丢弃结果，既有行为。
- 两个呈现面：`≥761px` 文档流侧栏与 `≤760px` 导航 Drawer。
- 8.2b（ui-walk 走删除）；`server/src/sessions/session-delete.ts`：本刀只消费。

## 决定

### D1 状态归 `useSessionActions`，确认框挂页面主树
确认框由槽位节点里的菜单项打开，槽位节点随折叠与覆盖层关闭而卸载；确认框与请求状态必须活在 `ChatPage`。`useSessionActions` 持有状态，`ChatPage` 渲染 `<DeleteDialog remove={sessionActions.remove} />`；`remove` 为 null 时组件返回 null（判断在组件内，不在 `ChatPage` 里加分支）。

`page.tsx` 行计划（672 → 679，上限 682）：`:71` 的调用移到 `refreshList` 定义之后，改为
```ts
const sessionActions = useSessionActions(client, setListState, setHistoryState, {
  closeSource,
  refreshList,
  requestedSessionRef,
});
```
（+4）；`DeleteDialog` 的 import（+1）；侧栏 `onDeleteSession={sessionActions.openDelete}`（+1）；`<DeleteDialog …/>`（+1）。hook 调用下移只改变 hook 的调用次序，不改变行为（`sessionActions` 的第一个使用点在 `:619`）。

### D2 `session-actions.ts`
第四个参数 `page: { closeSource(): void; refreshList(client: ApiClient): void; requestedSessionRef: RefObject<string | null> }`。导航在 hook 内完成：`useNavigate()` + `useLocation()`，location 经 ref 取最近一次渲染的值（响应到达时的 URL，而不是确认那一刻的闭包）。

新增状态：
- 打开的确认框 `{ client, sessionId, title }`（`title` 是打开那一刻的显示标题，`sessionTitle(session)`）；`returnFocus` 用独立的 ref，不与重命名共用。
- 在途标记：属于某个 client 的会话 id 集合（React state，供确认按钮渲染忙碌）。client 变了即视为空，旧 client 的标记不带到新 client（两个账号可以有相同的 id——测试夹具就是这样）。

接口：
- `openDelete(session, trigger)`：记录 `returnFocus` 并打开该会话的确认框。
- `remove`：`{ title, pending, returnFocus, onConfirm, onCancel } | null`；确认框不属于当前 client 时为 null（同 `rename`）。`pending` = 该会话在当前 client 的在途标记里。
- `onConfirm`：`pending` 时不做任何事；否则登记在途标记并发出 `client.deleteSession(sessionId, { signal })`。`onCancel`：关闭确认框，不动在途请求。

响应处理（fence 与 PATCH 相同：已挂载、未 abort、`client === clientRef.current`；fence 逻辑与 `send` 共用一处，不复制——jscpd）：
- 通过 fence 的任何结果先清掉该会话的在途标记。
- 204：`setListState` 在 `status === "success"` 且属于该 client 时按 id 滤掉条目；确认框与重命名 Dialog 若是为这个会话打开的则关闭（为别的会话打开的不动）；Toast `{type:"success", message:"任务已删除"}`；若 `page.requestedSessionRef.current === sessionId`：`page.closeSource()`，随后 `navigate(sessionNavigation(pathname, search, hash, null), { replace: true })`。成功不调用 `refreshList`。
- 401：只清在途标记（既有的未授权通知接管）。
- 其它失败：确认框若是为这个会话打开的则关闭；Toast `{type:"error", message: errorMessage(error)}`；`page.refreshList(client)`。
- 未通过 fence：什么都不做。

先 `closeSource()` 再 `navigate`：服务端在返回 204 之前已经结束了这条连接，浏览器会按重连间隔自动重连并得到 404；显式关闭让重连在 204 处理的同一同步段里停掉，而不是等 effect。history 置 `idle`、清 `streamError` 留给既有 effect。

### D3 `delete-dialog.tsx`
`DeleteDialog({ remove })`：`remove` 为 null 返回 null；否则渲染恒 `open` 的 `ConfirmDialog`（卸载即关闭，与 `RenameDialog` 相同的挂载方式）：`title="删除任务"`、`description={`确定要删除「${title}」吗？删除后不可恢复。`}`、`confirmText="删除"`、`danger`、`pending`、`cancelText={pending ? "关闭" : "取消"}`、`returnFocus`、`onConfirm`、`onOpenChange(open)` 在 `!open` 时调 `onCancel`；`pending` 时 children 为 `<p className="ui-muted">删除请求已发送，关闭窗口不会撤销请求。</p>`。不新增 CSS。

### D4 `session-menu.tsx` 与 `session-sidebar.tsx`
`SessionMenu` 加 prop `onDelete(trigger)`，第三项 `{ label: "删除", icon: "trash", danger: true, onSelect: () => onDelete(triggerRef.current) }`。`SessionSidebar` 加 prop `onDeleteSession(session, trigger)`，与 `onRenameSession` 同样透传到 `SessionEntries`。条目行的 DOM（两个同级按钮）不变。

## Must-preserve
1. 7.2a 的全部行为：`重命名`、`置顶任务`|`取消置顶`、顶栏 `重命名`、PATCH 的 fence 与合并规则（既有 M1–M16 套件除 proposal「偏差」2 的三处断言外零 diff 全绿）。
2. `li.chat-session-item` 仍恰有两个同级按钮；`button.chat-session-button` 的标记、`aria-current`、accessible name 不变（`ui-walk-layout.ts`、`ui-walk-stop.ts`、`ui-shots.mjs` 的钩子）。
3. `/api/sessions`、`/api/workspaces` 的请求次数与时机不变；只有删除失败多触发一次 `refreshList`。删除成功不发任何读取请求。
4. `requestedSessionId` 的 effect、`stream.ts`、`api-sessions.ts`、`web/src/ui/**`、`chat.css` 零 diff。
5. `「更多」按钮与菜单项不关闭导航覆盖层`（主规格既有句）对 `删除` 同样成立。

## Required evidence
新建 `web/test/chat-page-session-delete.test.tsx`（首行引入 `./radix-platform.js`；复用 `chat-page-session-meta-support.tsx` 的 `mountSessions`、`mountTwoAccounts`、`openEntryMenu`、`chooseEntryAction`、`toasts` 等；DELETE 专用的查询与请求断言写在新文件里，既有 support 模块不增行；夹具与查询落 `chat-page-session-delete-support.tsx`——两者合计超过 800 行）。`DELETE` 与 `PATCH` 同路径，`createFetchMock` 只按路径路由，方法从 `options.method` 断言。确认框以 `role="alertdialog"`、name `删除任务` 定位，框内的 `删除` 用 `within()`（与菜单项同名）。全部 RED，除注明者。
- R1 菜单三项：未置顶、已置顶、`running`、`title: null` 四种会话的菜单 `menuitem` 文本恰为 `重命名`、`置顶任务`|`取消置顶`、`删除`；`删除` 项带 `ui-menu-item--danger`、图标类含 `lucide-trash`、无 `aria-disabled`/`data-disabled`；无 `导出记录`。
- R2 确认框与取消：选择 `删除` → `alertdialog` name `删除任务`，说明文本恰为 `确定要删除「<标题>」吗？删除后不可恢复。`（`title: null` 的会话为 `「新会话」`），按钮恰为 `取消`、`删除`，`删除` 是 danger 变体且可用，无 `删除请求已发送` 提示；点 `取消` → 确认框消失、没有 `DELETE`、焦点回到该条目的「更多」按钮、列表不变；另一例按 Escape 结果相同。
- R3 删除当前且 `running` 的会话（Scenario 第一组）：挂载 `/?from=keep&session=<A>#hash`，A 为 `running` 且事件流已连接；确认 → 恰一次发往 `/api/sessions/<A>` 的请求，`method` 为 `DELETE`、无 `body`、无 `Content-Type`。DELETE 挂起期间：确认按钮 `disabled` 且 `aria-busy="true"`、取消按钮文案为 `关闭`、提示 `删除请求已发送，关闭窗口不会撤销请求。` 可见；条目仍在列表、URL 不变、事件流未关闭、没有 Toast。204 → 确认框消失；A 的条目消失、其余条目次序不变；Toast 恰为 `任务已删除`；location 恰为 `/?from=keep#hash` 且 `history.length` 与删除前相同（replace，不是 push）；关闭先于导航：A 的 `FakeEventSource` 的 `close()` 被调用的那一刻 location 仍含 `session=<A>`（spy `close`，在调用时读取 location）；hero heading `WorkBuddy，我帮你` 可见；页面内没有 `role="alert"`；A 的 `FakeEventSource` `readyState` 为 CLOSED 且之后没有新建 EventSource；204 之后 `/api/sessions/<A>/messages` 与 `/api/sessions` 的请求数不再增加。
- R4 删除非当前会话（第二组）：`/?session=<A>` 下删除 B → B 的条目消失、Toast `任务已删除`；location 仍为 `/?session=<A>`、顶栏 heading 仍为 `我的工作 / <A 标题>`、A 的会话内容仍在、A 的事件流未关闭。另一例欢迎态（`/`）下删除 → 条目消失、location 仍为 `/`、hero 仍在。
- R5 `done` 会话为当前会话时删除：同 R3 的 204 结果（回欢迎态、事件流关闭、replace）。
- R6 失败（第三组）：DELETE 返回 409 信封 `{code:"session_busy", message:"会话正在生成，请稍候"}` → 确认框消失、焦点回到「更多」按钮、Toast 恰为该 message；`/api/sessions` 多一次读取且列表显示这次读取的结果（第二次读取返回不同的标题以证明装入）；条目仍在、location 不变、事件流未关闭。非信封失败（500 非 JSON）→ Toast `请求失败，请稍后重试`，同样重读列表。失败后可以再次打开同一会话的 `删除`，确认按钮可用（在途标记已清），再次确认发出第二个 `DELETE`。
- R7 200 不算成功：DELETE 返回 200 → Toast `请求失败，请稍后重试`、列表重读、条目仍在、location 不变。
- R8 请求中关闭与重开（Scenario「删除请求中」第一组）：DELETE 挂起 → 点 `关闭` → 确认框消失、焦点回到「更多」按钮；再从菜单选 `删除` → 确认按钮仍 `disabled` 且 `aria-busy`、取消按钮为 `关闭`、提示可见；全程恰一个 `DELETE`；204 → 重开的确认框消失、条目消失、Toast `任务已删除`。另一例：关闭后不重开，409 到达 → Toast 该 message、列表重读、没有确认框。跨会话：A 的 DELETE 挂起 → 关闭 → 打开 B 的 `删除`（确认按钮可用、取消按钮为 `取消`、无提示）→ A 的 204 到达 → B 的确认框仍在且仍可用、A 的条目消失；镜像：A 的 409 到达 → B 的确认框仍在。
- R9 响应到达时判定当前会话（第二组）：当前为 A，A 的 DELETE 挂起 → 关闭确认框 → 选择 B（location `/?session=<B>`）→ 204 → A 的条目消失、Toast；location 仍为 `/?session=<B>`、B 的事件流未关闭、B 的内容仍在。镜像：当前为 B，A 的 DELETE 挂起 → 关闭 → 选择 A → 204 → location `/`（replace）、hero 可见、A 的事件流已关闭。
- R10 fence：两个账号各有一条 id 同为 A 的会话，挂载在 `/?session=<A>`（`mountTwoAccounts` 写死 `/`，没有当前会话时观察不到「不导航」；新文件自带这个挂载，写法同它）；A 的 DELETE 挂起时续期为另一 client → 旧 204 到达：没有 Toast、新账号的列表仍含 `乙的任务`、location 仍为 `/?session=<A>`、新 client 为 A 打开的事件流未关闭；另一例旧 409 到达：没有 Toast、`/api/sessions` 请求数不因它增加。续期后在新 client 上打开 A 的 `删除`：确认按钮可用（旧 client 的在途标记不沿用），确认后成功。DELETE 挂起时离开会话页（`leaveChatPage`）→ 响应到达不抛错、没有 Toast、没有 React 警告、location 仍为 `/center`。
- R11 401：DELETE 返回 401 → 没有错误 Toast、`/api/sessions` 请求数不因它增加。
- R12 重命名 Dialog 随删除关闭：A 的 DELETE 挂起 → 关闭确认框 → 打开 A 的 `重命名` → 204 → `重命名任务` Dialog 消失。另一例此时打开的是 B 的 `重命名` → 204 后它仍在。
- R13 `≤760px` 覆盖层：`导航` 内条目 `更多操作` → `删除` → 确认框出现且 `导航` 元素仍在 DOM；Escape → 只关确认框、没有 `DELETE`、`导航` 仍是同一元素、焦点回到该条目的「更多」按钮；再次 `删除` 并确认（当前会话）→ 204 后 `导航` 仍是同一元素、条目消失、location 不含 `?session=`。（确认框打开期间 Drawer 被标为 `aria-hidden`，按元素「仍在 DOM 中」断言，同 7.2a M14。）

既有断言更新（非 RED 新增，随实现改为三项）：`chat-page-session-rename-pin.test.tsx:138-148` 与 `:99` 的用例标题、`chat-page-session-pin.test.tsx:97`、`:119-122`（多行数组加一项会多一行，改写成不增行的形式）。

实现记录：R6 的 409 信封、500 非信封与「失败后可再次确认」合在一个用例里；「location 取响应到达时的值」没有可区分的用例（会话切换不改变其它 search/hash，确认时与响应时算出的目标 URL 相同）。一次性真实浏览器观察两种视口全部符合，详见 PR。

实现前后各跑一次并记录：RED 集合 = R1–R13；既有套件实现前后皆绿（实现后以更新过的三处断言计）。

一次性真实浏览器观察（不入库，写进 PR）：1440×900 与 390×844 各做一次「行菜单 → 删除 → 取消」与「删除当前会话 → 欢迎态」，记录菜单第三项的 danger 样式、确认框可见可点（`elementFromPoint`）、长标题下确认框说明不溢出、删除后 URL 与 hero。

## 已知残留
1. 删除成功后打开确认框的「更多」按钮已随条目卸载，归还的焦点落到 `body`；不把焦点移到别处（规格未要求，同 7.2a 残留 1）。
2. DELETE 之前发出、晚于 204 到达的列表读取会把条目带回来，直到下一次列表读取；点它得到既有的 404 → replace 回欢迎态。不为此在读取路径上加「已删除」过滤层（同 7.2a 残留 2）。
3. running 会话的删除过程中，服务端先结束本标签页的事件流连接、之后才返回 204；若 204 晚于浏览器的自动重连（缺省约 3 s）到达，重连得到 404，页面会在 204 之前短暂显示既有的连接失败提示（`stream.ts` `fail(CONNECTION_FAILURE)`），204 后随回到欢迎态消失。正常情况下两者相差只是一次删除事务的时间。jsdom 无法复现，留给 8.2b 的真实浏览器走查观察。
4. 被删会话的在途重命名/置顶响应到达时不改列表，但 `已重命名`/`已更新置顶状态` 或失败 Toast 照常出现。
5. DELETE 得到 404（会话已在别处删除）按一般失败处理：Toast 信封 message 并重读列表；若它是当前会话，页面停在该 URL，直到用户离开（其它标签页删除后的既有状态，父 design D3 不为此新增 UI）。
6. `≤760px` 覆盖层内删除当前会话后覆盖层不自动关闭（程序化导航不关闭它）；用户看到的是少了一条的列表。
7. 当前会话的删除在途时点 `新建会话`：204 的 replace 先于创建响应到达时，既有 effect（`page.tsx:388-396`）中止这次创建；服务端可能已建出空会话，下一次列表读取才出现（「创建在途时离开」的既有行为）。

## Seams under test
- jsdom 页面 fixture（`renderChatPage` / `renderChatPageWithAuthProbe` + `createFetchMock` + `FakeEventSource`）：菜单、确认框、Toast、列表、URL 与事件流连接的联动，请求方法与次数，时序（挂起、关闭重开、切换会话、续期、卸载），覆盖层。
- CI `ui-walk`：既有走查对条目钩子的回归门。
