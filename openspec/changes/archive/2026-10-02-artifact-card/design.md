# Design: artifact-card（#536）

## Context
- `web/src/features/chat/stream-artifacts.ts`（50 行）：`summarizeChanges(steps)` 给出一条消息的去重变更行（已结束步骤、位置取首次、值取最后）。
- `file-changes-card.tsx`（71 行）：`<fieldset aria-labelledby>`，图标按钮写法 `Button size="icon" variant="ghost" className="chat-msg-action"`（`aria-label` 与 `title` 同文）。
- `conversation-view.tsx`（274 行）：`MessageArticle` 在 `{error}` 之后渲染 `<FileChangesCard>`，再是 `已停止` 徽章与操作行；`workspace: Workspace | null` 已传到 `MessageArticle`。`MessageArticle` 是 `memo`。
- `page.tsx`（689 行）：`client = useMemo(() => createSessionClient(), [createSessionClient])`（`:57`）；`ChatPage` 的认知复杂度已在 Biome 上限 15。
- `web/src/lib/api.ts`：`fetchPreview(workspaceId, path, { signal })`（`:140`、`:632`）返回 `{kind:"text", text, size, truncated}` 或 `{kind:"image", url, size, truncated}`；`url` 是 `URL.createObjectURL` 建的 Blob URL，归调用方撤销（`:459`）；`truncated` 取自响应头 `X-Workbuddy-Truncated: 1`（`:412`）。类型 `FilePreview` 不导出，按 `web/src/features/files/preview.tsx:15` 的写法取 `Awaited<ReturnType<ApiClient["fetchPreview"]>>`。失败抛 `ApiError`；401 时 client 自己通知未登录。
- 服务端 `server/src/workspaces/preview.ts:31-52`：文本类超过上限截断并带标记；图片超过上限直接报 `preview_too_large`，**图片不会被截断**；其它扩展名报 `preview_unsupported`。可预览集合与 `web/src/features/files/tree.tsx:69-82` 一致。
- `chat/errors.ts`：`errorMessage(error)`（`ApiError` → 信封 message，否则 `请求失败，请稍后重试`）、`isUnauthorized(error)`。
- `Dialog`（`web/src/ui/dialog.tsx`）：`open`/`onOpenChange`/`title`/`size`（`sm` 400px、`md` 520px）；没有 trigger 时关闭后焦点还给 `returnFocus ?? 打开瞬间的活动元素`（`:37-42`）；Chromium 在按钮 `disabled` 生效的当下把焦点移到 body（`:53-55` 的记录），所以「拉取中禁用、拉取完再开 Dialog」的流程里打开瞬间的活动元素是 body，必须显式传 `returnFocus`；内容经 portal 渲染在 `.chat-msg-main` 之外。
- 图标：`globe`、`download`、`package`、`file-code`、`image`、`copy`、`chevron-right` 均已注册（`web/src/ui/icon.tsx`）；demo 用的 `externalLink`/`arrowUpRight` 没有注册。
- 颜色守卫（`web/test/ui-guardrails.test.ts:46-57`）：features 下的 `.css`/`.tsx` 不许出现 hex/`rgb()`/`rgba()` 字面量（注释也算）与 `--wb-palette-*`。
- 既有测试 `web/test/chat-page-file-changes.test.tsx` 的 C13：对 `.chat-msg-main` 的全子元素做 `toEqual`，夹具路径 `out/index.html`、空间可解析。support 的 `cards()` 选 `.file-changes-card`，G5 用 `[class*="file-change"]`。
- demo：`resource/workbuddy-live-demo.html:502-515`（样式）、`:2419-2466`（结构）。

## Decisions

### D1 `artifactKind(path)`（`stream-artifacts.ts`，纯函数、导出）
```ts
type Artifact = { kind: "html" | "image" | "code"; label: string; name: string };
export function artifactKind(path: string): Artifact | null
```
`name` 是最后一个 `/` 之后的末段；扩展名是 `name` 里最后一个 `.` 之后的部分，转小写后查表：`html` → `html`/`HTML`；`png` → `image`/`PNG`；`jpg`、`jpeg` → `image`/`JPG`；`md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx` → `code`/扩展名大写。没有 `.`、唯一的 `.` 在开头（`.html`、`.env`：服务端用 Node `extname` 取扩展名，对这类名字是空串，预览必然 `preview_unsupported`）、`.` 在末尾、或扩展名不在表里 → `null`。`.config.json` 的最后一个 `.` 不在开头，照常派生 JSON。

### D2 组件拆分（`artifact-card.tsx`）
- `ArtifactCards({ client, steps, workspace })`：**不调任何 hook**。`workspace === null` 返回 `null`；否则 `summarizeChanges(steps)` 逐项取 `artifactKind(change.path)`，为非 `null` 的每一项渲染 `<ArtifactCard key={change.path} … />`（次序即汇总次序）。没有可派生项时什么都不渲染（不留容器）。
- `ArtifactCard({ artifact, client, path, workspaceId })`：持有全部 hook，永不提前返回，所以没有 hook 次序问题。
- 只导出 `ArtifactCards`。

### D3 单张卡的结构
`<fieldset aria-labelledby={headId} className="artifact-card">`（隐含 role `group`，名字是文件名）：
- 卡头 `div.artifact-head`：`span.artifact-file-icon artifact-file-icon--<kind>`（`Icon globe` / `image` / `file-code`）、`span.artifact-title#headId`（文件名）、`span.artifact-lang`（标签）、操作按钮（图标按钮，`aria-label` 与 `title` 为 `<动作> <文件名>`）：html → `打开网页预览`（`Icon chevron-right`；demo 的图标没注册）、image → `下载`（`Icon download`）、code → `复制代码`（`Icon copy`）。
- 只有 html 有卡脚 `div.artifact-foot`：文本 `可交互预览` 与一个 `<button type="button" className="artifact-link" aria-label="打开网页预览 <文件名>">打开网页预览</button>`，与卡头按钮同一个处理函数。
- 卡片里没有 iframe、没有图片、没有代码正文，也没有 `在编辑器中打开`。
- 类名都不含 `file-change`。
- html 的预览 Dialog 由这张卡自己持有：`<Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }} returnFocus={opener} size="md" title={artifact.name}>`（`opener` 是这张卡的 `useRef<HTMLButtonElement | null>`，记下被点的那个按钮，见 D4），内容为可选的截断提示 `p.artifact-preview-note`（`文件超过 1 MiB，仅预览前 1 MiB`）在前，`<iframe className="artifact-preview-frame" sandbox="allow-scripts" srcDoc={preview.text} title={artifact.name} />` 在后。`sandbox` 是写死的字符串字面量。三类卡都挂着这个 Dialog（关闭时不产生 DOM），只有 html 卡会 `setPreview` 打开它。

### D4 拉取纪律（本刀的重点，照此实现）
```tsx
const controller = useRef<AbortController | null>(null);
const [busy, setBusy] = useState(false);
useEffect(() => () => controller.current?.abort(), []);

async function run() {
  if (controller.current) return;                 // 拉取中：不发第二个请求
  const own = new AbortController();
  controller.current = own;
  setBusy(true);
  try {
    const result = await client.fetchPreview(workspaceId, path, { signal: own.signal });
    if (own.signal.aborted) {                     // 卸载之后才回来
      discard(result);                            // 图片则撤销其 Blob URL
      return;
    }
    await deliver(result);
  } catch (error) {
    if (!own.signal.aborted && !isUnauthorized(error)) {
      toast.show({ type: "error", message: errorMessage(error) });
    }
  } finally {
    if (!own.signal.aborted) {
      controller.current = null;
      setBusy(false);
    }
  }
}
```
`discard(result)` 是模块级小函数（`if (result.kind === "image") URL.revokeObjectURL(result.url)`），「卸载之后才回来」与「类型不符」两处共用：把这个判断内联在 `run()` 里时 Biome 报认知复杂度 16 > 15（`make lint` 退出 2），提出来之后行为不变。

按钮的 `onClick={(event) => { opener.current = event.currentTarget; void run(); }}`（html 的两个按钮共用；关闭预览后焦点回到被点的那个）；`busy` 时这张卡的所有操作按钮 `disabled`（html 有两个）。

`deliver(result)`：
- 类型不符（图片卡拿到文本，或 html/代码卡拿到图片）：拿到的是图片就先 `URL.revokeObjectURL`，然后 Toast `errorMessage(undefined)`（即 request_failed 的安全文案）；不开 Dialog、不写剪贴板、不下载。
- html：`setPreview({ text: result.text, truncated: result.truncated })`。
- image：建一个 `<a>`，`href = result.url`、`download = artifact.name`，挂到 `document.body`、`click()`、移除；随后 `setTimeout(() => URL.revokeObjectURL(result.url), 0)`。撤销延后一个宏任务：点击后同步撤销在部分浏览器里会让下载拿不到内容；定时器不随卸载取消，所以卸载后照样撤销。图片不会被截断（Context），不设截断分支。
- code：`result.truncated` → Toast（error）`文件过大，无法复制`，不碰剪贴板；否则 `try { await navigator.clipboard.writeText(result.text); toast success 已复制到剪贴板 } catch { toast error 复制失败 }`（剪贴板不存在时取属性即抛，落进同一个 `catch`）。

路径走查：
- 点击前：没有任何 `/file` 请求（不预取）。
- 拉取中再点：`controller.current` 非空，直接返回；按钮本就禁用。真实的两次点击是两个离散事件，React 各自同步提交，禁用在第二次点击之前已生效；这道门是防御性的（保证一张卡任何时刻只有一个 controller），只有在同一个 `act` 批里连点卡头与卡脚两个按钮（禁用尚未提交）时才由它拦住第二个请求，A10 有这一例。
- 失败（404/415/413/网络）：`catch` 出 Toast，`finally` 复位，可再点。401：不出 Toast（client 已通知未登录）。
- 卸载、切换会话、换账号：三者都会卸载消息列表（`FollowTranscript` 以会话 id 为 key；换账号时历史不再属于当前 client），清理函数 abort。之后真实的 `fetch` 拒绝，`api.ts:468-473` 把它包成 `ApiError(request_failed)` → `catch` 里 `aborted` 为真，不出 Toast（没有这个判断就会弹 `请求失败，请稍后重试`）；若响应已经回来（Blob URL 已建）→ 走「卸载之后才回来」分支撤销。`finally` 不再 `setState`。
- 整个处理函数经 `void run()` 调用，内部 `try/catch` 包住全部 await，不留下未处理拒绝。

### D5 接线
- `page.tsx`：`<ConversationView client={client} …>`，+1 行（689 → 690，无运算符）。`client` 引用稳定，`MessageArticle` 的 `memo` 不失效。
- `conversation-view.tsx`：`client` 经 `ConversationView` → `MessageThread` → `MessageArticle`；助手分支在 `<FileChangesCard>` 之后、`已停止` 徽章之前渲染 `<ArtifactCards client={client} steps={message.steps} workspace={workspace} />`。user 分支不渲染。`ArtifactCards` 自己再算一次 `summarizeChanges`（纯函数），不改 `FileChangesCard`。

### D6 样式（`messages.css`，590 行）
按 demo:502-515，颜色只用既有语义 token：卡片同文件变更卡的边框/圆角/底色，带 fieldset 复位（`.artifact-card` 并入 `.file-changes-card` 那条规则的选择器，不另抄一块）；卡头 `display: flex; align-items: center; gap: 8px; padding: 9px 12px`（卡头自己不带底边：卡片不内嵌预览，卡头下面只可能是卡脚，分隔线只画卡脚的顶边一条）；图标块 22×22、圆角 6px，html 用 `--wb-status-warning-soft-bg` + `--wb-status-warning-text`，代码用 `--wb-brand-primary-subtle` + `--wb-brand-primary`，图片用 `--wb-bg-tertiary` + `--wb-text-secondary`（proposal 偏差 6）；标题等宽、13px、600、`flex: 1; min-width: 0` 加省略号；标签 10.5px、次要文字色、1px 边框、圆角 4px；卡脚 `padding: 8px 12px; border-top; font-size: 12px`，链接按钮无底无边、`--wb-brand-primary-deep`（demo:515 的取值）、`margin-left: auto`、hover 下划线、`:disabled` 时不可点的样式。预览 iframe：`display: block; width: 100%; height: 60vh; border: 0; background: white`——取回的网页默认按白底写，深色主题下透明的 iframe 会让默认的黑字落在深色对话框上；这里用 CSS 关键字 `white`（不是字面 hex，守卫不拦，也没有「恒为白色的背景」语义 token）。不写 `transition`、`outline`。`chat.css` 不动。

### D7 既有测试的改动
`web/test/chat-page-file-changes.test.tsx` 的 C13 共三处：`:673-681`、`:703-709` 两份期望列表各插入产物卡一项（`fieldset.artifact-card`，在文件变更卡之后）；`:684` 的 `已停止` 徽章下标 `parts[5]` → `parts[6]`。若还有别的既有用例因产物卡出现而变红，停下报告。

## Governing invariant
1. 文件内容只在用户点了产物卡的操作之后才拉取，请求只用会话空间 id 与空间内相对路径。
2. 取回的 HTML 只进 `sandbox` 恰为 `allow-scripts` 的 `srcdoc` iframe，不进应用自己的 DOM。
3. 本卡拿到的每个 Blob URL 恰撤销一次（下载后、类型不符、卸载后才回来，三条路径各自撤销）。
4. 每张卡至多一个在途拉取；卸载即 abort，被 abort 的拉取不再产生任何 UI 副作用（Toast、Dialog、剪贴板、下载）。拉取已完成、正在等剪贴板写入时卸载不在此列：写入照常完成并出 Toast（复制确实发生了）。

## Sibling surfaces
- `FileChangesCard`：共用 `summarizeChanges` 与「空间可解析」规则；两者对同一条消息必须给出同一批路径、同一次序（A2、A14）。
- 7.6 产物面板（未落地）：会复用 `artifactKind` 与同名操作；本刀只导出 `artifactKind`，不提前抽公共组件。
- `web/src/features/files/tree.tsx:346,491`：files feature 自己持有并撤销预览 Blob URL，与本卡互不共享 URL；`fetchPreview` 不改。
- `web/src/ui/dialog.tsx` 的焦点归还（`returnFocus`）：只消费，不改。
- `web/test/chat-page-file-changes.test.tsx` C13 的全子元素断言（D7）。

## Must-preserve
- 文件变更卡的内容、降级与位置；折叠块、审批条、步骤卡、错误、`已停止` 徽章、操作行的行为与相对次序；`复制` 只复制正文。
- `fetchPreview`、`summarizeChanges` 不改；files feature 的预览不受影响。

## Required evidence（`web/test/chat-page-artifact-card.test.tsx`）
页面级搭法与夹具从 `chat-page-file-changes-support.tsx` 导入（不改它）。jsdom 的接缝：`URL.createObjectURL`/`revokeObjectURL` 在 jsdom 里没有实现，按 `web/test/files-fixture.tsx:153-175` 的 `stubBlobUrls` 写法 stub（`Object.defineProperties(URL, …)` 只补这两个静态方法并在 `afterEach` 还原；**不要**照 `api-files.test.ts:222` 的 `vi.stubGlobal("URL", {...})` 把 `URL` 整个换掉，页面级测试里 `new URL()` 会失效）。能直接导入就导入，不要照抄出 jscpd 克隆；`<a>` 的点击 spy `HTMLAnchorElement.prototype.click`（jsdom 的导航未实现）并在 spy 里读 `href`/`download`；剪贴板的三种状态沿用 `chat-copy.test.tsx` 的 stub；挂起的响应用 `deferredResponse`；未处理拒绝用 `observeUnhandledRejections`；文本预览响应用 `support.ts` 的 `textPreviewResponse`。

- A1 `artifactKind` 表：`out/index.html` → html/`HTML`/`index.html`；`assets/chart.PNG` → image/`PNG`/`chart.PNG`；`a.jpg`、`b.JPEG` → image/`JPG`；`md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx` 各一 → code/大写扩展名；`main.py`、`Makefile`、`a.tar.gz`、`trailing.`、`dir.html/readme` → `null`。
- A2 派生与不预取：一条消息的变更为 `src/app.ts`（edit）、`main.py`、`out/index.html`、`assets/chart.PNG` → 文件变更卡四行；其后按汇总次序恰有三张产物卡，group 名为 `app.ts`、`index.html`、`chart.PNG`，标签 `TS`、`HTML`、`PNG`；此时对 `/file` 的请求数为 0；页面 `innerHTML` 不含空间绝对根；没有 `在编辑器中打开`；卡片内没有 iframe 与 img。
- A3 html（Scenario「html 预览隔离」）：有两个名为 `打开网页预览 index.html` 的按钮、卡脚文本含 `可交互预览`；点卡头那个 → 恰一次 `GET /api/workspaces/<空间 id>/file?path=out%2Findex.html`；出现标题 `index.html` 的 dialog，内有 iframe，其 `getAttribute("sandbox")` 恰为 `allow-scripts`、`srcdoc` 恰为取回文本、`title` 为 `index.html`；没有截断提示。关闭 Dialog 后 iframe 消失。另一例**不预先 focus**，用 `fireEvent.click` 点卡脚那个按钮同样打开；点 `关闭` 后（`await waitFor`：Radix 在卸载后的定时器里归还焦点，先例 `web/test/ui-dialog.test.tsx:323-331`）`document.activeElement` 是卡脚那个按钮（不是卡头那个，也不是 body）。
- A4 截断：预览响应带 `X-Workbuddy-Truncated: 1` → dialog 内 `文件超过 1 MiB，仅预览前 1 MiB` 在 iframe 之前（文档顺序）。
- A5 图片（Scenario「图片下载与代码复制」）：点 `下载 chart.PNG` → 请求的 `path` 为 `assets/chart.PNG`；`click` spy 恰被调用一次，当时该 `<a>` 的 `download` 为 `chart.PNG`、`href` 为 stub 返回的 Blob URL；`revokeObjectURL` 在点击那一刻尚未被调用，`click` 返回之后的同一个宏任务内也尚未被调用（spy 里 `setTimeout(采样, 0)`：它先于实现的定时器入队，同延时先进先出，采到的调用数为 0），一个宏任务之后以该 URL 被调用恰一次；临时链接不留在文档里。
- A6 代码：点 `复制代码 app.ts` → `clipboard.writeText` 的参数恰为预览文本；Toast `已复制到剪贴板`。
- A7 代码的失败分支：剪贴板不存在、`writeText` 同步抛错、返回 rejected promise → 三者都是 Toast `复制失败`；预览截断 → `writeText` 未被调用、Toast `文件过大，无法复制`。
- A8 预览失败（Scenario「不派生与失败」）：`复制代码 gone.md` 得 404 信封 → Toast 为信封 message，`writeText` 未被调用，没有 dialog，无未处理拒绝；按钮恢复可点，再点会发第二个请求。html 卡得 415 → Toast 信封 message、没有 dialog。图片卡得 413 → Toast、`click` spy 未被调用。`fetch` 拒绝（网络错误）→ Toast `请求失败，请稍后重试`。
- A9 类型不符：代码卡拿到图片响应 → `revokeObjectURL` 以该 URL 被调用、Toast `请求失败，请稍后重试`、`writeText` 未被调用；图片卡拿到文本响应 → Toast、`click` spy 未被调用；html 卡拿到图片响应 → 没有 dialog、URL 被撤销。
- A10 拉取中（Scenario「拉取中与卸载」前半）：响应挂起时，这张 html 卡的两个按钮都 `disabled`，另一张卡的按钮仍可点；对已禁用按钮再 `fireEvent.click` 不产生第二个请求；另一例在同一个 `act` 批里连点卡头与卡脚按钮，只发一个请求（杀「单独去门」）；响应返回后两个按钮恢复。
- A11 卸载与切换会话（Scenario 后半）：图片预览挂起时切到另一个会话 → 该请求的 `signal.aborted` 为真；随后让挂起的响应以图片返回 → `revokeObjectURL` 以该 URL 被调用，`click` spy 未被调用，没有任何 Toast。代码预览（`复制代码 app.ts`）挂起时切会话，随后文本返回 → `writeText` 未被调用、没有任何 Toast。再一例走拒绝路径：fetch 路由用 resolver 返回一个在 `options.signal` abort 时拒绝的 promise（真实 `fetch` 的行为；`deferredResponse` 只有 `resolve`），点 `复制代码 app.ts` 后切会话 → 没有任何 Toast、无未处理拒绝。
- A12 换账号与 401：预览挂起时换账号（`renderChatPageWithAuthProbe` + `renewAccount`；该搭法默认的 `/api/workspaces` 返回 `[]`，要覆盖成含会话空间的列表，否则没有卡可点）→ 请求被 abort、无 Toast；预览得 401 → 不出错误 Toast。
- A13 次序（Scenario「助手块次序」）：`stopped` 助手消息带 `thinking`、一条已结算审批、正文 `部分回答`、带 `out/index.html` 变更的已结束 `write` 步骤、空间可解析 → `.chat-msg-main` 的**全部**子元素按序为 `details.thinking-block`、`div.chat-approvals`、`.chat-md`、步骤卡、`fieldset.file-changes-card`、`fieldset.artifact-card`、`已停止` 徽章、操作行；`复制` 的参数恰为 `部分回答`。
- A14 不渲染的情形：会话空间不在列表里、会话未绑定、列表读取中、列表读取失败 → 文件变更卡仍在、没有 `.artifact-card`（列表读取成功后出现）；user 消息没有产物卡（夹具照 `chat-page-file-changes.test.tsx:714-726` 给 user 消息挂一个已结束、可派生的变更步骤，否则杀不掉「user 消息也渲染」）；running 步骤的变更在 `step.end` 之前没有产物卡、之后出现；只有 `main.py` 的消息没有产物卡。其中「空间不在列表里」「未绑定」「读取失败」「user 消息」「只有 `main.py`」五例只有否定断言，是实现前就成立的护栏（报告里逐条标出）；「读取中 → 读取成功后出现」「`step.end` 之后出现」是带正向对照的 RED 用例。
- 评审后追加（H1–H6，`chat-page-artifact-card.test.tsx` 的 A1 表与新文件 `chat-page-artifact-card-state.test.tsx`）：H1 多点文件名（`vite.config.ts`、`dist/app.min.js`）、深层路径（`web/src/ui/card.tsx` → `card.tsx`）、`.config.json` 派生，`.html`/`dir/.json`/`.env`/尾斜杠/空串为 `null`；H2 同一路径出现在两个已结束步骤 → 每路径一张卡、次序同汇总；H3 关闭后再点会重新拉取，`srcdoc` 是第二次的内容；H4 图片卡、代码卡拉取中按钮禁用；H5 预览打开或挂起期间前面的步骤 `step.end` 插入新卡 → 原卡的 Dialog/请求不受影响（状态随路径走）；H6 拉取已完成、剪贴板写入未落定时切会话 → 写入完成后照常出 `已复制到剪贴板`。
- A15 静态样式：`.artifact-preview-frame` 含 `border: 0`；三种图标块用 D6 列的 token；`chat.css` 不含 `artifact-`（护栏）。

基线运行：测试导入实现前不存在的 `artifactKind`，跑基线时在沙箱里临时给 `stream-artifacts.ts` 加一个抛错的同名导出（不进补丁），让各用例逐例给出红绿；报告里逐条列出基线即绿的护栏。

变异自检（实现者在沙箱里做，做完还原，写进报告；每个至少打红一例）：`sandbox` 改成 `allow-scripts allow-same-origin`；去掉 `sandbox`；挂载时预取；`srcDoc` 换成经 `URL.createObjectURL` 的 `src`；卡片里内嵌 iframe；去掉拉取中的不并发门（`controller.current` 判断）且按钮不禁用；单独去门；`busy` 只禁用被点的那个按钮；卸载时不 abort；卸载后才回来的图片不撤销；迟到检查只管图片（卸载后才回来的文本照样写剪贴板）；不传 `returnFocus`；`returnFocus` 恒指卡头按钮；下载后不撤销；点击前就撤销；`click()` 返回后同步撤销（不延后）；截断的文本照样复制；截断时不显示提示；失败时照样开 Dialog；abort 也出 Toast；401 出 Toast；类型不符的图片不撤销；标签用原始扩展名（`chart.PNG` 的 `PNG` 看不出来，用 `app.ts` → `ts`）；`jpeg` 的标签为 `JPEG`；文件名取整条路径；请求用 `workspace.dir` 或逻辑路径而非空间 id 与相对路径；空间不可解析时照样渲染；产物卡放到文件变更卡之前；放到 `已停止` 徽章之后；user 消息也渲染；计入 running 步骤的变更。

评审第 1 轮后追加的变异 F1–F8（`indexOf(".")`、文件名取第一个 `/` 之后、条件退回 `dot === -1`、不经 `summarizeChanges` 的 `flatMap`、缓存预览不重取、只禁用 html 卡、`key={index}`、卸载后剪贴板完成不出 Toast）分别打红 H1–H6。

## 已知残留
1. #522 合入前服务端不产生 `changes`，产物卡只在快照已带 `changes` 时出现；真实链路与真实浏览器证据归 #522、8.2a。
2. `sandbox="allow-scripts"` 的 iframe 是不透明源：读不到应用的 cookie 与 API 响应，但其中的脚本可以向任意地址发网络请求。没有 `allow-modals`、`allow-popups`、`allow-forms`、`allow-top-navigation`，所以弹窗、开新窗口、提交表单、顶层导航都被禁。站点未设 CSP（父 design Risks）。
3. 预览 Dialog 是 `md`（520px 宽），网页按窄视口排版；`web/src/ui/**` 不在本刀范围。
4. 预览打开期间文件再被改写不会刷新（不存副本、不轮询）；关掉再点才重新拉取。
5. 临时下载链接的撤销延后一个宏任务；极慢的环境下理论上仍可能早于浏览器读取 Blob。实现后在 Chromium（Playwright 自带）里做过一次性观察：下载到的文件与源字节一致；Firefox/Safari 未验证。
6. 一条消息的可派生变更很多时每项一张卡，没有折叠（每步骤至多 50 项）。
7. html 卡头按钮用 `chevron-right`（demo 的 `externalLink` 未注册）。
8. 拉取期间按钮禁用，Chromium 会把焦点移到 body：html 卡由 Dialog 接走焦点、关闭后经 `returnFocus` 还给按钮；图片卡与代码卡完成后焦点留在 body（键盘用户要重新 Tab 回来）。jsdom 不做这个 fixup；实现后的一次性 Chromium 观察确认了这三点（拉取中焦点在 body、html 卡关闭后回到被点的按钮、图片/代码卡完成后留在 body），进 CI 的证据归 8.2a。
9. 焦点进入预览 iframe 之后，Escape 键事件留在 iframe 的文档里，传不到 Dialog；只能用 `关闭` 按钮或点遮罩关闭（Chromium 一次性观察确认）。
10. 同一 client 的空间列表重读失败时 `workspace` 变 `null`（`workspace-list.ts:46-65`），产物卡连同已打开的预览 Dialog 一起卸载，在途的拉取被静默 abort；列表恢复后卡片重新出现。
11. **代码卡的剪贴板写入发生在网络往返之后**，已不在点击手势的同步调用栈里（父规格规定的流程：点击 → 拉取 → `writeText`）。Chromium 一次性观察正常；Safari/WebKit 预期以 `NotAllowedError` 拒绝、每次都落到 `复制失败`，Firefox 在慢网下同样可能失败——两者都未实测。跟进 issue #731。
12. 在途门是单卡粒度：慢网下先后点两张 html 卡，两个预览都会打开并叠成两个模态。
13. 标题、group 名、按钮名都只用末段文件名：一条消息改了 `src/index.ts` 与 `test/index.ts` 时两张卡同名，只能靠与文件变更卡的次序对应来分辨。
14. 「沙箱 iframe 里的脚本对应用源发请求不带会话 cookie」只有规范推理（不透明源的请求是跨站请求，cookie 为 `HttpOnly; SameSite=Lax`，`server/src/auth/session.ts:214-219`），没有对真实 server 实测；一次性浏览器观察用的是 mock API。
15. 预览里的死循环或内存耗尽可能卡住用户自己的标签页（取决于浏览器是否把沙箱 frame 放进独立进程）。

## Seams under test
- 纯函数：`artifactKind`。
- jsdom 页面 fixture：派生、三类操作、拉取纪律、次序。
- stub：`fetch`（预览响应、挂起、失败）、`URL.createObjectURL`/`revokeObjectURL`、`HTMLAnchorElement.prototype.click`、`navigator.clipboard`。
- 静态 CSS 文本。
