# Design: stop-button（#477）

父设计 D2 已定停止语义，proposal 已列偏离。本文只写落到现有代码时被逼出的约束。行号指当前 master（`b1eb6f0`）。篇幅超出 runbook 的 20–40 行目标，与 #480 先例相当，因为 Required evidence 须逐条可执行。

## Change surface
- **`composer.tsx`**（82 → ≤130）：
  - 新增 props `onStop: () => Promise<"stopping" | null>` 与 `stopSessionId: string | null`（名字可调，语义不可调）。
  - `generating` 为假：toolbar 与现状逐字相同（`:59-75`）。
  - `generating` 为真：`<p className="chat-composer-pending" role="status">生成中</p>`（`:61-63`）原样保留，后面是一个非导出组件 `StopButton`，替换发送键。
    - `StopButton` 渲染 `Button variant="primary" size="icon" type="button"`，aria-label 与 `title` 均为 `停止`，子元素 `<Icon name="square" />`。可沿用 `chat-send` 类取得圆形与右对齐，也可新增类。
    - 组件自持 `const [pending, setPending] = useState(false)`，`disabled={pending || stopSessionId === null}`。
    - 点击：`setPending(true)`，再执行 `void onStop().then((r) => { if (r === "stopping") toast.show({ type: "info", message: "已停止生成" }); setPending(false); })`。组件卸载后 setState 为空操作（React 19）。
    - 以 `key={stopSessionId ?? ""}` 渲染：切换会话即得到新的、未禁用的按钮（S7）。回合结束时按钮随 `generating` 变假而卸载，状态自然清零。
  - C5 守卫（`chat-composer.test.tsx:187-196`）的约束：文件中第一个 `<Button` 标签不含 `role`；`role=` 次数等于 `role="status"` 次数。新按钮两条都不能破坏。
- **`turn-actions.ts`**（268 → ≤310）：在 `useTurnActions` 内新增 `stopTurn = useCallback((): Promise<"stopping" | null>)`，并加入返回对象（`:267`）。
  - 流程：
    1. 读取 `ownedClient = clientRef.current` 与 `sessionId = requestedSessionRef.current`。`sessionId` 为 null 时 resolve `null`。
    2. `setPromptError(null)`。
    3. 调 `ownedClient.stopSession(sessionId)`，不传 signal。stop 是写操作，不中止它。
    4. 结果处理，先过围栏，再按结果分支：
       - 围栏复用现有 `ownsAnswer`（`:215-221`，可改名为通用名，但不得复制一份，jscpd）；不属于当前会话/账号/挂载时 resolve `null`，不写任何 UI；
       - `"stopping"` → resolve `"stopping"`；
       - `"idle"` → resolve `null`，不写视图，不发 GET（proposal 偏离 3）；
       - `isUnauthorized` → resolve `null`；
       - 其它错误 → `setPromptError({ client: ownedClient, sessionId, message: errorMessage(error) })`，resolve `null`。
    - 返回的 Promise 永不 reject。
  - **不调用** `abortMutation`、`closeSource`、`installSnapshot`、`openSource`、`refreshList`，也不写 `mutationControllerRef`/`mutationGenerationRef`/`setSubmitting`/`setMutationOwner`/`setHistoryState`。不新增 `TurnActionDeps` 成员。
- **`conversation-view.tsx`**（184 → ≤215）：
  - `ConversationViewProps` 加 `onStop`，经 `Composer` 传下，`stopSessionId={requestedSessionId}`。
  - `MessageArticle` 助手分支：
    - `.chat-md` 内，`message.status === "stopped" && message.content === ""` 时渲染占位 `（已停止生成）`（纯文本元素），否则照旧渲染 `MarkdownView`。`message.content` 保持 `""`，所以 `:102-104` 的复制规则照旧不给空正文出按钮；
    - `message.status === "stopped"` 时，在 `{error}` 之后、操作条之前渲染徽章 `<p role="status" aria-label="助手消息 已停止" className=…>已停止</p>`。徽章与步骤卡的相对位置不作断言，留给 8.2b。
- **`page.tsx`**（621 → ≤626）：`:314` 解构加 `stopTurn`；`:605-618` 给 `ConversationView` 加 `onStop={stopTurn}`。其余不动，不搬 `createAndSelect`/`submitComposer`（carry-forward :76）。
- **`icon.tsx`**：import `Square`、`RefreshCw`、`GitBranch`，映射加 `square`、`"refresh-cw"`、`"git-branch"`。
- **CSS**（proposal 偏离 1），只用语义 token：
  - `chat.css` 加 `.chat-session-dot-stopped`（`--wb-text-secondary`）与停止键样式（若不复用 `chat-send`）；
  - `messages.css` 加 `.chat-step-status-stopped`（`color: var(--wb-text-secondary)`，demo:458 `.st-stop`）、消息徽章与占位样式。

## Governing invariant
停止键只在 `generating` 期间出现，只在两种情况下禁用：没有选中会话，或它自己的 stop 请求在途。composer 解锁与一切 `已停止` 呈现只来自权威状态（`turn.end stopped` 或快照），从不来自 stop 的响应本身。stop 请求不触碰 prompt 的 mutation fence。

## Must preserve
- `<p className="chat-composer-pending" role="status">生成中</p>` 原样（`composer.tsx:61-63`）。依赖它的有：e2e `ui-walk-approval.ts:11-16`、`ui-shots.mjs:256-260`；`chat-page.test.tsx:134/169`、`chat-page-ownership.test.tsx:286/318`、`chat-page-ownership-gaps.test.tsx:176`、`chat-approval-bar.test.tsx:209` 的 `getByText("生成中")`。
- 非 running 时的发送键不变：aria-label `发送`、`type="submit"`、`Icon send`、类 `chat-send`、表单内恰一个按钮（C2 `chat-composer.test.tsx:77-110`）。
- 锁定判定 `generating`（`page.tsx:581-587`）与 `sendDisabled`（`:587`）不变。停止键从不改变 `generating`。
- `dispatchPrompt` 的 fence（`turn-actions.ts:138-212`）不变；`answerApproval` 不变。
- `turn-actions.ts` 不含 `useState(`、`useEffect(`、`useRef(`、`useMemo(`，不导入 `./page.js`（`chat-approval-bar.test.tsx:660-665` G2），因此 `useTurnActions` 在 `page.tsx:314` 的调用位置仍与行为无关，carry-forward :77 不被触发。停止键的 hook 属于独立组件，不影响 `ChatPage` 的 hook 次序。
- 助手块结构：avatar 仍是 `article.firstElementChild`，`.chat-md` 在步骤卡之前（`chat-messages.test.tsx:151-179` M4），审批条在 `.chat-md` 之前（#480 A1）。
- `stream.ts` 的 `endTurn` 在 `stopped` 时清空 error（`stream.ts:219`），本刀依赖它，不改。
- `page.tsx` 仍含 `useTopbar(`，不含 `<h1`、`routes/`（`topbar.test.tsx:285-287`）。

## Sibling surfaces
- **必然破坏、允许改动的既有断言（只改期望值，文件不增长）：**
  1. `web/test/chat-composer.test.tsx:122-146`（C3）。改动只有三处：
     - 用例标题可改为「replaces send with 停止 …」；
     - `findByRole("button", { name: "生成中" })` 改为 `{ name: "停止" }`；
     - `expect(pending.disabled).toBe(true)` 改为 `.toBe(false)`（会话已选中）。
     其余行（无 `发送`、status 文本、`precedes(status, pending)`、`turn.end` 后 `发送` 回来、status 消失）不动。
  2. `web/test/chat-composer.test.tsx:189`（C5）needle 数组中的 `'"生成中"'` 改为 `"生成中"`。发送键 aria-label 不再有条件分支，源码里不再有带引号的 `"生成中"`，只剩 JSX 文本。其余 needle 与断言不动。
  3. `web/test/chat-page-lifecycle.test.tsx:357`：`{ name: "生成中" }` 改为 `{ name: "停止" }`；`disabled` 仍为 `true`（proposal 偏离 4：欢迎态建会话途中无会话 id），随后的 click 与 `creates === 1` 不动。
  - 实现后若 `npm test`/`make typecheck` 暴露清单外的破坏，停下上报，不改其它既有测试。
- 约束新代码、且恒绿的既有守卫：`ui-guardrails.test.ts:46-57`（无字面颜色、无 `--wb-palette-`）与 `:92-107`（无 `ui-button`）；`chat-messages.test.tsx:200-215`（无 `innerHTML`、`messages.css` 无字面颜色）；C4 `chat-composer.test.tsx:150-184`（圆点类名 `chat-session-dot-<status>`）；`chat-stream-stopped.test.ts:175`（`已停止` 标签）；`ui-icon-brand.test.tsx`（既有名渲染）。
- 生产消费者：`index.ts` 导出面不变；e2e 只取 `生成中` status（见 Must preserve）；8.2b 的 ui-walk 停止走查归 #484。

## Seams under test
- 新建 `web/test/chat-stop-button.test.tsx`（≤800 行），全部走页面级：
  - `renderChatPage("/?session=${SESSION_ID}", routes)`（`chat-page-support.tsx:24`）；
  - 事件经 `latestSource()` 的 `emitOpen()`、`emitData(type, "1:n", payload)`、`emitGap()` 送入（`chat-stream-support.ts:175-190`）。
- 快照由本文件自建：展开 `chatSnapshot(...)`（`chat-stream-support.ts:50`）后替换 `session.status`/`messages`；`stopped` 值直接写在对象字面量里。`chat-stream-support.ts` 不改。messages 路由在初次加载、每次 `emitOpen`/`emitGap`、受理对账时各命中一次，所以用闭包变量按阶段返回快照（#480 先例）。
- 请求断言：`calls(fetchMock, "/api/sessions/${SESSION_ID}/stop")`（`support.ts:139`），核对 `init.method === "POST"` 且 `init.body === undefined`。
- 在途断言用 `deferredResponse()`（`support.ts:27`），在 resolve **之前**断言禁用（#480 A3 先例）。
- Toast 取 `within(screen.getByRole("region", { name: "通知" }))`（`chat-copy.test.tsx:54`）。不 fake 计时器。
- 切会话：点侧栏另一会话按钮；常量可取自 `chat-page-ownership-support.ts`（`OTHER_SESSION_ID`/`OTHER_MESSAGES`），先例是 #480 A12。
- 源码与 CSS 守卫：`readRepoFile`、`listRepoFiles`、`ruleBody`、`stripComments`（`ui-support.ts`）。

## Required evidence
running 快照 R：会话 `saved title` running。消息为 `historyUser` 加助手 id 0（running，content `""`），助手带一条 running `bash` 步骤 `{id:11,ordinal:0,detail:'{"command":"sleep 9"}',output:""}`，cursor `1:0`。加载后 `emitOpen`，事件序号从 `1:1` 起。`STOP = /api/sessions/${SESSION_ID}/stop`。

| ID | 输入 | 期望 |
|---|---|---|
| S1 布局（红） | R | 表单 toolbar 内无 `发送`；恰一个按钮，为 `停止`：可用、`type="button"`、`title="停止"`、类含 `ui-btn--primary`、内含 `svg.lucide-square`；toolbar 内 `role=status` 文本 `生成中` 在按钮之前；textarea `disabled` |
| S2 202 与终态（红） | R；STOP 用 `deferredResponse`；连续两次 `fireEvent.click(停止)`（各自 act），resolve 前断言；resolve 202 `{}`；再 `turn.end{0,"stopped"}`；然后输入 `继续` 发送（prompt 202 `{userMessageId:1,assistantMessageId:2}`） | resolve 前：STOP 调用恰 1 次，POST 且无 body；按钮 `disabled`；prompt 路径 0 次调用（按钮不是 submit）。resolve 后：`通知` region 含 `已停止生成`；textarea 仍禁用。`turn.end` 后：toolbar 回到 `发送`，无 `停止`，无 `生成中`；助手 article 内 `getByRole("status",{name:"助手消息 已停止"})` 文本 `已停止`；article 内无 `role=alert`；正文区文本 `（已停止生成）`，无 `ui-caret`；步骤 `role=status` 名 `bash 已停止`；侧栏 `saved title 已停止`，圆点类含 `chat-session-dot-stopped`。发送：prompt 恰 1 次，受理对账照常（messages GET +1、新 source） |
| S3 204 被动（红） | R；点 `停止` → 204 | 无 `已停止生成` Toast；无 `role=alert`；`停止` 恢复可用；textarea 仍禁用；侧栏仍 `saved title 运行中`；`ui-caret` 仍在；messages GET 次数与点击前相等（无对账）。随后 messages 路由改回 done 快照（会话与助手 done、content `完`），`emitGap()` → toolbar 回到 `发送`，无 `已停止` 徽章 |
| S4 S7 类残局（红） | R；点 `停止` → 202 `{}`；不发 `turn.end`；随后 `emitGap()`，重拉快照仍为 R；再点 `停止` → 202 | 首个 202 后：Toast 出现；`生成中` 仍在；textarea 仍禁用；`停止` **可用**。gap 重装后仍可用；第二次点击后 STOP 调用共 2 次（「保持禁用直到 `turn.end`」的变异 → 红） |
| S5 错误信封（红） | R；点 `停止` → 502 `{error:{code:"agent_unavailable",message:"Agent 运行时不可用"}}`；再点 → STOP 挂起 | 第一次：`role=alert` 文本 `Agent 运行时不可用`；无 Toast；`停止` 恢复可用；textarea 仍禁用。第二次点击时 alert 立即消失（点击时 `setPromptError(null)`），STOP 调用共 2 次 |
| S6 pending 审批下停止（红） | R 后 `approval.request{messageId:0,approvalId:7,tool:"bash",title:"Allow tool: bash",expiresAt:now+60000}`；点 `停止` → 202；`approval.resolved{0,7,"deny"}`；`turn.end{0,"stopped"}` | 审批条 `需要你的确认` 可见、按钮可用时，`停止` 可用且 textarea 禁用（「有 pending 审批时 `停止` 可用」）；点击后 STOP 恰 1 次；resolved 后条为 `已拒绝执行`；`turn.end` 后徽章 `助手消息 已停止` 出现，composer 回到 `发送` |
| S7 会话围栏（红） | A=R；STOP_A 挂起；点 `停止`；切到同样 running 的会话 B；再令 STOP_A 返回 202；另一轮令 STOP_A 返回 502 | 切到 B 后 B 的 `停止` 可用（按会话 key，不继承 A 的在途禁用）；点击 B 只发 B 的 stop 路径。A 迟到的 202 → 无 Toast；A 迟到的 502 → 无 `role=alert` |
| S8 不动 prompt fence（红） | done 会话；输入 `继续` 发送，prompt POST 挂起；此时 `停止` 可用，点击 → 202；再令 prompt 202 `{userMessageId:1,assistantMessageId:2}` | prompt 的受理对账照常：messages GET +1、安装快照、新建 source。「stop 调 `abortMutation`」的变异 → 对账不发生 → 红 |
| S9 无会话（红） | 欢迎态输入 `hi` 发送，create POST 挂起 | toolbar 内 `停止` 存在且 `disabled`；点击不产生任何 `/stop` 请求；`生成中` 在 |
| S10 快照矩阵（红） | 快照：会话 `failed`；消息依次为 u、a1（stopped，`部分回答`，步骤 `bash` stopped）、u、a2（stopped，`""`）、u、a3（done，`完成回答`）、u、a4（failed，`""`） | 四个助手 article 中，名 `助手消息 已停止` 的 status 个数依次为 1、1、0、0；`（已停止生成）` 只出现在 a2；a1 正文 `部分回答`、无占位；a1/a2 内无 `role=alert`；a1 有 `复制`，a2 无 `复制`（占位没写进 content）；a1 的徽章跟在 `.chat-md` 之后、`.chat-msg-actions` 之前（`compareDocumentPosition`）；侧栏 `saved title 失败`；步骤 `bash 已停止`；toolbar 为 `发送`、无 `生成中` |
| S11 图标注册（红） | 分别渲染 `<Icon name="square"/>`、`"refresh-cw"`、`"git-branch"` | 各恰一个 svg，类分别含 `lucide-square`、`lucide-refresh-cw`、`lucide-git-branch` |
| S12 容量（守卫，预计 master 绿） | done 会话；输入 `重试一下` 发送；prompt → 503 `{error:{code:"agent_capacity",message:"Agent 容量已满，请稍后重试"}}` | `role=alert` 文本恰为信封 message；article 数不变（2）；textarea 可用且值为 `重试一下`；`发送` 可用；无 `停止`；messages GET 次数不变 |
| S13 CSS（红） | `ruleBody(stripComments(css), sel)`：`chat.css` 的 `.chat-session-dot-stopped`、`messages.css` 的 `.chat-step-status-stopped` | 两条规则都存在，且值只含 `var(--wb-` |
| G1 hook 守卫（恒绿） | 既有 `chat-approval-bar.test.tsx:660-665` G2 | 仍绿；本文件不复制该守卫 |
| G2 composer 静态契约（按 allowed-edit 2 后恒绿） | 既有 C5 | 仍绿 |
| G3 既有套件（恒绿） | `npm test --workspace web` | 除 allowed-edit 三处外零 diff 全绿 |
| G4 文案单一来源（恒绿） | `listRepoFiles("web/src", ts/tsx)` 逐个读取 | 无文件含 `容量已满`（文案只来自信封） |

**Scenario → 证据映射**：
- chat-web「停止生成」→ S1、S2、S3；「助手消息级已停止呈现」→ S10、S2（空正文实时路径）；「审批条挂起、允许与拒绝」的 `停止` 可用 → S6；「容量已满内联提示」→ S12、G4。
- turn-control「停止按钮与文案」→ S2；「容量文案」→ S12。
- tool-approval「web 审批条」末句 → S6。

**红/绿**：S1–S11 与 S13 先对 master 跑红，记录失败输出。S12、G1–G4 为守卫：S12 若在 master 上为红，改标红先行，并记入 PR body。下列变异逐一临时施加，确认对应用例变红，并把结果记入 PR body：
- 202 后保持禁用直到 `turn.end` → S4；
- 204 时对账 GET、写入视图或出 Toast → S3；
- stop 调 `abortMutation` 或写 mutation 状态 → S8；
- 按钮 `type="submit"` → S1（`type="button"` 断言；S2 抓不到：R 状态下 textarea 禁用、草稿为空，`submitComposer` 空草稿直接 return，`page.tsx:514-521`）；
- 去掉结果围栏 → S7；
- 按钮不按会话 key：jsdom 中不变红（切会话时有一帧 `ownsHistory` 为假，`StopButton` 卸载、`pending` 清零，`ownership.ts:22-32`），`key` 属防御性写法，靠代码审查；S7 的行为断言保留；
- 占位写进 content → S10（a2 出现 `复制`）；
- 徽章不按 status 判断（done/failed 也渲染）→ S10；
- 无会话时不禁用 → S9。

## Non-goals
见 proposal Non-goals。

## Review focus
1. 不存在持久「停止中」状态：禁用只覆盖在途请求，任何响应后若仍 running 即可再点（S4）；解锁与 `已停止` 只来自权威状态。
2. 204 不写视图、不对账（S3）；`"idle"` 字面量不出现在任何 `setHistoryState`/视图写路径。
3. stop handler 只复用 `ownsAnswer` 围栏，不碰 prompt fence，不给 `turn-actions.ts` 加 hook 状态（S7、S8、G1）。
4. 停止键 `type="button"`、按会话 key、无会话时禁用；`生成中` status 元素原样（S1、S2、S7、S9，e2e 锚点）。
5. 占位只是呈现，content 不变；徽章只给 `stopped`；CSS 只用 token；allowed-edit 之外的既有测试零 diff（S10、S13、G3）。
