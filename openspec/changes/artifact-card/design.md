# Design: artifact-card（#536）

## Context
- `web/src/features/chat/stream-artifacts.ts`（50 行）：`summarizeChanges(steps)` 给出一条消息的去重变更行（已结束步骤、位置取首次、值取最后）。
- `file-changes-card.tsx`（71 行）：`<fieldset aria-labelledby>`，图标按钮写法 `Button size="icon" variant="ghost" className="chat-msg-action"`（`aria-label` 与 `title` 同文）。
- `conversation-view.tsx`（274 行）：`MessageArticle` 在 `{error}` 之后渲染 `<FileChangesCard>`，再是 `已停止` 徽章与操作行；`workspace: Workspace | null` 已传到 `MessageArticle`。`MessageArticle` 是 `memo`。
- `page.tsx`（689 行）：`client = useMemo(() => createSessionClient(), [createSessionClient])`（`:57`）；`ChatPage` 的认知复杂度已在 Biome 上限 15。
- `web/src/lib/api.ts`：`fetchPreview(workspaceId, path, { signal })`（`:140`、`:632`）返回 `{kind:"text", text, size, truncated}` 或 `{kind:"image", url, size, truncated}`；`url` 是 `URL.createObjectURL` 建的 Blob URL，归调用方撤销（`:459`）；`truncated` 取自响应头 `X-Workbuddy-Truncated: 1`（`:412`）。类型 `FilePreview` 不导出，按 `web/src/features/files/preview.tsx:15` 的写法取 `Awaited<ReturnType<ApiClient["fetchPreview"]>>`。失败抛 `ApiError`；401 时 client 自己通知未登录。
- 服务端 `server/src/workspaces/preview.ts:31-52`：文本类超过上限截断并带标记；图片超过上限直接报 `preview_too_large`，**图片不会被截断**；其它扩展名报 `preview_unsupported`。可预览集合与 `web/src/features/files/tree.tsx:69-82` 一致。
- `chat/errors.ts`：`errorMessage(error)`（`ApiError` → 信封 message，否则 `请求失败，请稍后重试`）、`isUnauthorized(error)`。
- `Dialog`（`web/src/ui/dialog.tsx`）：`open`/`onOpenChange`/`title`/`size`（`sm` 400px、`md` 520px）；没有 trigger 时关闭后焦点还给打开者；内容经 portal 渲染在 `.chat-msg-main` 之外。
- 图标：`globe`、`download`、`package`、`file-code`、`image`、`copy`、`chevron-right` 均已注册（`web/src/ui/icon.tsx`）；demo 用的 `externalLink`/`arrowUpRight` 没有注册。
- 颜色守卫（`web/test/ui-guardrails.test.ts:44-55`）：features 下的 `.css`/`.tsx` 不许出现 hex/`rgb()`/`rgba()` 字面量（注释也算）与 `--wb-palette-*`。
- 既有测试 `web/test/chat-page-file-changes.test.tsx` 的 C13：对 `.chat-msg-main` 的全子元素做 `toEqual`，夹具路径 `out/index.html`、空间可解析。support 的 `cards()` 选 `.file-changes-card`，G5 用 `[class*="file-change"]`。
- demo：`resource/workbuddy-live-demo.html:502-515`（样式）、`:2419-2466`（结构）。

## Decisions

### D1 `artifactKind(path)`（`stream-artifacts.ts`，纯函数、导出）
```ts
type Artifact = { kind: "html" | "image" | "code"; label: string; name: string };
export function artifactKind(path: string): Artifact | null
```
`name` 是最后一个 `/` 之后的末段；扩展名是 `name` 里最后一个 `.` 之后的部分，转小写后查表：`html` → `html`/`HTML`；`png` → `image`/`PNG`；`jpg`、`jpeg` → `image`/`JPG`；`md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx` → `code`/扩展名大写。没有 `.`、`.` 在末尾、或扩展名不在表里 → `null`。

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
- html 的预览 Dialog 由这张卡自己持有：`<Dialog open={preview !== null} onOpenChange={(open) => { if (!open) setPreview(null); }} size="md" title={artifact.name}>`，内容为可选的截断提示 `p.artifact-preview-note`（`文件超过 1 MiB，仅预览前 1 MiB`）在前，`<iframe className="artifact-preview-frame" sandbox="allow-scripts" srcDoc={preview.text} title={artifact.name} />` 在后。`sandbox` 是写死的字符串字面量。

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
      if (result.kind === "image") URL.revokeObjectURL(result.url);
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
按钮的 `onClick={() => void run()}`；`busy` 时这张卡的所有操作按钮 `disabled`（html 有两个）。

`deliver(result)`：
- 类型不符（图片卡拿到文本，或 html/代码卡拿到图片）：拿到的是图片就先 `URL.revokeObjectURL`，然后 Toast `errorMessage(undefined)`（即 request_failed 的安全文案）；不开 Dialog、不写剪贴板、不下载。
- html：`setPreview({ text: result.text, truncated: result.truncated })`。
- image：建一个 `<a>`，`href = result.url`、`download = artifact.name`，挂到 `document.body`、`click()`、移除；随后 `setTimeout(() => URL.revokeObjectURL(result.url), 0)`。撤销延后一个宏任务：点击后同步撤销在部分浏览器里会让下载拿不到内容；定时器不随卸载取消，所以卸载后照样撤销。图片不会被截断（Context），不设截断分支。
- code：`result.truncated` → Toast（error）`文件过大，无法复制`，不碰剪贴板；否则 `try { await navigator.clipboard.writeText(result.text); toast success 已复制到剪贴板 } catch { toast error 复制失败 }`（剪贴板不存在时取属性即抛，落进同一个 `catch`）。

路径走查：
- 点击前：没有任何 `/file` 请求（不预取）。
- 拉取中再点：`controller.current` 非空，直接返回；按钮本就禁用。
- 失败（404/415/413/网络）：`catch` 出 Toast，`finally` 复位，可再点。401：不出 Toast（client 已通知未登录）。
- 卸载、切换会话、换账号：三者都会卸载消息列表（`FollowTranscript` 以会话 id 为 key；换账号时历史不再属于当前 client），清理函数 abort。之后请求以 AbortError 拒绝 → `catch` 里 `aborted` 为真，不出 Toast；若响应已经回来（Blob URL 已建）→ 走「卸载之后才回来」分支撤销。`finally` 不再 `setState`。
- 整个处理函数经 `void run()` 调用，内部 `try/catch` 包住全部 await，不留下未处理拒绝。

### D5 接线
- `page.tsx`：`<ConversationView client={client} …>`，+1 行（689 → 690，无运算符）。`client` 引用稳定，`MessageArticle` 的 `memo` 不失效。
- `conversation-view.tsx`：`client` 经 `ConversationView` → `MessageThread` → `MessageArticle`；助手分支在 `<FileChangesCard>` 之后、`已停止` 徽章之前渲染 `<ArtifactCards client={client} steps={message.steps} workspace={workspace} />`。user 分支不渲染。`ArtifactCards` 自己再算一次 `summarizeChanges`（纯函数），不改 `FileChangesCard`。

### D6 样式（`messages.css`，590 行）
按 demo:502-515，颜色只用既有语义 token：卡片同文件变更卡的边框/圆角/底色，带 fieldset 复位；卡头 `display: flex; align-items: center; gap: 8px; padding: 9px 12px`，有卡脚时带底边；图标块 22×22、圆角 6px，html 用 `--wb-status-warning-soft-bg` + `--wb-status-warning-text`，代码用 `--wb-brand-primary-subtle` + `--wb-brand-primary`，图片用 `--wb-bg-tertiary` + `--wb-text-secondary`（proposal 偏差 6）；标题等宽、13px、600、`flex: 1; min-width: 0` 加省略号；标签 10.5px、次要文字色、1px 边框、圆角 4px；卡脚 `padding: 8px 12px; border-top; font-size: 12px`，链接按钮无底无边、品牌色、`margin-left: auto`、hover 下划线、`:disabled` 时不可点的样式。预览 iframe：`display: block; width: 100%; height: 60vh; border: 0; background: white`——取回的网页默认按白底写，深色主题下透明的 iframe 会让默认的黑字落在深色对话框上；这里用 CSS 关键字 `white`（不是字面 hex，守卫不拦，也没有「恒为白色的背景」语义 token）。不写 `transition`、`outline`。`chat.css` 不动。

### D7 既有测试的改动
`web/test/chat-page-file-changes.test.tsx` 的 C13 两份期望列表各插入产物卡一项（`fieldset.artifact-card`，在文件变更卡之后）。若还有别的既有用例因产物卡出现而变红，停下报告。

## Must-preserve
- 文件变更卡的内容、降级与位置；折叠块、审批条、步骤卡、错误、`已停止` 徽章、操作行的行为与相对次序；`复制` 只复制正文。
- `fetchPreview`、`summarizeChanges` 不改；files feature 的预览不受影响。

## Required evidence（`web/test/chat-page-artifact-card.test.tsx`）
页面级搭法与夹具从 `chat-page-file-changes-support.tsx` 导入（不改它）。jsdom 的接缝：`URL.createObjectURL`/`revokeObjectURL` 在 jsdom 里没有实现，按 `web/test/api-files.test.ts:212-222` 的写法 stub（注意不要把 `URL` 整个换掉以致 `new URL()` 失效——只补这两个静态方法）；`<a>` 的点击 spy `HTMLAnchorElement.prototype.click`（jsdom 的导航未实现）并在 spy 里读 `href`/`download`；剪贴板的三种状态沿用 `chat-copy.test.tsx` 的 stub；挂起的响应用 `deferredResponse`；未处理拒绝用 `observeUnhandledRejections`；文本预览响应用 `support.ts` 的 `textPreviewResponse`。

- A1 `artifactKind` 表：`out/index.html` → html/`HTML`/`index.html`；`assets/chart.PNG` → image/`PNG`/`chart.PNG`；`a.jpg`、`b.JPEG` → image/`JPG`；`md`、`txt`、`log`、`csv`、`json`、`js`、`ts`、`tsx` 各一 → code/大写扩展名；`main.py`、`Makefile`、`a.tar.gz`、`trailing.`、`dir.html/readme` → `null`。
- A2 派生与不预取：一条消息的变更为 `src/app.ts`（edit）、`main.py`、`out/index.html`、`assets/chart.PNG` → 文件变更卡四行；其后按汇总次序恰有三张产物卡，group 名为 `app.ts`、`index.html`、`chart.PNG`，标签 `TS`、`HTML`、`PNG`；此时对 `/file` 的请求数为 0；页面 `innerHTML` 不含空间绝对根；没有 `在编辑器中打开`；卡片内没有 iframe 与 img。
- A3 html（Scenario「html 预览隔离」）：有两个名为 `打开网页预览 index.html` 的按钮、卡脚文本含 `可交互预览`；点卡头那个 → 恰一次 `GET /api/workspaces/<空间 id>/file?path=out%2Findex.html`；出现标题 `index.html` 的 dialog，内有 iframe，其 `getAttribute("sandbox")` 恰为 `allow-scripts`、`srcdoc` 恰为取回文本、`title` 为 `index.html`；没有截断提示。关闭 Dialog 后 iframe 消失。另一例点卡脚那个按钮同样打开。
- A4 截断：预览响应带 `X-Workbuddy-Truncated: 1` → dialog 内 `文件超过 1 MiB，仅预览前 1 MiB` 在 iframe 之前（文档顺序）。
- A5 图片（Scenario「图片下载与代码复制」）：点 `下载 chart.PNG` → 请求的 `path` 为 `assets/chart.PNG`；`click` spy 恰被调用一次，当时该 `<a>` 的 `download` 为 `chart.PNG`、`href` 为 stub 返回的 Blob URL；`revokeObjectURL` 在点击那一刻尚未被调用，一个宏任务之后以该 URL 被调用恰一次；临时链接不留在文档里。
- A6 代码：点 `复制代码 app.ts` → `clipboard.writeText` 的参数恰为预览文本；Toast `已复制到剪贴板`。
- A7 代码的失败分支：剪贴板不存在、`writeText` 同步抛错、返回 rejected promise → 三者都是 Toast `复制失败`；预览截断 → `writeText` 未被调用、Toast `文件过大，无法复制`。
- A8 预览失败（Scenario「不派生与失败」）：`复制代码 gone.md` 得 404 信封 → Toast 为信封 message，`writeText` 未被调用，没有 dialog，无未处理拒绝；按钮恢复可点，再点会发第二个请求。html 卡得 415 → Toast 信封 message、没有 dialog。图片卡得 413 → Toast、`click` spy 未被调用。`fetch` 拒绝（网络错误）→ Toast `请求失败，请稍后重试`。
- A9 类型不符：代码卡拿到图片响应 → `revokeObjectURL` 以该 URL 被调用、Toast `请求失败，请稍后重试`、`writeText` 未被调用；图片卡拿到文本响应 → Toast、`click` spy 未被调用；html 卡拿到图片响应 → 没有 dialog、URL 被撤销。
- A10 拉取中（Scenario「拉取中与卸载」前半）：响应挂起时，这张 html 卡的两个按钮都 `disabled`，另一张卡的按钮仍可点；对已禁用按钮再 `fireEvent.click` 不产生第二个请求；响应返回后两个按钮恢复。
- A11 卸载与切换会话（Scenario 后半）：图片预览挂起时切到另一个会话 → 该请求的 `signal.aborted` 为真；随后让挂起的响应以图片返回 → `revokeObjectURL` 以该 URL 被调用，`click` spy 未被调用，没有任何 Toast。html 预览挂起时切会话，随后文本返回 → 没有 dialog、没有 Toast。
- A12 换账号与 401：预览挂起时换账号（`renewAccount`）→ 请求被 abort、无 Toast；预览得 401 → 不出错误 Toast。
- A13 次序（Scenario「助手块次序」）：`stopped` 助手消息带 `thinking`、一条已结算审批、正文 `部分回答`、带 `out/index.html` 变更的已结束 `write` 步骤、空间可解析 → `.chat-msg-main` 的**全部**子元素按序为 `details.thinking-block`、`div.chat-approvals`、`.chat-md`、步骤卡、`fieldset.file-changes-card`、`fieldset.artifact-card`、`已停止` 徽章、操作行；`复制` 的参数恰为 `部分回答`。
- A14 不渲染的情形：会话空间不在列表里、会话未绑定、列表读取中、列表读取失败 → 文件变更卡仍在、没有 `.artifact-card`（列表读取成功后出现）；user 消息没有产物卡；running 步骤的变更在 `step.end` 之前没有产物卡、之后出现；只有 `main.py` 的消息没有产物卡。其中「user 消息」「只有 `main.py`」是实现前就成立的护栏。
- A15 静态样式：`.artifact-preview-frame` 含 `border: 0`；三种图标块用 D6 列的 token；`chat.css` 不含 `artifact-`（护栏）。

基线运行：测试导入实现前不存在的 `artifactKind`，跑基线时在沙箱里临时给 `stream-artifacts.ts` 加一个抛错的同名导出（不进补丁），让各用例逐例给出红绿；报告里逐条列出基线即绿的护栏。

变异自检（实现者在沙箱里做，做完还原，写进报告；每个至少打红一例）：`sandbox` 改成 `allow-scripts allow-same-origin`；去掉 `sandbox`；挂载时预取；`srcDoc` 换成经 `URL.createObjectURL` 的 `src`；卡片里内嵌 iframe；去掉拉取中的不并发门（`controller.current` 判断）且按钮不禁用；`busy` 只禁用被点的那个按钮；卸载时不 abort；卸载后才回来的图片不撤销；下载后不撤销；点击前就撤销（同步撤销）；截断的文本照样复制；截断时不显示提示；失败时照样开 Dialog；abort 也出 Toast；401 出 Toast；类型不符的图片不撤销；标签用原始扩展名（`chart.PNG` 的 `PNG` 看不出来，用 `app.ts` → `ts`）；`jpeg` 的标签为 `JPEG`；文件名取整条路径；请求用 `workspace.dir` 或逻辑路径而非空间 id 与相对路径；空间不可解析时照样渲染；产物卡放到文件变更卡之前；放到 `已停止` 徽章之后；user 消息也渲染；计入 running 步骤的变更。

## 已知残留
1. #522 合入前服务端不产生 `changes`，产物卡只在快照已带 `changes` 时出现；真实链路与真实浏览器证据归 #522、8.2a。
2. `sandbox="allow-scripts"` 的 iframe 是不透明源：读不到应用的 cookie 与 API 响应，但脚本可以向任意地址发请求、可以弹 `alert` 以外的大部分 API 被禁（无 `allow-modals`、`allow-popups`、`allow-forms`、`allow-top-navigation`）。站点未设 CSP（父 design Risks）。
3. 预览 Dialog 是 `md`（520px 宽），网页按窄视口排版；`web/src/ui/**` 不在本刀范围。
4. 预览打开期间文件再被改写不会刷新（不存副本、不轮询）；关掉再点才重新拉取。
5. 临时下载链接的撤销延后一个宏任务；极慢的环境下理论上仍可能早于浏览器读取 Blob，未做真实浏览器验证。
6. 一条消息的可派生变更很多时每项一张卡，没有折叠（每步骤至多 50 项）。
7. html 卡头按钮用 `chevron-right`（demo 的 `externalLink` 未注册）。

## Seams under test
- 纯函数：`artifactKind`。
- jsdom 页面 fixture：派生、三类操作、拉取纪律、次序。
- stub：`fetch`（预览响应、挂起、失败）、`URL.createObjectURL`/`revokeObjectURL`、`HTMLAnchorElement.prototype.click`、`navigator.clipboard`。
- 静态 CSS 文本。
