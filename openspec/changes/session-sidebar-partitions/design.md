# Design: session-sidebar-partitions（#530）

## 基线（master 1b27c7e）
- `web/src/features/chat/session-nav.tsx`（108 行）：`nav[aria-label="会话列表"].chat-session-nav` → `Button.chat-new-session` → 错误 `role="alert"` / `正在读取会话` → 单个 `<ul class="chat-session-list">`。
- `page.tsx` **659 行**（本刀预算上限 669）。`refreshList`（`page.tsx:135-172`）只调 `listSessions`；会话页不读 `/api/workspaces`。
- 槽位节点会被卸载：折叠态不渲染列表区（`routes/shell/sidebar.tsx` `{collapsed ? null : <SidebarListArea …/>}`），`≤760px` 覆盖层每次选择/新建后关闭、列表不在 DOM。
- `SegmentedControl`（`web/src/ui/segmented-control.tsx`）= Radix RadioGroup：`role="radiogroup"` + `aria-label`、项 `role="radio"` + `aria-checked`、方向键切换。
- `Popover`（`web/src/ui/popover.tsx`）非模态、portal 到 `body`；Drawer 的 `useEscapeFallback` 只认 DOM 子树内的 Escape（`web/src/ui/escape-fallback.ts`），portal 在外的弹层不触发它。

## Governing invariant
筛选后的每个会话恰在一个分区或子组里出现一次：置顶、任务与各空间子组的条目数之和恒等于筛选后的会话数；分区内顺序即服务端顺序；被 jsdom 与 ui-walk 依赖的既有 DOM 钩子（Must-preserve 1–5）不变。计算端（`session-groups.ts`）与呈现端（`session-sidebar.tsx`）只有这一份实现，旧的 `session-nav.tsx` 同刀删除。

## Sibling surfaces
- `server/src/sessions/store.ts:295`：列表顺序（`updated_at DESC, id ASC`）的生产端；web 不重排。
- `page.tsx:573-595`（事件流把当前会话的 `status` 同步进 `listState`）：只改 `status`、不改 `updatedAt`，所以当前会话会实时跨 `进行中`/`已完成`，但不会跨 `今天`/`更早`（等下一次 `refreshList`）。
- `refreshList` 的全部调用点——`page.tsx:183`、`:494`，`turn-actions.ts:196`、`:337`、`:387`：每处现在都多发一个 `GET /api/workspaces`。
- `web/src/features/files/page.tsx:228`：另一个 `listWorkspaces` 消费方，共用客户端的解析与 401 通知；本刀不动它。
- 7.3（composer footer）与 7.5a（文件变更卡）：`useWorkspaceList` 的后续消费者。
- 两个呈现面：`≥761px` 文档流侧栏与 `≤760px` 导航 Drawer（同一槽位节点）。
- `docs/acceptance/demo-parity-checklist.md:180-181`：引用 `session-nav.tsx` 行号的签收文档（proposal「Non-goals」）。

## 决定

### D1 状态归会话页，不归槽位节点
筛选值与工作空间列表都由 `ChatPage` 持有、经 props 传给 `SessionSidebar`。放在侧栏组件内会在折叠或覆盖层关闭时丢失，直接违反「切换会话保留」（手机上每次选会话都会关覆盖层）。`Popover` 的开合是唯一留在槽位节点内的状态（卸载即关闭，符合预期）。

`page.tsx` 行计划（659 → 666，上限 669）：
| 改动 | 行 |
|---|---|
| `import { SessionNav }` → `import { SessionSidebar }`；`session-path` 导入去掉 `sessionTitle` | 0 |
| `import { DEFAULT_SESSION_FILTER } from "./session-groups.js"` | +1 |
| `import { useWorkspaceList } from "./workspace-list.js"` | +1 |
| `const [sessionFilter, setSessionFilter] = useState(DEFAULT_SESSION_FILTER)` | +1 |
| `const { refresh: refreshWorkspaces, workspaces } = useWorkspaceList(client)` | +1 |
| `refreshList` 内 `refreshWorkspaces(ownedClient)`（在 client 归属检查之后；依赖数组加一项） | +1 |
| 槽位 props：`filter`、`onFilterChange`、`workspaces` | +3 |
| 槽位 props：去掉 `sessionTitle`（侧栏自己从 `session-path.js` 导入） | −1 |
实际行数以格式化后为准，PR 记录基线 659 与合入后行数。`types.ts`、`lib/api.ts`、`turn-actions.ts`、`stream.ts`、`session-contract.ts` 零 diff。

### D2 纯函数 `session-groups.ts`
- `SessionFilter = { status: "all" | "running" | "finished"; time: "all" | "today" | "earlier" }`，`DEFAULT_SESSION_FILTER = { status: "all", time: "all" }`。
- `filterSessions(sessions, filter, now)`：`now` 为注入的毫秒时间戳，函数内不读时钟。`running` → `status === "running"`；`finished` → `done|failed|stopped`；`today` → `updatedAt` 与 `now` 的本地年/月/日（`Date` 的 `getFullYear/getMonth/getDate`）全等；`earlier` → 其余（含 `updatedAt` 落在 `now` 之后的日历日）。保持输入顺序，不改输入。
- `groupSessions(sessions, workspaces)`：`workspaces` 为 `readonly { id: string; name: string }[] | null`（结构化类型，不从 `lib/api.ts` 或 `features/files` 导入）。单次顺序遍历：`pinnedAt !== null` → 置顶；否则 `workspaceId !== null` → 空间子组（列表里有该 id → 该空间的子组；否则 → 未知子组）；否则 → 任务。输出 `{ pinned, tasks, spaces }`，`spaces` 为 `{ key, name, sessions }[]`：按 `workspaces` 顺序、只含非空子组，未知子组（`name: "未知空间"`，`key` 取不可能与 32 位十六进制 id 相撞的固定串）排最后。子组以 id 为键——同名空间是两个子组。
- 计数由调用方取长度（`空间` = 各子组长度之和）；不变量：三处条目总数恒等于输入长度。

### D3 `workspace-list.ts`：`useWorkspaceList(client)` → `{ workspaces, refresh }`
- 内部 state `{ client, workspaces: readonly Workspace[] | null }`；返回的 `workspaces` 在 `state.client !== client` 时为 `null`（换账号后的首帧不露出上一账号的空间名）。`Workspace` 类型取 `Awaited<ReturnType<ApiClient["listWorkspaces"]>>["workspaces"][number]`。
- `refresh(ownedClient)`（`useCallback`，引用稳定）：`ownedClient` 不是当前 client → 返回；abort 上一次请求；代际 +1；**不**把 state 置回 `null`（同一 client 重新读取期间沿用上次成功结果；client 变了则置 `{ client: ownedClient, workspaces: null }`）；`listWorkspaces({ signal })`：成功且未 abort、代际与 client 均未变 → 写入列表；失败同样检查后，非 401 → `workspaces: null`（401 由客户端既有通知机制处理，这里忽略）。
- 卸载时 abort 并使代际失效。不与 `listSessions` 共用 `Promise.all`：两个请求互不等待，会话列表到达即渲染。
- 只暴露本刀用到的两项；读取中/失败的状态与信封 message 由 7.3 在本文件内扩展（不动 `page.tsx` 的调用形状）。

### D4 `session-sidebar.tsx`
```
nav[aria-label="会话列表"].chat-session-nav
  div.chat-session-toolbar
    Button.chat-new-session（primary，「新建会话」，点击后 onNavigate）
    <SessionFilter/>（「筛选任务」，不调用 onNavigate）
  p.ui-alert[role="alert"]                      ← listError
  p.chat-session-loading[role="status"]         ← 「正在读取会话」
  p.chat-session-empty「没有匹配的任务」          ← sessions 已读取且筛选后为空
  div.chat-session-groups                        ← 唯一滚动容器；筛选后非空时渲染
    div[role="group"][aria-labelledby]  置顶任务 → ul.chat-session-list
    div[role="group"][aria-labelledby]  任务 (n) → ul.chat-session-list
    div[role="group"][aria-labelledby]  空间 (n)
      div[role="group"][aria-labelledby]  <空间名>|未知空间 → ul.chat-session-list
```
- 条目结构与 `session-nav.tsx` 的 `SessionEntries` 逐字相同（`li.chat-session-item` > `button.chat-session-button`、`aria-current`、`aria-label` 为标题、`role="status"` 状态元素与 `SESSION_STATUS_LABEL`/`ui-pulse`），留在本文件内（`chat-composer.test.tsx:202` 读本文件源码断言这三处）。
- 分区/子组的 accessible name 来自可见标签元素（`aria-labelledby`，id 用 `useId`），所以名称恰为 `置顶任务`、`任务 (2)`、`空间 (2)`、空间名。
- 渲染时 `filterSessions(sessions, filter, Date.now())` 再 `groupSessions(…)`；不 memo、不设定时器。
- props：`listError`、`listLoading`、`sessions`、`requestedSessionId`、`onCreateSession`、`onSelectSession`、`filter`、`onFilterChange`、`workspaces`。

### D5 `session-filter.tsx`
`Popover`（非受控，`contentLabel="筛选任务"`），trigger 为 ghost 图标 `Button`（`aria-label="筛选任务"`、`title="筛选任务"`（demo:1787 的 title）、`Icon filter`）。content：可见小标题 `状态` + `SegmentedControl label="状态"`（`全部`/`进行中`/`已完成`），可见小标题 `时间` + `SegmentedControl label="时间"`（`全部时间`/`今天`/`更早`）；`onValueChange` 直接回调 `onChange({ ...value, status|time })`，不关闭弹层。本文件不写键盘、焦点或关闭处理代码，全部来自两个基元。不套 `Tooltip`（`Popover` 的 trigger 必须是能接 ref 的单一元素，基元 `Tooltip` 不转发）。

### D6 样式（`chat.css`）
`.chat-session-nav` 规则不动（仍无 `overflow`）。`.chat-session-list` 去掉 `flex: 1`/`min-height`/`overflow-*`，这三项与覆盖层的 `flex: none` 规则移到 `.chat-session-groups`。新增 `.chat-session-toolbar`（一行：`新建会话` 占满余宽、筛选按钮不收缩；`.chat-new-session` 的 `width: 100%` 改为 `flex: 1; min-width: 0`）、分区标签（demo:275 `.sidebar-section-label`：11px、次要文字色）、子组标签左缩进 8px（demo:1889）、`.chat-session-empty`。只用既有 token。

### D7 既有测试的改动（封闭清单）
- `web/test/chat-composer.test.tsx:202`：源文件路径 → `session-sidebar.tsx`。
- `web/test/chat-page-support.tsx` `authenticatedChatRoutes`、`web/test/chat-page-lifecycle-support.tsx` `authenticatedChatLifecycleRoutes`：各一行默认 `"/api/workspaces": () => jsonResponse({ workspaces: [] })`（写在 `...routes` 之前，用例可覆盖）。
- 其它自建 `createFetchMock` 且挂载会话页、尚无该映射的文件各一行。不用 `allowWorkspaceListFetch()`（它同时把 `/api/sessions` 改成空列表，`support.ts:102-110`）。
- 断言精确 fetch 调用序列/次数的既有用例只改期望值。
- `web/test/chat-page-ownership-gaps.test.tsx:36-41` 的 `listTitles`：现在取 `nav` 内所有带 `aria-label` 的 button，`筛选任务`（以及 7.2a 的 `更多操作：…`）会混进标题列表；选择器收窄为 `button.chat-session-button`（改调用形状，不增长），`:337`、`:374` 的期望值不变。
- 新页面测试自带视口/覆盖层 helper（`app-shell-responsive.test.tsx:51-85` 的 `installViewport`/`mountShell`/`openNav` 是文件内函数，不导出、不改该文件）。
未映射的 `/api/workspaces` 不会让用例变红（mock 抛错 → 读取失败 → 静默归 `未知空间`），所以清单靠一次性插桩枚举：临时让 `fetchRouteHandler` 把未映射的 `/api/workspaces` 连同测试文件名记到文件，跑全量后逐个补映射，再撤掉插桩。

## Must-preserve
1. `nav[aria-label="会话列表"]` 恰一个，在 `aside[aria-label="侧栏"]` 内 `主导航` 之后、`footer` 之前，`main` 内没有；`新建会话` 在其内，`className` 恰为 `ui-btn ui-btn--primary ui-btn--md chat-new-session`（不加类、不改 variant/size；`chat-page.test.tsx:349-354` 钉住）（`sidebar.test.tsx:149-166`、`app-shell-responsive.test.tsx:341-373`、`web/e2e/ui-walk-layout.ts:272-296`）。
2. `button.chat-session-button`、选中项 `aria-current="true"`、条目按钮的 accessible name 为标题、状态元素 `role="status"` 名 `<标题> <状态文案>`（`ui-walk-layout.ts:310-320`、`ui-walk-stop.ts`、`ui-shots.mjs:287`）。
3. 加载文案 `正在读取会话`、列表读取失败的 `role="alert"`。
4. 选择会话与 `新建会话` 仍调用 `onNavigate`（覆盖层关闭并归还焦点）。
5. `.chat-session-nav` 规则不含 `overflow`；覆盖层内无嵌套滚动容器。
6. `/api/sessions` 的请求次数、时机与既有 fence 行为不变；工作空间请求的任何结果都不改 `listState`。

## Required evidence
`web/test/session-groups.test.ts`（纯函数，全部 RED：模块不存在）
- G1 「三分区互斥归属」：A–E 与空间顺序 W2、W1 → 置顶 `[A]`；任务 `[E, D]`；空间子组依次 `W2:[C]`、`W1:[B]`；三处条目总数 5，A 只出现一次。
- G2 未知空间：`workspaces` 为 `null` → 绑定会话全部在唯一的 `未知空间` 子组；列表不含某 `workspaceId` → 该会话在末位 `未知空间`，排在已知子组之后；列表里没有会话的空间不产生子组；同名的两个空间是两个子组。
- G3 「状态与时间交集」：今天 `running`/`done`/`idle` + 昨天 `failed`/`stopped`，四种选择依次得到 running；done、failed、stopped；done；failed、stopped。`idle` 在 `进行中`、`已完成` 下都不出现，在 `全部`×`全部时间` 与 `全部`×`今天` 下出现。
- G4 本地午夜边界（时间戳用本地时间构造器生成，与时区无关）：`now` 为某日 00:00:00.000 时，`updatedAt = now` 属今天、`now − 1` 属更早；`now` 为 23:59:59.999 时，同日 00:00:00.000 属今天；`updatedAt` 在 `now` 的次日属更早。
- G5 顺序与纯度：各分区、子组内保持输入顺序；输入数组与元素不被修改；空输入 → 三处皆空；置顶但被筛掉的会话不出现在任何分区。

`web/test/chat-page-sidebar.test.tsx`（页面；首行引入 `./radix-platform.js`；时间断言只伪造 `Date`）
- S1 （RED）三分区 DOM：`group` 名 `置顶任务`、`任务 (2)`、`空间 (2)`、其内子组 `W2`、`W1`，文档顺序 置顶任务 → 任务 → 空间；每个会话的选择按钮在整个列表区恰一个；无 `助理任务`；StrictMode 下结果相同。
- S2 （RED）`筛选任务` 打开弹层：`radiogroup` `状态`、`时间`，默认 `全部`、`全部时间` 为 `aria-checked="true"`；按 G3 的四步选择，列表区条目与计数随之变化、弹层始终打开；整个过程 fetch 调用数不变。
- S3 （RED）空态：账号无会话 → 列表区有 `没有匹配的任务`、无任何 `group`；有会话但 `进行中` 无匹配 → 同样只有该文本；按 Escape → 弹层消失、焦点在 `筛选任务`；URL 与主区当前会话的消息内容不变。
- S4 （RED）外点关闭：弹层打开后在弹层外按下指针 → 弹层消失，筛选值保持。
- S5 （RED）`/api/workspaces` 返回 500 → 会话条目照常渲染，绑定会话在 `空间 (1)` > `未知空间`；列表区没有 `role="alert"`。
- S6 （RED）互不等待与沿用：`/api/workspaces` 首次响应挂起 → 会话条目已渲染且绑定会话在 `未知空间`；响应到达 → 移入空间名子组；触发一次 `refreshList`（`新建会话`）且第二次工作空间响应挂起 → 仍在空间名子组；第二次以失败结束 → 回到 `未知空间`。
- S7 （RED）迟到响应：第一次工作空间响应晚于第二次到达 → 子组名以第二次为准。
- S8 （RED）`≤760px` 覆盖层：打开 `导航` → `筛选任务` → 选 `已完成` → `导航` dialog 仍在；Escape → 弹层消失、`导航` 仍在、焦点在 `筛选任务`；选一个会话（覆盖层关闭）→ 重新打开 → 列表仍只含已完成类会话，再开弹层 `已完成` 为选中。另：宽屏折叠再展开侧栏后筛选值保留。
- S9 （RED）筛选不动主区：当前选中会话被筛掉后，主区消息、顶栏标题与 `?session=` 不变；选择另一会话后筛选值保留。
- S10 （RED）不写 storage：筛选操作期间 `Storage.prototype.setItem` 未被调用。
- S11 （保持项，实现前后皆绿）既有钩子：Must-preserve 1–3 的断言（`nav` 位置与唯一性、`.chat-new-session`、`button.chat-session-button` + `aria-current`、`正在读取会话`、列表失败的 alert 且此时无 `没有匹配的任务`）。
- S12 （RED）静态：`web/src/features/chat/session-nav.tsx` 不存在；`web/src` 下没有 `session-nav.js` 导入与 `SessionNav` 标识符（类名 `chat-session-nav` 保留）。

实现前后各跑一次并记录：RED 集合 = G1–G5、S1–S10、S12；S11 实现前即绿。

一次性真实浏览器观察（不入库，结果写进 PR 与 #715）：390×844 打开导航覆盖层 → `筛选任务`，记录单选项是否可见、`document.elementFromPoint` 是否命中；1440×900 同一操作作对照。

## 已知残留
1. **`≤760px` 覆盖层内弹层被遮挡（#715）**：`.ui-popover` z-index 1300（`web/src/ui/popover.css:5`，ui-primitives「基元组件库」与 `ui-popover-tooltip.test.tsx:218` 钉住）低于 `.ui-drawer-overlay` 1350 / `.ui-drawer` 1360（`web/src/ui/dialog.css:90`、`:99`）。弹层 portal 到 `body`，所以在导航覆盖层内打开的筛选弹层画在遮罩之下。jsdom 不计算层叠，S8 看不到；8.2a/8.2b 不在 `mobile-dark` 打开筛选，ui-walk 也不会报。修法属 ui-primitives（改层级或给 `Popover` 加 `container`），不在本刀的文件边界内；`≥761px` 不受影响。
2. 页面跨过本地午夜且没有任何重渲染时，「今天」的归属到下一次渲染才更新。
3. 筛选生效时按钮没有提示态（规格与 demo 均无）。
4. Toast 在场时 `Popover` 的 Escape 可能被层栈吞掉（issue 643 只给 Dialog/Drawer 做了兜底）；既有基元行为，本刀不变。

## Seams under test
- 纯函数（G1–G5）：分区互斥、计数与日历日边界的全部边角，成本最低。
- jsdom 页面 fixture（`renderChatPage` + `createFetchMock`，同既有 `chat-page-*.test.tsx`）：DOM 语义、筛选交互、两个请求的时序、覆盖层与折叠下的状态保留。
- CI `ui-walk`：不改动的既有走查对 DOM 钩子的回归门。
