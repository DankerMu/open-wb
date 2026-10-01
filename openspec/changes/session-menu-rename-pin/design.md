# Design: session-menu-rename-pin（#531）

## 基线（master 34e2af5）
- `session-sidebar.tsx`（170 行）：`li.chat-session-item` 只含 `button.chat-session-button`；条目标记留在本文件（`chat-composer.test.tsx:202` 读源码）。
- `page.tsx` **666 行**（本刀上限 676）。`useTopbar({ breadcrumb: selectedSessionTitle(...) })` 在 `page.tsx:614-616`，是全页唯一的 `useTopbar` 调用（#529 的单调用方规则）。
- `patchSession(id, patch, options?)`（`web/src/lib/api-sessions.ts:114-136`）：空对象抛 `TypeError`；200 返回解析后的八键视图。服务端 PATCH 不改 `updated_at`/`status`（session-metadata「会话元数据修改」）。
- `Menu`（`web/src/ui/menu.tsx`）：`items: {label, onSelect, icon?}[]`，`modal={false}`，关闭后焦点回 trigger。`Dialog`（`web/src/ui/dialog.tsx`）：`busy`、`initialFocus`、`returnFocus`（`RefObject`）、`dismissible`。Menu → Dialog 的既有写法：`web/src/features/files/dialogs.tsx:36-45`（`onSelect` 把 trigger 元素交给调用方作 `returnFocus`）。
- `useToast()` 已在 `composer.tsx`、`message-actions.tsx` 使用，但那是叶子组件（欢迎态与无消息时不挂载）。生产入口 `main.tsx` 与 `render-app-router.tsx`、`chat-page-lifecycle-support.tsx` 有 `ToastProvider`；`web/test/routes.test.tsx`（三处）与 `web/test/settings-support.tsx` 的 `renderApp` 把 `createAppRouter()` 裸挂在 `RouterProvider` 下，没有 Provider——页面级 hook 调用 `useToast()` 后这两个夹具必须补上（Must-preserve 5）。
- 层级：Menu 1600、Dialog 1400 均高于导航 Drawer 1360（`menu.css:6`、`dialog.css:10`、`:99`）；本刀不用 `Popover`，不受 #715 影响。

## Governing invariant
列表条目与快照会话的 `title`、`pinnedAt` 只来自服务端响应：PATCH 200 的视图按 id 只合并该请求修改的那个键（重命名 → `title`，置顶 → `pinnedAt`），其它键只由既有的列表读取与事件流同步写入。同一会话的同类请求只采用最后发出者的响应；不属于当前 client 或页面已卸载时到达的响应一律丢弃。请求体恰为 `{title: <trim 后文本>}` 或 `{pinned: <布尔>}`。

## Sibling surfaces
- `page.tsx:578-600`（事件流把当前会话 `status` 同步进 `listState`，只改 `status`）：与本刀的元数据合并写同一个 `listState`，互不覆盖对方的键。
- `refreshList`（`page.tsx:135-177`，成功时整表替换 `listState`）及其调用点 `page.tsx:188`、`:499`、`turn-actions.ts:196`、`:337`、`:387`：在 PATCH 之后发出的读取带回新值；在 PATCH 之前发出而晚于 PATCH 200 到达的读取会带回旧值（已知残留 2）。
- `session-path.ts` `selectedSessionTitle`：`web/test/topbar.test.tsx:178` 直接调用，签名与行为不变。
- `web/src/lib/topbar.tsx`、`web/src/routes/shell/topbar.tsx`（#529）：描述符按 `key/label/icon/expanded` 浅比较、`onSelect` 取最近一次渲染的闭包；本刀是第一个注入方。
- 7.2b（`删除` 项接在同一菜单、同一 `session-actions.ts`）、7.6/7.7（各填 `CHAT_TOPBAR_ACTIONS` 的一个槽位）、8.2b（ui-walk 走置顶与重命名）。
- 两个呈现面：`≥761px` 文档流侧栏与 `≤760px` 导航 Drawer；顶栏第二态在两个视口都有。
- `server/src/sessions/rest-metadata.ts` 的 PATCH 路由与 400/404 信封：本刀只消费。

## 决定

### D1 状态与 Dialog 归会话页
重命名 Dialog 由行菜单（槽位节点，折叠/覆盖层关闭时卸载）和顶栏按钮（shell）共用，只有会话页主树同时活过两者。`useSessionActions` 持有全部状态，`ChatPage` 渲染 `<RenameDialog>`。

`page.tsx` 行计划（666 → 672，上限 676）：
| 改动 | 行 |
|---|---|
| `import { RenameDialog } from "./rename-dialog.js"` | +1 |
| `import { useSessionActions } from "./session-actions.js"` | +1 |
| `import { chatTopbar } from "./topbar-actions.js"` | +1 |
| `session-path` 导入：`selectedSessionTitle` → `selectedSession` | 0 |
| `const sessionActions = useSessionActions(client, setListState, setHistoryState)` | +1 |
| `useTopbar({ breadcrumb: selectedSessionTitle(…) })`（3 行）→ `const selected = selectedSession(…)` + `useTopbar(chatTopbar(selected, sessionActions.openRename))` | −1 |
| 槽位 props：`onRenameSession`、`onTogglePin` | +2 |
| `<RenameDialog rename={sessionActions.rename} />`（空判断在组件内：内联三元会让 `ChatPage` 的认知复杂度到 16，超过 Biome 上限 15） | +1 |
实际行数以格式化后为准，PR 记录 666 与合入后行数。`types.ts`、`turn-actions.ts`、`stream.ts`、`workspace-list.ts`、`session-groups.ts`、`session-filter.tsx`、`web/src/lib/**`、`web/src/ui/**`、`web/src/routes/**` 零 diff。

### D2 `session-actions.ts`：`useSessionActions(client, setListState, setHistoryState)`
返回 `{ openRename(session, trigger), togglePin(session), rename }`。
- 内部自带 `clientRef`、卸载标记与 abort（同 `useWorkspaceList` 的做法），不接入 `mutationControllerRef`——重命名/置顶在任何状态（含 `running`）可用，与回合互斥无关。
- **重命名状态** `{ client, sessionId, title, busy, error, token }`（`token` 标识这一次打开）；`rename` 在 `state.client !== client` 时为 `null`（换账号后不露出上一账号的对话框）。`returnFocus` 是 hook 内的一个 `RefObject<HTMLElement | null>`，`openRename` 在置状态前写入 `trigger`（`Dialog.returnFocus` 只接 ref；Menu 关闭与 Dialog 打开在同一次提交里，不能依赖「打开瞬间的活动元素」）。
- `rename` 即 `RenameDialog` 的 props：`{ title, busy, error, returnFocus, onSubmit(text), onCancel() }`。`onCancel` 任何时候都把状态置 `null`（请求中也可关闭，请求不取消）。
- **提交**：`onSubmit(text)`：`text.trim()` 为空或 `busy` → 返回；置 `busy`、清 `error`；`patchSession(id, { title: trimmed }, { signal })`。成功 → 合并视图、Toast success `已重命名`，且若发起它的那次打开（`token`）仍是当前状态则关闭。失败（非 401）→ 那次打开仍在：`busy: false`、`error: errorMessage(error)`；已被关闭：Toast error 同一 message。401 → 只复位仍在的那次打开的 `busy`（既有通知机制接管）。
- **置顶**：`togglePin(session)`：`patchSession(id, { pinned: session.pinnedAt === null })`。成功 → 合并视图 + Toast success `已更新置顶状态`；失败（非 401）→ Toast error `errorMessage(error)`，不动列表。
- **合并**（都以 `{ ...current, … }` 展开保留其余字段，快照状态上的 `resync` 标记不能丢，`page.tsx:38-40`、`:252-254`）：只取该请求修改的键——重命名取响应的 `title`，置顶取响应的 `pinnedAt`（两类请求可同时在途：重命名请求中关闭 Dialog 后去置顶；合并整组元数据会让先发后到的响应把另一类刚写入的值改回去）。`setListState`：`status === "success"` 且 `client` 相同且含该 id → 该条目变为 `{ ...entry, [键]: 响应值 }`，否则原样返回；`setHistoryState`：`ready` 且 `client` 相同且 `snapshot.session.id` 相同 → 同样合并进 `snapshot.session`（列表读取失败时面包屑走快照，`session-path.ts`）。列表里找不到该 id 时仍然提示成功。
- **fence**：每个请求记下 `ownedClient` 与「会话 + 键」的序号（`Map<"<id>:title"|"<id>:pinnedAt", number>`，发出时自增）；响应处理前检查：未卸载、未 abort、`ownedClient === clientRef.current`、序号仍是该「会话 + 键」的最新值。任一不满足 → 丢弃（不合并、不提示、不改对话框）。卸载时 abort 全部在途请求。
- 不乐观更新：UI 只在 200 后变化。

### D3 `rename-dialog.tsx`
`Dialog`：`title="重命名任务"`、`size="sm"`、`open`、`busy`、`initialFocus`（输入框 ref）、`returnFocus`、`onOpenChange(false)` → `onCancel`（始终 `dismissible`）。内容是一个 `<form>`：`Input`（`aria-label="任务名称"`，初值 `title ?? ""`，本组件 `useState`）、失败提示 `<p class="ui-alert" role="alert">`、按钮行 `取消` 与 `保存`（`type="submit"`、primary、`loading={busy}`、trim 为空时 `disabled`）。Enter 走表单的原生提交（输入法组合中的 Enter 不触发隐式提交，不写键盘处理代码）。组件按 `rename !== null` 条件挂载，每次打开都是新的输入状态（同 `files/dialogs.tsx` 的做法）。

### D4 `session-menu.tsx` 与条目行
`SessionMenu({ session, title, onRename(trigger), onTogglePin() })`：`Menu` 的 trigger 是 ghost 图标 `Button`（类 `chat-session-more`、`aria-label={`更多操作：${title}`}`、`Icon more-horizontal`、自带 `ref`）；`items`：`{ label: "重命名", icon: "pencil", onSelect: () => onRename(ref.current) }`、`{ label: pinnedAt === null ? "置顶任务" : "取消置顶", icon: "star", onSelect: onTogglePin }`。
`session-sidebar.tsx` 的 `li.chat-session-item` 变为一行两个同级按钮：既有 `button.chat-session-button`（标记逐字不变）+ `<SessionMenu>`。菜单回调不调用 `onNavigate`。新 props：`onRenameSession(session, trigger)`、`onTogglePin(session)`。

### D5 `topbar-actions.ts`
```ts
export const CHAT_TOPBAR_ACTIONS = [
  { key: "rename", label: "重命名", icon: "pencil" },
  { key: "search", label: "对话内搜索", icon: "search" },
  { key: "artifacts", label: "产物面板", icon: "package" },
] as const;
```
- `chatTopbarActions(slots)`：`slots` 为 `Partial<Record<key, { onSelect(trigger): void; expanded?: boolean }>>`，按常量次序返回 `TopbarAction[]`，缺的槽位跳过（7.7 的 `expanded` 现在就留好位置）。
- `chatTopbar(selected, openRename)`：`selected` 为当前会话或 `undefined`；返回 `useTopbar` 的入参——有会话时 `{ breadcrumb: sessionTitle(selected), actions: chatTopbarActions({ rename: { onSelect: (trigger) => openRename(selected, trigger) } }) }`，否则 `{}`（欢迎态不上报）。不 memo：shell 按描述符浅比较。
- `session-path.ts`：新增 `selectedSession(requestedSessionId, list, ownedHistory, historyState): ChatSession | undefined`（原查找逻辑），`selectedSessionTitle` 改为调用它后取 `sessionTitle`，签名与结果不变。

### D6 样式（`chat.css`）
`.chat-session-item`：`display: flex; align-items: center; gap: 2px`；`.chat-session-button`：`flex: 1; min-width: 0`（去掉 `width: 100%`）。`.chat-session-more`：`flex: none`；`@media (hover: hover) and (min-width: 761px)` 下默认 `opacity: 0`，在 `.chat-session-item:hover`、`:focus-within` 或按钮 `[data-state="open"]` 时 `opacity: 1`；其余环境始终可见。媒体块内不写 `transition`（`web/test/ui-reduced-motion.test.ts:122-150` 把非 reduce 媒体块里的 transition 判为违规）；`.chat-session-button` 规则上方的注释 `demo.html:282-298` 保留（`chat-composer.test.tsx:231-244`）。重命名表单的间距与按钮行（demo:3795-3801）。只用既有 token。

## Must-preserve
1. `button.chat-session-button` 的标记、`aria-current`、accessible name（标题）与状态元素不变；它仍是 `li.chat-session-item` 的子元素，`更多操作` 按钮是其同级而非后代（`ui-walk-layout.ts:310-320`、`ui-walk-stop.ts:95`/`:159`/`:217`、`ui-shots.mjs:287`、`chat-page-sidebar.test.tsx` S11）。
2. 选择会话与 `新建会话` 仍调用 `onNavigate`；「更多」按钮、菜单项、Dialog 都不调用。
3. `selectedSessionTitle` 的签名与结果（`topbar.test.tsx:178`）；无选中会话时 `useTopbar` 不上报面包屑与 actions（顶栏三态既有断言）。
4. `/api/sessions`、`/api/workspaces` 的请求次数与时机不变；本刀不触发 `refreshList`。
5. 既有测试的断言零 diff。唯一的既有文件改动是夹具形状：`web/test/routes.test.tsx` 三处 `render(<RouterProvider …/>)` 与 `web/test/settings-support.tsx` 的 `renderApp` 外包一层 `ToastProvider`，与 `main.tsx` 的根结构一致（实现时发现：这两个夹具此前缺 Provider 而未暴露）。

## Required evidence
`web/test/chat-page-session-rename-pin.test.tsx`（M1–M7、M13、M14、M16）与 `web/test/chat-page-session-pin.test.tsx`（M8–M12、M15），共用 `web/test/chat-page-session-meta-support.tsx`——单文件会超过 800 行（首行引入 `./radix-platform.js`；全部 RED，除注明者）。「Enter」在 jsdom 里的输入是 `fireEvent.submit(form)`——jsdom 不做隐式表单提交、仓库没有 user-event，先例 `web/test/login-form.test.tsx:325-336`；真实按键由一次性浏览器观察覆盖。M15 静态导入 `topbar-actions.js` 并放在 pin 文件：Vite 在转换期解析 `import()` 的字面量说明符，动态导入同样让所在文件在实现前无法收集；非字面量说明符则 knip 看不到引用。实现前 pin 文件整体收集失败计 RED，M16 前半在 rename-pin 文件里可观察。另含 D2 的 401 分支两条（重命名 401 只复位忙碌、置顶 401 不提示）。
- M1 菜单：未置顶会话的 `更多操作：<标题>` 打开后 `menuitem` 恰为 `重命名`、`置顶任务`；已置顶会话为 `重命名`、`取消置顶`；无 `删除`、`导出记录`；`running` 会话的菜单同样可打开且两项可用；`title: null` 的会话按钮名为 `更多操作：新会话`；每个条目恰一个「更多」按钮，且它不在 `button.chat-session-button` 内。
- M2 行菜单重命名成功：输入初值为服务端标题、打开时焦点在输入框；改为 `  周报整理  ` 点 `保存` → 恰一次 `PATCH /api/sessions/<id>`、body 文本恰为 `{"title":"周报整理"}`、`Content-Type: application/json`；Dialog 消失；条目按钮名与顶栏 heading `我的工作 / 周报整理` 更新；Toast `已重命名`；焦点在该条目的 `更多操作：周报整理` 按钮；全程无 `/api/sessions` 列表请求。
- M3 禁用与 Enter：输入全空白 → `保存` 禁用、Enter 不发请求；`title: null` 会话打开时输入为空且 `保存` 禁用；输入有效文本后 Enter → 恰一次 PATCH（等价 `保存`）。
- M4 请求中：PATCH 挂起 → `保存` 禁用，再次提交表单无第二个 PATCH；响应 200 → 按 M2 收尾。请求中点 `取消` → Dialog 消失；随后 200 → 条目与 heading 更新、Toast `已重命名`；同样关闭后 400 信封 → 标题不变、Toast 显示其 message。请求中关闭后再次打开同一会话的重命名：输入初值仍是旧标题、`保存` 可用、无残留 alert；此时旧请求的 200 到达 → 条目与 heading 更新、Toast `已重命名`，重开的 Dialog 仍在且输入框里已键入的文本不变；另一例旧请求的 400 到达 → Toast 显示其 message，重开的 Dialog 内无 `role="alert"`、`保存` 仍可用。关闭后迟到的 200 不让 Dialog 重新出现。
- M5 失败：400 信封 `请求格式不正确` → Dialog 仍在、其内 `role="alert"` 文本恰为该 message、条目标题与 heading 不变、无 `已重命名`；再次 `保存`（这次 200）→ 提交瞬间 alert 消失、随后成功。非信封失败（500 非 JSON）→ alert 为 `请求失败，请稍后重试`。`取消` → Dialog 消失、无请求、焦点回到打开它的按钮。
- M6 顶栏入口：`/?session=<id>` 标题已知 → banner 内 heading 之后有 `重命名` 按钮、无 `更多`；heading 的 accessible name 不含 `重命名`；点击 → `重命名任务` Dialog、输入初值为该会话标题；成功后 heading 更新、焦点回到顶栏 `重命名`；失败同 M5。欢迎态（`/`）banner 内无 `重命名`（`≥761px` 无 banner；`≤760px` 只有 `打开导航`）。
- M7 列表失败时的顶栏重命名：`GET /api/sessions` 503 而快照就绪 → 顶栏 `重命名` 成功后 heading 以响应标题更新（快照路径）。
- M8 置顶往返：`任务` 中三条会话，对中间一条选 `置顶任务` → 恰一次 PATCH body `{"pinned":true}`、Toast `已更新置顶状态`、该条目只在 `置顶任务`、分区名变为 `任务 (2)`；再开其菜单为 `取消置顶` → PATCH `{"pinned":false}` → `置顶任务` 分区消失、`任务 (3)` 内三条的顺序与最初相同。
- M9 置顶失败：409 信封 → Toast 显示其 message，分区与条目顺序不变；非信封失败 → Toast `请求失败，请稍后重试`。
- M10 只信响应：重命名的 200 响应里 `title` 与输入不同 → 条目显示响应的标题；置顶的 200 响应里 `pinnedAt` 为 null → 条目留在 `任务`（不乐观更新）。
- M11 迟到响应不回退状态（Scenario「迟到的元数据响应」）：`running` 会话置顶请求挂起 → 触发一次列表重读（点 `新建会话`，`page.tsx:499`；返回该会话 `done`）→ 置顶响应到达（视图 `status: "running"`、`pinnedAt` 非 null）→ 条目在 `置顶任务` 且状态元素名为 `<标题> 已完成`。
- M12 乱序：同一会话在第一次置顶响应返回前再点一次 `置顶任务`（无乐观更新，两次请求体都是 `{"pinned":true}`）；第二次的响应（`pinnedAt` 非 null）先到 → 条目进 `置顶任务`；第一次的响应（`pinnedAt: null`）后到 → 被丢弃，条目仍在 `置顶任务`，全程只有一条 `已更新置顶状态`。跨类：重命名请求中关闭 Dialog → 对同一会话 `置顶任务`；置顶响应先到（进 `置顶任务`），重命名响应后到（其视图 `pinnedAt: null`、`title` 为新标题）→ 条目仍在 `置顶任务` 且标题更新，两条 Toast 各出现一次。镜像：置顶请求挂起 → 顶栏重命名成功（标题已更新）→ 置顶响应到达（其视图 `title` 为旧标题、`pinnedAt` 非 null）→ 条目进 `置顶任务` 且标题仍为新值。
- M13 fence：重命名 PATCH 挂起时续期为另一 client（`renderChatPageWithAuthProbe` + `renewAccount`）→ 旧响应到达后无 Toast、新账号的列表不变、没有 Dialog；PATCH 挂起时卸载页面 → 响应到达不抛错、无 React 警告。
- M14 `≤760px` 覆盖层：`导航` 内条目 `更多操作` → `重命名` → Dialog 打开且 `导航` dialog 仍在 DOM；保存成功后 `导航` 仍在、条目名已更新；`置顶任务` 同样不关闭覆盖层。（Dialog 打开期间 Drawer 被 `hideOthers` 标为 `aria-hidden`，其 accessible name 算作空串，按名称查不到；断言按元素「仍在 DOM 中」。）
- M15 `CHAT_TOPBAR_ACTIONS`：`key` 次序恰为 `rename`、`search`、`artifacts`，标签 `重命名`、`对话内搜索`、`产物面板`，图标 `pencil`、`search`、`package`；`chatTopbarActions({ artifacts, rename })` 返回次序为 `rename`、`artifacts`（按常量而非入参键序），`expanded` 透传，未给的槽位不出现。
- M16 （保持项，实现前后皆绿）`selectedSessionTitle` 的既有行为由 `topbar.test.tsx` 覆盖；本文件只断言选择按钮仍调用选择（点击条目按钮 → `?session=` 改变）且菜单按钮点击不改变 `?session=`——后半句 RED（按钮不存在）。

实现前后各跑一次并记录：RED 集合 = M1–M15 与 M16 后半；既有套件实现前后皆绿、零 diff。

一次性真实浏览器观察（不入库，写进 PR；结果：两种视口全部符合，详见 PR）：1440×900 与 390×844 各做一次「行菜单 → 重命名 → 保存」与「置顶 → 取消置顶」，记录菜单与 Dialog 是否可见可点（`elementFromPoint`）、「更多」按钮在两种视口的可见性、长标题下行内两个按钮不溢出；真实键盘 Enter 三项：有效文本提交一次、全空白不提交、在输入框内 Enter 提交后焦点仍在输入框时再按 Enter 不重发（鼠标点 `保存` 后焦点会被救回到 `关闭`，那条路径上 Enter 是关闭 Dialog，同样不重发）。

## 已知残留
1. 置顶/取消置顶后条目换了父节点（分区）而重挂，菜单关闭时归还给旧「更多」按钮的焦点随之落到 `body`；不把焦点移到迁移后的条目（规格未要求）。
2. PATCH 之前发出、晚于 PATCH 200 到达的列表读取会把该条目的标题/置顶暂时改回旧值，直到下一次列表读取（`refreshList` 整表替换）；窗口为一次列表请求的在途时间，不为此在读取路径上加元数据保留层。
3. 顶栏 `重命名` 关闭 Dialog 后焦点回到该按钮会弹出 Tooltip（Radix 聚焦即显；#714 已记）。
4. 当前会话不在已读取列表里且快照未就绪时没有顶栏 `重命名`（标题未知即第一态，spa-shell 既有规则）。
5. 筛选生效时被置顶/重命名的条目仍按筛选显示或隐藏；不为此加提示。

## Seams under test
- jsdom 页面 fixture（`renderChatPage` / `renderChatPageWithAuthProbe` + `createFetchMock`）：菜单、Dialog、Toast、列表与顶栏的联动，请求体与次数，时序（挂起、乱序、重读、续期、卸载），覆盖层。
- 纯函数：`CHAT_TOPBAR_ACTIONS` 与 `chatTopbarActions`（M15）。
- CI `ui-walk`：既有走查对条目钩子的回归门。
