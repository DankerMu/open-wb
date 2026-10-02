# Design: artifacts-panel（#537）

## Context
- `topbar-actions.ts`（42 行）：`CHAT_TOPBAR_ACTIONS` 三个槽位（`rename`、`search`、`artifacts`），`chatTopbarActions(slots)` 按常量次序产出已填槽位；`chatTopbar(selected, openRename)` 只填 `rename`，`selected` 为空时返回 `{}`（欢迎态无按钮）。`page.tsx:632` `useTopbar(chatTopbar(selected, sessionActions.openRename))`。
- `web/src/lib/topbar.tsx:20-26`：`TopbarAction { key, label, icon, expanded?, onSelect(trigger) }`；`label` 同时是 accessible name 与 Tooltip；点击时以按钮元素为 `trigger` 调 `onSelect`，「供页面把焦点归还给触发按钮」；shell 经 ref 取最新的 `onSelect` 闭包。
- `web/src/ui/drawer.tsx`：`Drawer({ open, onOpenChange, side, width: 288 | 420, title, footer, children })`；Radix Dialog 行为层，头部自带 `关闭` 图标按钮；**没有 `returnFocus`**——关闭后焦点还给「打开瞬间的 `document.activeElement`」（`useFocusHandoff({})`）。Escape 兜底 `useEscapeFallback` 只认目标在抽屉 Content 的 DOM 子树内的按键（`escape-fallback.ts`），portal 在外的嵌套 Dialog 不算。层级：抽屉遮罩 1350、抽屉 1360、Dialog 遮罩 1400（`dialog.css`），Toast 2000。
- `file-changes-card.tsx`（71 行）：行（`div.file-change-row`：`+a`/`-d` 或 `写入`、逻辑路径、`查看详情` 按钮）与空间前缀推导（`useAuth().principal?.account` + `logicalPath`）内联在 `FileChangesCard` 里。
- `artifact-card.tsx`（208 行）：`ArtifactCards`（导出）与私有 `ArtifactCard`；拉取纪律（`opener`/`controller`/`busy`/`preview`、`run`/`deliver`/`copy`/`download`、预览 Dialog）全在 `ArtifactCard` 里。
- `stream-artifacts.ts`：`summarizeChanges(steps)`（已结束步骤、同一路径位置取首次、值取最后）、`artifactKind(path)`。
- 视图里步骤的次序：快照按 `ORDER BY s.ordinal ASC, s.id ASC`（`server/src/sessions/store.ts:324`）给出，`stream.ts:104` 原序映射，`step.start` 追加到末尾——所以 `message.steps` 即 ordinal 升序，`view.messages` 即消息次序。
- `page.tsx`（690 行）：`requestedSessionId`（`:60`，`string | null`）、`historyView`（`ChatState | null`，`:630`）、`selected`（`:631`）、`workspaces`（`:75`）；`ChatPage` 的认知复杂度在 Biome 上限 15。
- 既有测试 `web/test/chat-page-session-rename-pin.test.tsx:75-79` 的 `bannerButtons()` 取 banner 内全部按钮的 `aria-label`，`:470,487,527` 断言 `toEqual(["重命名"])`，`:539`（≤760px）断言 `toEqual(["打开导航", "重命名"])`。shell 在没有标题时不渲染任何 action（`web/src/routes/shell/topbar.tsx:50,74`）。主规格 `session-sidebar`「会话条目菜单与重命名」有一句「当前只有 `重命名` 槽位产出按钮」（`openspec/specs/session-sidebar/spec.md:62`）。`chat-page-session-pin.test.tsx` 的 M15 钉 `CHAT_TOPBAR_ACTIONS` 与 `chatTopbarActions`（不受本刀影响）。
- demo：`resource/workbuddy-live-demo.html:2033-2046`（`openArtifactsPanel`：空 → `toast('当前任务暂无产物','info')`；否则 `openDrawer({ title: '产物面板', …, foot: 关闭 ghost 按钮 })`）。

## Decisions

### D1 聚合
`summarizeChanges(view.messages.flatMap((message) => message.steps))`。按 Context 的次序事实，它恰是「消息靠后者优先、同消息 ordinal 大者优先、位置取首次、只算已结束步骤」。不新写聚合函数，不按角色过滤（proposal 偏差 3）。

### D2 `file-changes-card.tsx`：抽出行与前缀
- `useChangeSpace(workspace: Workspace | null): { id: string; prefix: string } | null`（导出）：现在卡片里那段 `account` + `logicalPath` 的推导原样搬出。
- `FileChangeRow({ change, space, children })`（导出）：现在的行 JSX 原样搬出（`useNavigate()` 随行走）；`children` 渲染在 `查看详情` 之后，卡片不传。
- `FileChangesCard` 改为：`useChangeSpace`、`useId` 在前，再算汇总、空则 `null`（hook 在提前返回之前，同 7.5a D4），逐项 `<FileChangeRow key={change.path} …/>`。卡片的 DOM、文案、类名、降级规则都不变。

### D3 `artifact-card.tsx`：抽出操作
- 把 `ArtifactCard` 里的状态与函数（`opener`、`controller`、`busy`、`preview`、cleanup effect、`run`/`deliver`/`copy`/`download`、`onAction`）与两段 JSX（卡头的操作图标按钮、预览 `Dialog`）收进模块内的 hook `useArtifactAction({ artifact, client, path, workspaceId })`，返回 `{ busy, label, onAction, button, dialog }`（`button`、`dialog` 是元素）。函数体逐行照搬，不改写。
- `ArtifactCard` 改用它：卡头渲染 `{button}`，卡脚按钮继续用 `busy`/`onAction`/`label`，fieldset 之后渲染 `{dialog}`。DOM 不变。
- 新导出 `ArtifactAction(props)` = `<>{button}{dialog}</>`，给面板的行用。
- 模块仍只有一份拉取纪律、一处 `sandbox="allow-scripts"` 的 iframe、一处卡头按钮 JSX。实现者可以调整 hook 的内部形状，但这三个「只有一份」与「两张卡的测试零 diff」是硬约束。

### D4 `artifacts-panel.tsx`
```tsx
export function useArtifactsPanel(
  client: ApiClient,
  view: ChatState | null,
  workspace: Workspace | undefined,
): { open(trigger: HTMLElement): void; panel: ReactNode }
```
- 状态只有 `open: boolean`。渲染期校正：`if (open && view === null) setOpen(false);`（同组件 state 的渲染期调整，React 支持，不会循环）。切换会话时 `historyView` 在第一次渲染就是 `null`（`ownership.ts:27-31` 的归属判断按会话 id 与 client 比较，`page.tsx:627-630`），换账号（`page.tsx:195-198`）与历史重新读取同样；重同步、重新生成、重连都是 ready → ready，不经过 `null`（分叉会导航到新会话 id，属于切换会话）。所以只看 `view === null` 就够，不需要记会话 id，hook 也不收 `sessionId`。关闭后回到原会话不重开。
- `open(trigger)`：`view` 为空或 D1 的聚合为空 → `toast.show({ type: "info", message: "当前任务暂无产物" })`，不动状态（历史还在读取或读取失败时 `view` 为空，同样走这里）；否则 **先 `trigger.focus()`** 再 `setOpen(true)`。`Drawer` 记下的打开者是打开瞬间的活动元素；鼠标点击在 Safari 里不聚焦按钮（jsdom 的 `fireEvent.click` 也不），不先聚焦的话关闭后焦点落在 body。这正是 `onSelect(trigger)` 给 `trigger` 的用途。
- `panel`：
  ```tsx
  <Drawer
    footer={<Button onClick={() => setOpen(false)} variant="ghost">关闭</Button>}
    onOpenChange={setOpen}
    open={open}
    side="right" title="产物面板" width={420}
  >
    {open ? <ArtifactsList changes={…D1…} client={client} workspace={workspace ?? null} /> : null}
  </Drawer>
  ```
  聚合只在 `open()` 里与抽屉打开时的渲染里计算；抽屉关着时页面每次渲染不做这次扫描。打开期间它随 `view` 每次渲染重算，所以新的 `step.end`/`files.changed` 直接反映在列表里。
- `ArtifactsList`（模块内组件）：`const space = useChangeSpace(workspace)`；`<div className="artifacts-panel-list">`，逐项
  ```tsx
  <FileChangeRow change={change} key={change.path} space={space}>
    {space !== null && artifact !== null ? (
      <ArtifactAction artifact={artifact} client={client} path={change.path} workspaceId={space.id} />
    ) : null}
  </FileChangeRow>
  ```
  （`artifact = artifactKind(change.path)`）。空间不可解析时行只有相对路径，没有 `查看详情` 也没有操作按钮（proposal 偏差 4）。
- 行内 `ArtifactAction` 随抽屉关闭而卸载，cleanup effect abort 在途拉取（7.5b 的纪律原样生效）。预览 `Dialog` 是行的 React 子节点、portal 到 body：层级在抽屉之上；它打开时是 Radix 层栈的最高层，Escape 与遮罩点击只作用于它；关闭后 `returnFocus` 把焦点还给行里的按钮（抽屉仍开）。
- `查看详情` 导航到 `/files?ws=<id>`，会话页卸载，抽屉随之消失。

### D5 `topbar-actions.ts`
`chatTopbar(selected, openRename, openArtifacts: (trigger: HTMLElement) => void)`；`actions: chatTopbarActions({ rename: {…}, artifacts: { onSelect: openArtifacts } })`。不传 `expanded`（proposal 偏差 6）。

### D6 `page.tsx`（690 → 694，含一行 import）
```tsx
const workspace = workspaces?.find((item) => item.id === selected?.workspaceId);
const artifacts = useArtifactsPanel(client, historyView, workspace);
useTopbar(chatTopbar(selected, sessionActions.openRename, artifacts.open));
…
        workspace={workspace}
…
      {artifacts.panel}   // 与 <RenameDialog/>、<DeleteDialog/> 并列
```
`workspace` 那一行是从 JSX 里原样提出来的（`?.` 与箭头函数不计复杂度）；`ChatPage` 里不新增 `??`、`&&`、三元。

### D7 样式（`messages.css`，694 行）
`.artifacts-panel-list` 取文件变更卡的外框（并入 `.file-changes-card, .artifact-card` 那条规则的选择器；fieldset 复位对 `div` 无害），行沿用 `.file-change-row` 与 `.chat-msg-action`。只用既有 token；不写 `transition`、`outline`。`chat.css`（797 行）不动。

### D8 既有测试的改动（见下）与 D9 焦点归还
**D9**（实现后的真实浏览器观察追加）：`useArtifactAction` 里加
```ts
useEffect(() => {
  if (!busy && document.activeElement === document.body) opener.current?.focus({ preventScroll: true });
}, [busy]);
```
- 起因：按钮在拉取中 `disabled`，Chromium 当即把焦点移到 `body`（`web/src/ui/dialog.tsx:53-55` 的记录）。图片/代码操作结束后焦点留在 `body`；在抽屉里，成功或失败 Toast 在屏期间（`TOAST_DURATION_MS` 2400）Radix 的 Escape 监听在 Toast 层，抽屉的 `useEscapeFallback` 又只认目标在抽屉内的按键——这段时间 Escape 关不掉抽屉（Chromium 实测：两次 Escape 抽屉都还在，Toast 消失后才恢复）。加 D9 之后复测：复制与下载完成后焦点在行按钮上，Toast 在屏时一次 Escape 即关闭抽屉、焦点回到 `产物面板`。
- 行为：`busy` 回到 `false` 的那次提交之后，若活动元素是 `body`，聚焦被点的按钮（此时它已恢复可用）。活动元素不是 `body`（用户已把焦点移到别处，或 html 预览 Dialog 已接走焦点）时不动。挂载时 `opener.current` 为空，不动。
- html：`busy` 回到 `false` 的那次提交里预览 Dialog 的内容还没挂载（Radix 晚一轮渲染），所以本 effect 也会先把焦点放回行按钮，随后 Dialog 接走焦点（`focusin` 次序：行按钮 → Dialog 的 `关闭`）；关闭时经 `returnFocus` 归还。终态不变，只多一次瞬时聚焦。
- `preventScroll`：转录里的卡片在慢拉取期间可能已离开视口（流式把它顶走，或用户滚走）；不带它的 `focus()` 会把 `.chat-transcript` 滚回卡片，这次滚动又经 `scroll-follow.tsx` 的 `onScroll` 解除贴底跟随。Chromium 实测：拉取挂起时滚到底部（`scrollTop` 2190），不带 `preventScroll` 时响应返回后被拽回卡片（`scrollTop` 67、出现 `回到最新`）；带上之后 `scrollTop` 仍为 2190、焦点在按钮上、没有 `回到最新`。
- 抽屉关闭或卡片卸载后不会再跑（组件已卸载）。
- 产物卡同样生效（7.5b 残留 8 消失），proposal 偏差 11。

### D8 既有测试的改动
`web/test/chat-page-session-rename-pin.test.tsx` 四处：`:470,487,527` 的 `["重命名"]` → `["重命名", "产物面板"]`；`:539` 的 `["打开导航", "重命名"]` → `["打开导航", "重命名", "产物面板"]`。若还有别的既有用例变红，停下报告。

## Governing invariant
1. 面板的列表在任何时刻都等于「当前视图全部已结束步骤的变更按路径聚合」——与各条消息的文件变更卡同源（同一个 `summarizeChanges`），不存副本。
2. 面板不发任何请求；文件内容只在点了行内操作之后才拉取，且拉取、预览、下载、复制只有 `artifact-card.tsx` 里那一份实现。
3. 抽屉只属于打开它时的那个视图：视图没了（切换会话、换账号、历史重新读取）就关闭，不带着旧会话的行留在新会话上。
4. 关闭后焦点回到 `产物面板` 按钮；空间绝对根不进任何文本与属性。

## Sibling surfaces
- `FileChangesCard`（D2 的抽取）：`web/test/chat-page-file-changes.test.tsx` 59 例是回归网，零 diff。
- `ArtifactCards`（D3 的抽取）：`web/test/chat-page-artifact-card.test.tsx` 与 `chat-page-artifact-card-state.test.tsx` 是回归网，零 diff。
- 顶栏 `重命名`：同一 `actions` 通道，次序由 `CHAT_TOPBAR_ACTIONS` 固定；M15、`chat-page-session-rename-pin.test.tsx`（D8 的四处）。
- `Drawer` 的另一个消费者（shell 的窄屏侧栏覆盖层，`web/test/app-shell-responsive.test.tsx`）：`web/src/ui/**` 不改。
- 7.7 `对话内搜索`：会把 banner 按钮变成三个，并再改一次 D8 的四处与 chat-web「顶栏入口」Scenario。

## Must-preserve
- 两张卡的 DOM、文案、请求、拉取纪律、降级规则与在助手块里的位置（唯一的行为变化是 D9 的焦点归还）。
- `重命名` 按钮的行为与在 banner 里的首位；欢迎态无顶栏按钮。
- `CHAT_TOPBAR_ACTIONS` 常量与 `chatTopbarActions` 不变。

## Required evidence（`web/test/chat-page-artifacts-panel.test.tsx`）
夹具与页面查询从 `chat-page-file-changes-support.tsx`、`chat-page-artifact-card-support.tsx`（`artifactCardFixture()`、`previewRoute`、`switchSession` 等）导入，不改它们；两条助手消息的快照等新夹具放 `chat-page-artifacts-panel-support.tsx`。抽屉查询 `screen.getByRole("dialog", { name: "产物面板" })`；脚部按钮经 `.ui-drawer-foot` 容器取；遮罩按下沿用 `web/test/app-shell-responsive.test.tsx:373-391` 的写法；Escape 用 `fireEvent.keyDown(document.activeElement, { key: "Escape" })`；焦点断言用 `await waitFor`（Radix 在定时器里归还焦点）。打开抽屉一律用 `fireEvent.click`、**不预先 focus**。抽屉（或预览 Dialog）打开时 Radix 把它之外的内容标成 `aria-hidden`：查 banner 按钮、查被预览盖住的抽屉都要带 `hidden: true`（先例 `chat-page-session-meta-support.tsx:257-259`、`chat-page-artifact-card-support.tsx:125-131`）；`chat-page-artifact-card-support.tsx` 的 `switchSession()` 不带 `hidden`，抽屉打开时不能用——切换会话在新 support 文件里用 `act(() => router.navigate("/?session=<另一个 id>"))`（模态之下侧栏本来就点不到，真实路径是浏览器前进/后退）。

- P1 顶栏入口：选中会话后 banner 内按钮的 `aria-label` 按序恰为 `["重命名", "产物面板"]`；`产物面板` 按钮没有 `aria-expanded` 属性、含 `lucide-package` 图标；欢迎态 banner 内没有这两个按钮（护栏：实现前就没有）。另一例单元断言 `chatTopbar(undefined, openRename, openArtifacts)` 恰为 `{}`（shell 在没有标题时本来就不渲染 action，页面级看不出「欢迎态也上报」）；`chatTopbar(<会话>, …)` 的 `actions` 的 `key` 依次为 `rename`、`artifacts`，且 `artifacts` 项没有 `expanded` 键。
- P2 聚合（Scenario「聚合与空态」前半）：助手消息甲的已结束步骤改 `a.md`（edit `+1 -0`），助手消息乙改 `a.md`（edit `+3 -1`）与 `out/index.html`（write），空间可解析 → 点击后出现名为 `产物面板` 的 dialog（带类 `ui-drawer--right` 与 `ui-drawer--w420`），`.artifacts-panel-list` 下恰两行，依次是：`+3`、`-1`、`zhangsan/proj/a.md`、`查看详情 zhangsan/proj/a.md`、`复制代码 a.md`；`写入`、`zhangsan/proj/out/index.html`、`查看详情 …`、`打开网页预览 index.html`（每行内按钮次序：`查看详情` 在前、操作在后）。此时对 `/file` 的请求数为 0；整个文档的 `innerHTML` 不含空间绝对根。
- P3 次序规则：
  - 同一消息内步骤 ordinal 0 改 `b.ts`（`+1`）、ordinal 1 改 `b.ts`（`+5 -2`）→ 行显示 `+5`、`-2`。
  - 消息甲改 `y.md`（`+1`）、`x.md`，消息乙改 `y.md`（`+4 -2`）、`w.md` → 行次序 `y.md`、`x.md`、`w.md`，`y.md` 的值来自消息乙（`y.md` 在甲里排最前、在乙里也排最前：「位置取最后」会给出 `x.md`、`y.md`、`w.md`）。
  - running 步骤的变更不出现在列表里。
  - `main.py`（不可派生）有行、有 `查看详情`、没有操作按钮。
- P4 空态（Scenario 后半）：会话没有任何变更 → 点击后 Toast 恰为一条 `当前任务暂无产物`、类型 `info`（`ui-toast--info`），没有 dialog；历史还在读取（快照挂起、会话已在列表里所以按钮已出现）时点击同样；未绑定空间的会话同样；只有 running 步骤带变更的会话同样。随后同一会话的 `step.end` 到达后再点 → 抽屉打开（正向对照）。
- P5 打开期间更新（Scenario「打开期间更新与行操作」前半）：快照里步骤 0 已结束改 `a.md`、步骤 1 running 且已带 `[write("out/new.html")]` → 打开抽屉恰一行；发 `step.end`（步骤 1）→ 不重开，抽屉里变成两行，抽屉节点是同一个；再发一个新步骤的 `step.start` + `files.changed`（改 `a.md` 为 `+9`）+ `step.end` → `a.md` 行显示 `+9`、位置仍在第一行。
- P6 关闭与焦点（各一例）：脚部 `关闭`、头部 `关闭`、Escape、按下遮罩 → 抽屉消失，`document.activeElement` 是 banner 里的 `产物面板` 按钮。关闭后再点能重新打开。
- P7 行操作复用（Scenario 后半）：
  - html：点 `打开网页预览 index.html` → 恰一次 `GET /api/workspaces/<空间 id>/file?path=out%2Findex.html`；出现标题 `index.html` 的 dialog（此时共两个 dialog，带 `hidden: true` 查），iframe 的 `sandbox` 恰为 `allow-scripts`、`srcdoc` 为取回文本。Escape → 预览消失、抽屉仍在；`document.activeElement` 是该行的 `打开网页预览 index.html` 按钮。另一例点预览的 `关闭` 同样。
  - 图片：`下载 chart.PNG` → `click` spy 一次，`download` 为 `chart.PNG`，Blob URL 一个宏任务后撤销一次。
  - 代码：`复制代码 app.ts` → `writeText` 参数恰为预览文本，Toast `已复制到剪贴板`。
  - 失败：404 信封 → Toast 信封 message，抽屉仍开，按钮可再点。
  - 拉取中：该行按钮 `disabled`，别的行的按钮可点。
- P8 关闭即 abort：行内拉取挂起时关闭抽屉 → 请求的 `signal.aborted` 为真；随后让响应以图片返回 → Blob URL 被撤销、`click` spy 未被调用、没有 Toast；文本返回 → `writeText` 未被调用。
- P9 空间不可解析：会话空间不在列表里、列表读取中、列表读取失败，而视图里有 `a.md`、`out/index.html` 两个变更 → 点击后抽屉打开（不是 Toast），两行只显示相对路径 `a.md`、`out/index.html`，抽屉里没有 `查看详情`，也没有任何操作按钮；「读取中」一例在列表到达后（抽屉不关）行变成逻辑路径并出现 `查看详情` 与操作按钮。
- P10 会话归属：抽屉打开时路由导航到另一个会话 → 抽屉消失；再导航回原会话（历史重新读取完成后）→ 抽屉不自动出现，点 `产物面板` 才出现。换账号（`renewAccount`）→ 抽屉消失。
- P11 `查看详情`：点抽屉里某行的 `查看详情` → 路由到 `/files?ws=<空间 id>`，抽屉消失。
- P13 焦点归还（D9；在 `web/test/chat-page-artifacts-panel-focus.test.tsx`。jsdom 不做「禁用即失焦」，而且对已禁用的按钮 `blur()` 无效，所以在同一个 `act` 批里点击后立刻 `blur()`，赶在禁用提交之前让活动元素成为 `body`）：
  - 抽屉里：`focus()` 再点 `复制代码 app.ts`，响应挂起时对该按钮 `blur()`（活动元素成为 `body`）；响应返回、Toast `已复制到剪贴板` 出现后，`document.activeElement` 是该按钮（`waitFor`）。随后 Toast 仍在屏时 `fireEvent.keyDown(document.activeElement, { key: "Escape" })` → 抽屉消失，焦点回到 `产物面板` 按钮。
  - 对照（不抢焦点）：同样流程但挂起时把焦点移到抽屉脚部的 `关闭` 按钮 → 响应返回后活动元素仍是脚部 `关闭`。
  - 失败路径：404 → Toast 信封 message 之后活动元素是该按钮。
  - 产物卡（转录里）：`下载 chart.PNG` 挂起时 `blur()` → 完成后活动元素是该按钮。
  - html：挂起时 `blur()` → 预览打开后活动元素在预览 Dialog 内（不是行里的按钮）；关闭预览后是行里的按钮。
- 评审第 1 轮后追加（Q1–Q5）：Q1 焦点归还的 `focus` 调用带 `{ preventScroll: true }`（spy `HTMLElement.prototype.focus`）；Q2 即上面 P3 的跨消息夹具；Q3 html 卡点卡脚按钮、预览 404 → 焦点回卡脚按钮而非卡头；Q4 路由导航关掉抽屉后焦点在 `产物面板` 按钮上；Q5 预览开着时导航到别的会话 → 两个 dialog 都消失，`body` 的 `pointer-events` 与应用根的 `aria-hidden` 已释放，新会话的 `产物面板` 按钮可用。追加变异：去掉 `preventScroll`（Q1）；逐消息汇总后跨消息「位置取最后」合并（Q2）；D9 恒聚焦卡头按钮（Q3）；`open()` 不调 `trigger.focus()`（Q4、P6、P8、P13 的复制例）。
- P12 静态与护栏：`.artifacts-panel-list` 的规则在 `messages.css`、`chat.css` 不含 `artifacts-panel`（护栏）；`web/src/features/chat/artifacts-panel.tsx` 的源码不含 `fetchPreview`、`sandbox`、`clipboard`、`createObjectURL`（复用而非复制的静态证据）。

基线运行：测试不导入实现前不存在的模块（全是页面级），直接在基线树上跑；P1 的欢迎态一句、P1 单元断言里 `chatTopbar(undefined, …)` 恰为 `{}` 一句（运行时忽略多余实参）与 P12 的 `chat.css` 一句是实现前就成立的护栏，其余应为红；报告里逐条列出基线即绿的用例。P13 的对照例与 html 例在加 D9 之前就绿（护栏）。

变异自检（实现者在沙箱里做，做完还原，写进报告；每个至少打红一例）：聚合取首次值（`if (!byPath.has(path))`）；位置取最后（先 `delete` 再 `set`）；只聚合最后一条助手消息；计入 running 步骤；打开时拍快照（聚合存进 state）；空也开抽屉；非空也只 Toast；`open()` 不调 `trigger.focus()`；传 `expanded: true/false`；`artifacts` 槽排到 `rename` 之前（改 `chatTopbarActions` 入参次序不应有影响——这一条预期**存活**，由 M15 钉常量次序；改常量次序则 P1 与 M15 红）；欢迎态也上报 actions（P1 的单元断言）；空间不可解析时弹 Toast 而不开抽屉；空间不可解析时照样渲染操作按钮；操作按钮放在 `查看详情` 之前；行里另写一份 `fetchPreview` 调用（P12 的静态断言）；去掉渲染期的 `view === null` 校正；脚部 `关闭` 不关；`width={288}`；`side="left"`；标题不是 `产物面板`；Toast 文案或类型改动（`error`）；`FileChangeRow` 不渲染 `children`；去掉 D9 的 effect（P13 的复制、404、产物卡三例红）；D9 不判断活动元素、无条件聚焦（P13 的对照例红；html 例看不出来——交付代码在 html 路径上本来也先聚焦行按钮）；去掉 `!busy` 条件（等价变异，存活：`busy` 为真时按钮已禁用，`focus()` 是空操作）；`useChangeSpace` 的前缀用 `workspace.root`（既有 C9/C11 与 P2 都应红）。

## 已知残留
1. #522 合入前服务端不产生 `changes`，真实链路上点 `产物面板` 只会弹「暂无产物」；真实浏览器与跨进程证据归 #522、8.2a。
2. 行内 `复制代码` 继承 #731（剪贴板写入在网络往返之后，Safari 预期失败）。拉取**进行中**焦点仍在 `body`（按钮禁用所致，D9 只在结束时归还）：这段时间若屏上恰有别的 Toast，Escape 关不掉抽屉；没有 Toast 时 Escape 正常（Chromium 实测）。
3. 列表没有分组、筛选或虚拟滚动；变更很多时是一条长列表（抽屉 body 自身滚动）。
4. 抽屉打开期间聚合随每次页面渲染重算（流式 delta 每帧一次线性扫描）；关着时不算。
5. 抽屉打开期间若聚合变空（只可能来自重同步换来的快照里变更消失），抽屉保持打开、列表为空，不自动关闭也不补 Toast。
6. 同名不同目录的文件：行里有完整逻辑路径可分辨，但两行的操作按钮 accessible name 相同（`复制代码 index.ts`）（7.5b 残留 13）。
7. `查看详情` 只到空间，不定位到文件（7.5a）。
8. 窄屏（抽屉 `max-width: 92vw`，390 宽时为 359px）下一行是计数 + 路径省略 + 两个 26px 按钮；Chromium 一次性观察里 `+3 -1` 加两个按钮时路径还有 186px、行不溢出；更长的计数未验证。
11. html 行里 `查看详情` 与 `打开网页预览` 两个按钮都是 `chevron-right` 图标（后者沿用 7.5b 残留 7：demo 的 `externalLink` 未注册），在抽屉里相邻、只能靠 Tooltip 分辨。注册新图标要动 `web/src/ui/**`，不在本刀范围。
10. Radix 的 Escape 监听从抽屉层交到预览层要等一轮渲染（`escape-fallback.ts` 记录的 issue 643 类窗口）：jsdom 里预览刚挂载就按 Escape 会把抽屉和预览一起关掉，所以 P7 在按键前让出一个宏任务；Chromium 里脚本在 iframe 一挂上就按 Escape 也只关预览，这个窗口没有复现。

9. 历史还在读取或读取失败时点 `产物面板` 弹的也是「当前任务暂无产物」（此时视图为空）；读取中这句话不够准确，但规格只定义了这一种空态反馈。

12. D9 只凭「活动元素是 `body`」判断，不区分是不是自己那个按钮造成的：两个慢拉取同时在途（转录卡一个、抽屉行一个）时，先结束的那个会拿走焦点，可能落到模态之下的按钮上，影响限于下一次 Tab。
13. 「关闭后焦点归还 `产物面板` 按钮」以按钮仍在为前提：当前会话不在已加载的列表里而视图又没了（列表读取失败时切走）时按钮已卸载，焦点落在 `body`。
14. Safari 点击按钮不聚焦，`open()` 里的 `trigger.focus()` 会触发 Tooltip 的 `onFocus`；抽屉关闭、焦点还给按钮后 `产物面板` 的 Tooltip 会弹出并停留到失焦（与 `重命名` 的归还路径同一模式）。Safari 未验证。
15. 8.2a 提示：抽屉里有两个名为 `关闭` 的按钮，Playwright strict 模式下要按容器（`.ui-drawer-foot`）限定。

16. html 路径关闭预览时的焦点归还走 `web/src/ui/dialog.tsx:40` 的 `focus()`，不带 `preventScroll`：转录里的 html 卡若在预览打开期间被流式顶出视口，关闭预览会把转录滚回卡片并解除贴底跟随（#536 起就有；要修得动 `web/src/ui/**`，不在本刀范围）。

## Seams under test
- jsdom 页面 fixture（顶栏按钮、Drawer、嵌套 Dialog、Toast、路由）。
- stub：`fetch`（快照、空间列表、预览）、SSE 推送、Blob URL 静态方法、`HTMLAnchorElement.prototype.click`、`navigator.clipboard`。
- 静态源码与 CSS 文本（P12）。
