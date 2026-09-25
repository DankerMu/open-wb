# Design: chat-composer-card（#288）

Fixture level: expanded（父 tasks 组 4 声明；改变 ui-walk 会话状态 oracle）。
Risk packs: Public API / CLI / script entry（状态可访问名与发送按钮名是 ui-walk 与 jsdom 的完成 oracle）；Legacy compatibility（键盘发送、生成锁、所有权用例不变）；Documentation / migration notes（测试改写规则）。

Change surface:
- 新增：`web/src/features/chat/composer.tsx`、`web/src/features/chat/status-label.ts`、`web/test/chat-composer.test.tsx`。
- 修改：`web/src/features/chat/conversation-view.tsx`、`web/src/features/chat/page.tsx`、`web/src/features/chat/chat.css`、`web/e2e/ui-walk.spec.ts`（仅 `:746`、`:800` 两处期望）、`web/test/chat-page-ownership-gaps.test.tsx:357`，以及改写规则 2 命中的测试。
- 不改：`stream.ts`、`ownership.ts`、`session-path.ts`、`types.ts`、`web/src/lib/**`、`web/src/ui/**`、服务端；`generating`/`sendDisabled` 的计算（`page.tsx:693-700`）。

Must preserve:
- 键盘发送语义（`conversation-view.tsx:231-248`）：无修饰 Enter 经 `form.requestSubmit()` 发送一次；Shift/Alt/Ctrl/Meta、`isComposing`、`keyCode === 229`、`repeat` 都不发送；`sendDisabled` 时不发送。
- 生成锁：`composerDisabled`（= `generating`）禁用 textarea；`sendDisabled` 禁用按钮；`生成中` 状态元素只在 `generating` 时存在。
- textarea 可访问名 `给助手发消息`（`getByRole("textbox", { name })` 与 Playwright `getByLabel`），提示文本 `Enter 发送 · Shift+Enter 换行` 仍经 `aria-describedby` 关联。
- `<form>` 仍是 composer 根元素（ui-walk `generatingStatus` 用 `locator("form")`）。
- 会话项按钮可访问名仍为 title；`aria-current` 选中语义不变；列表次序不变。
- 其它全部 chat 测试（lifecycle、ownership、ownership-gaps、stream、routes、main、app-shell-responsive、topbar）行为意图不变。
- ui-guardrails：feature css/tsx 无字面颜色或 palette，基元只经 `ui/index.js`；注释不含 `#NNN`。size-guard：`conversation-view.tsx` 与各测试 ≤ 800 行。

Must add/change:
- `status-label.ts`：
  ```ts
  import type { ChatSession } from "../../lib/session-contract.js";
  export const SESSION_STATUS_LABEL: Record<ChatSession["status"], string> = {
    idle: "未开始", running: "运行中", done: "已完成", failed: "失败",
  };
  ```
- `composer.tsx`（类名与 DOM 次序为契约）：
  ```tsx
  export function Composer({ disabled, draft, generating, onChangeDraft, onSubmit, placeholder, sendDisabled }: ComposerProps) {
    const inputId = useId();
    const hintId = useId();
    return (
      <form className="chat-composer" onSubmit={onSubmit}>
        <div className="chat-composer-card">
          <label className="ui-sr-only" htmlFor={inputId}>给助手发消息</label>
          <textarea id={inputId} aria-describedby={hintId} className="chat-composer-input" disabled={disabled}
            onChange={…} onKeyDown={/* 原样搬入 */} placeholder={placeholder} rows={2} value={draft} />
          <div className="chat-composer-toolbar">
            {generating ? <p className="chat-composer-pending" role="status">生成中</p> : null}
            <Button aria-label={generating ? "生成中" : "发送"} className="chat-send" disabled={sendDisabled}
              size="icon" type="submit" variant="primary">
              <Icon name="send" />
            </Button>
          </div>
        </div>
        <p className="chat-composer-hint" id={hintId}>Enter 发送 · Shift+Enter 换行</p>
      </form>
    );
  }
  ```
- `conversation-view.tsx`：
  - `<Composer placeholder={requestedSessionId ? "继续追问，或派一个新任务…" : "今天帮你做些什么"} … />`。
  - 会话项：
    ```tsx
    const label = SESSION_STATUS_LABEL[session.status];
    <button aria-current=… aria-label={title} className="chat-session-button" …>
      <span aria-label={`${title} ${label}`} className="chat-session-status" role="status">
        <span aria-hidden="true" className={`chat-session-dot chat-session-dot-${session.status}${session.status === "running" ? " ui-pulse" : ""}`} />
        <span className="ui-sr-only">{label}</span>
      </span>
      <strong className="chat-session-title">{title}</strong>
    </button>
    ```
  - props 去掉 `composerLabel`、`generatingLabel`。
- `page.tsx`：删 `COMPOSER_LABEL`、`GENERATING_LABEL`，调用处同步。
- `chat.css`（头部或段注释标 demo:282-298 会话项、363-378 composer；只用语义 token）：
  - `.chat-session-button`：`display: flex; align-items: center; gap: 8px`（原 grid 两行删掉）。
  - `.chat-session-status` 整条规则替换为 `position: relative; display: inline-flex; flex: none`（为 `.ui-sr-only` 定位），删掉原有 `grid-column`、`padding`、`border-radius`、`background`、`font-family` 等徽章属性；`.chat-session-dot` 删 `grid-row`。
  - `.chat-session-dot`：6px 圆点；`-running` `--wb-status-warning`、`-done` `--wb-status-success`、`-failed` `--wb-status-error`、`-idle` `--wb-text-tertiary`。删 `.chat-session-status-running|done|failed` 徽章规则。
  - `.chat-composer-card`：`position:relative; display:flex; flex-direction:column; gap:12px; padding:12px; border:1px solid var(--wb-border-default); border-radius:16px; background:var(--wb-bg-primary); box-shadow:var(--wb-shadow-input)`，`:focus-within` 边框 `var(--wb-color-border-focus)`。
  - `.chat-composer-input`：无边框、透明背景、`resize:none`、`min-height:52px; max-height:160px`、`font-size:15px; line-height:1.75`；`::placeholder` `var(--wb-text-tertiary)`；disabled 文字 `--wb-text-tertiary`。**不写 `outline: none`**：`--wb-color-border-focus` 等于 `--wb-border-default`，卡片 `:focus-within` 边框无变化，全局 `:focus-visible` outline 是唯一聚焦提示。≤760 块删掉 `.chat-composer-input` 的 `min-height: 3.5rem`，只保留 `max-height: 6rem`。
  - `.chat-composer-toolbar`：`display:flex; align-items:center; gap:8px; min-height:32px`；`.chat-send`：`margin-left:auto; width:32px; height:32px`；`.chat-send, .chat-send:focus-visible { border-radius: 50%; }`（压过 `ui/button.css:101-103` 的 `.ui-btn:focus-visible { border-radius: 8px }`，同为 (0,2,0)，chat.css 在后）。
  - `.chat-composer-hint`：`margin:0; font-size:12px; color:var(--wb-text-tertiary); text-align:center`。
  - 删 `.chat-composer-label`、`.chat-composer-foot`。

测试改写规则：
1. 按钮查找：只在非生成态用 `getByRole("button", { name: "发送" })`；生成态用 `{ name: "生成中" }`。`clickSend()`（`chat-page-lifecycle-support.tsx:159`）与 `typeAndSend`（`chat-page-ownership-support.ts:33`）的调用点都在非生成态，保持不变，**唯一例外** `chat-page-lifecycle.test.tsx:357`：同一用例的第二次 `clickSend()` 发生在第一次点击已把页面置为生成态之后，改为先断言 `getByRole("button", { name: "生成中" })` 为 `disabled`，再 `fireEvent.click` 它（保持"对禁用按钮重复提交"的原意并加强断言）。
2. 会话状态：全仓 `grep -rn` `web/test` 与 `web/e2e` 中按英文会话状态的断言（`getByText("running"|"done"|"failed"|"idle")`、`name: \`${…} done\`` 等，步骤徽章 `bash running|done` 除外）。命中处改为中文，并在 PR 列出清单。已知：`chat-page-ownership-gaps.test.tsx:357`。
3. 步骤徽章（`bash running` 等）属 #287，本刀不改。
4. `getByText("生成中", { exact: true })` 仍只命中 status 元素（按钮的 `生成中` 是 aria-label，不是文本），保持不变。

Sketch seams under test（`web/test/chat-composer.test.tsx`，用 `renderChatPage`/`cleanupChatPage`）：
- (C1) placeholder：
  - 无 `?session=`：textbox `给助手发消息` 的 `placeholder === "今天帮你做些什么"`。
  - `/?session=<id>`（done 快照）：`placeholder === "继续追问，或派一个新任务…"`。
- (C2) composer 结构（done 快照；沿用 `mountKeyboardComposer` 的做法，先 `waitFor(input.disabled === false)` 再断言按钮名，因为 history loading 期间 `generating` 也为真）：
  - textbox 与唯一按钮都在同一 `.chat-composer-card` 内；`form.chat-composer` 内恰一个 button，名 `发送`，`type="submit"`，含 `svg`；卡内无名为 附件/模型/麦克风/停止 的控件（`queryAllByRole("button")` 长度 1）。
  - `label[for=<textarea id>]` 存在且 `className === "ui-sr-only"`。
  - 提示 `getByText("Enter 发送 · Shift+Enter 换行", { exact: true })` 在 form 内、卡外，其 id 等于 textarea 的 `aria-describedby`。
  - 按钮在 `.chat-composer-toolbar` 内，toolbar 是卡的最后一个子元素，textarea 在 toolbar 之前（`compareDocumentPosition`）。
- (C3) 生成态（running 快照，cursor `1:3`；按 `chat-page.test.tsx:105-152` 先例：messages 路由用函数，每次返回 running 快照；等 `FakeEventSource.instances.length === 1` 后 `latestSource().emitOpen()`，恢复 GET 同样返回 running 快照）：
  - `getByRole("button", { name: "生成中" })` 存在且 `disabled`，同时 `queryByRole("button", { name: "发送" })` 为 null。
  - `.chat-composer-toolbar` 内 `getByRole("status")` 文本恰为 `生成中`；该元素在按钮之前。
  - 推进到 done：`latestSource().emitData("turn.end", "1:4", { messageId: 0, status: "done" })`（seq 大于快照 cursor），然后 `await findByRole("button", { name: "发送" })`，再断言 `within(toolbar).queryByRole("status")` 为 null。
- (C4) 会话项状态：`/api/sessions` 返回四个会话（`running`/`done`/`failed`/`idle`，title 分别为 `会话甲..丁`），id 为四个不同的 32 位小写 hex（如 `"a".repeat(32)`、`"b".repeat(32)`、`"c".repeat(32)`、`"d".repeat(32)`），恰含 `id,title,status,createdAt,updatedAt` 五键，时间为非负整数（`parseSession` 要求，`web/src/lib/session-contract.ts:53,72-84`；任一不合法会让整个列表解析失败）。无 `?session=`，先 `await within(nav).findByRole("button", { name: "会话甲" })`。对每一项：
  - `within(nav).getByRole("status", { name: "<title> <中文>" })` 存在，`textContent === <中文>`；
  - 其中的 `.ui-sr-only` 文本为中文；点 `aria-hidden="true"`，类含 `chat-session-dot-<status>`；running 的点含 `ui-pulse`，其余三项不含；
  - 按钮可访问名恰为 title（`getByRole("button", { name: "<title>" })`）；
  - 整个 nav 的 textContent 不含 `running`、`done`、`failed`、`idle`。
- (C5) 静态契约（`readRepoFile`）：
  - `composer.tsx` 含 `Icon`、`Button`、`ui-sr-only`、两种 aria-label 文本；不含 `role="status"` 以外的 `role=`；按钮元素不带 `role`。
  - `conversation-view.tsx` 不含 `{session.status}` 作为可见文本（正则 `/>\s*\{session\.status\}\s*</`），含 `SESSION_STATUS_LABEL` 与 `ui-pulse`。
  - `chat.css` 不含 `.chat-session-status-running`、`.chat-composer-label`、`.chat-composer-foot`、`outline: none`，不含十六进制色值；含 `demo.html:282-298` 与 `demo.html:363-378`；含 `.chat-send:focus-visible`；`.chat-session-status {` 规则块不含 `padding`、`background`。
  - `web/e2e/ui-walk.spec.ts` 含 `toHaveText("运行中")` 与 `toHaveText("已完成")`，不含 `toHaveText("running")`、`toHaveText("done")`。
- (C6) 键盘发送回归：既有 Enter/Shift+Enter/IME/repeat 用例（`chat-page.test.tsx` `mountKeyboardComposer` 一组）不改且全绿；另在 C2 上加一条：textarea 在 Enter 后 `requestSubmit` 触发一次 prompt 请求（路径 `/api/sessions/<id>/prompt` 计数 1）。

Required evidence:
- C1–C5 在现实现上先红，记录失败原因；实现后转绿。
- 反向注入各自变红并回退（记录失败的测试名）：
  1. 会话 status 文本仍显示英文 `session.status` → C4 红；本地 ui-walk `:746` 红。
  2. `idle` 未映射（`SESSION_STATUS_LABEL` 缺 `idle` 或返回 undefined）→ C4 idle 行红。
  3. running 点不加 `ui-pulse` → C4 红。
  4. 所有点都加 `ui-pulse` → C4 红。
  5. 状态文本可见（去掉 `ui-sr-only` 类）→ C4 红。
  6. 发送按钮生成态 aria-label 仍为 `发送` → C3 红。
  7. `生成中` status 移出 toolbar（放回卡外）→ C3 红。
  8. placeholder 不随选中切换（固定 `今天帮你做些什么`）→ C1 红。
  9. 标签恢复可见（去掉 `ui-sr-only`）→ C2 红。
  10. 工具栏加一个附件按钮 → C2 红。
  11. 键盘逻辑去掉 `keyCode === 229` 判断 → 既有 IME 用例红。
  12. ui-walk 期望改回英文 → C5 红。
  13. 删掉 `.chat-send:focus-visible` 的圆角覆盖 → C5 红。
- `make check` exit 0（size-guard、jscpd、knip、biome、ui-guardrails、naming-guard 需先 `git add -N`）。
- `npm run build --workspace web` exit 0。
- `(cd web && npx vitest run)` 全绿。
- CI 形态 ui-walk exit 0（证明 `运行中`/`已完成`/`生成中` 定位与 `getByLabel("给助手发消息")`）。

Not yet specified:
- composer 在欢迎态的托盘外观（`.composer-slot` 渐变）随 4.4 #289 定；本刀卡片在两态外观一致。
