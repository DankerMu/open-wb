# Design: chat-step-cards（#287）

Fixture level：expanded（父 tasks 组 4 声明；review priority 为 decision-dense，摘要规则一次定调）。

Risk packs：
- Public API / CLI / script entry：徽章可访问名是 jsdom 与 ui-walk 的完成 oracle。
- Schema / columns / units / field names：摘要规则即 detail 字段的呈现契约。
- Legacy compatibility：拆 CSS 与拆 e2e 不得改变行为。
- Resource limits / large input：detail 可能很大或是深层 JSON。

Change surface：
- 新增：
  - `web/src/features/chat/step-summary.ts`
  - `web/src/features/chat/messages.css`
  - `web/e2e/ui-walk-gate.ts`
  - `web/test/step-summary.test.ts`
  - `web/test/chat-steps.test.tsx`
- 修改：
  - `web/src/features/chat/conversation-view.tsx`（`StepCard`、`isVerboseToolDetail` 删除）
  - `web/src/features/chat/chat.css`（移出消息区规则）
  - `web/src/styles.css`（`@import "./features/chat/messages.css";` 紧跟 chat.css 那行）
  - `web/e2e/ui-walk.spec.ts`
  - `web/test/chat-page.test.tsx:132,166,167`
  - `web/test/chat-messages.test.tsx:61,211`（CSS 路径）
- 不改：`web/src/ui/**`、`web/src/features/chat/{page.tsx,stream.ts,composer.tsx,welcome.tsx,status-label.ts}`、`web/src/lib/**`、服务端、`web/playwright.config.ts`。

Must preserve：
- 步骤卡仍是 `section[aria-label=<step.name>]`：ui-walk `:753` 的 `getByRole("region", { name: "bash" })` 与 `chat-messages.test.tsx:172` 依赖它。助手块内顺序不变，仍是 `.chat-md` 在前、步骤卡在后。
- `chat-page.test.tsx:130-131,163-164` 以 `getByText(BASH_START_DETAIL|BASH_RESULT_DETAIL, { exact: true })` 查找原始 detail。折叠的 `<details>` 内容仍在 DOM 中，`pre` 文本逐字等于 detail，所以保持绿。
- 拆 CSS 后计算样式不变：
  - `messages.css` 中的规则逐字取自 `chat.css:385-662`，含来源注释。
  - `chat.css:754-784` 的 `@media (max-width: 760px)` 块中，只把 `.chat-msg-user { max-width: 100% }` 与 `.chat-thread` 的左右 padding 清零迁到 `messages.css` 自己的 `@media (max-width: 760px)`；原组合选择器 `.chat-thread, .chat-composer` 拆成只剩 `.chat-composer`。该块其余规则（`.chat-layout`、`.chat-sidebar`、`.chat-main`、`.chat-composer-input`）原样保留。
- `chat-composer.test.tsx:201-218` 读取的 `chat.css` 规则（composer、session status）仍在 `chat.css`。`topbar.test.tsx:270-276` 的 `ui-page-heading` 禁令对 `messages.css` 同样成立；该列表不强制改，可顺带追加 `messages.css`。
- ui-walk gate 生命周期与失败传播不变，只移动函数定义。`web/playwright.config.ts` 的 `testMatch: "ui-walk.spec.ts"` 不匹配 `ui-walk-gate.ts`。
- `chat-composer.test.tsx:220-226` 的 ui-walk 静态断言保持绿。
- ui-guardrails：
  - feature css/tsx 无字面颜色或 palette；
  - 基元只经 `../../ui/index.js` 引入；
  - 注释不含 `#NNN`；
  - size-guard 下所有被改或新增的 ts/tsx 文件 ≤ 800 行，含 `web/e2e/ui-walk.spec.ts`。

Must add/change：
- `step-summary.ts`（头注释：`One-line step summary for step cards (S1e 4.2 / parent design D8).`）：
  ```ts
  const MAX_CODE_POINTS = 120;
  function firstLine(value: string): string {
    for (const line of value.split(/\r?\n/)) { const trimmed = line.trim(); if (trimmed !== "") return trimmed; }
    return "";
  }
  function truncate(value: string): string { return Array.from(value).slice(0, MAX_CODE_POINTS).join(""); }
  function pickFromObject(record: Record<string, unknown>): string {
    for (const key of ["text", "content"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value;
    }
    const first = Object.entries(record)[0];
    if (!first) return "";
    const [key, value] = first;
    return `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  }
  export function summarizeStepDetail(detail: string): string {
    let parsed: unknown;
    try { parsed = JSON.parse(detail); } catch { parsed = undefined; }
    const source = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? pickFromObject(parsed as Record<string, unknown>)
      : detail;
    return truncate(firstLine(source));
  }
  ```
  - `JSON.parse` 不需要预先 trim：它本身容忍首尾空白。
  - `JSON.stringify(undefined)` 不会出现，因为 JSON 值里没有 undefined。
  - 截断按码点，不追加省略号；视觉省略由 CSS 负责。
- `conversation-view.tsx`：
  - `import { BrandMark, Icon } from "../../ui/index.js"`、`import { summarizeStepDetail } from "./step-summary.js"`。
  - `StepCard`：
    ```tsx
    const label = SESSION_STATUS_LABEL[step.status];
    const summary = summarizeStepDetail(step.detail);
    const pulse = step.status === "running" ? " ui-pulse" : "";
    <section aria-label={step.name} className="chat-step">
      <div className="chat-step-head">
        <span className="chat-step-icon"><Icon name={step.name === "bash" ? "terminal" : "wrench"} size={14} /></span>
        <strong className="chat-step-name">{step.name}</strong>
        <p aria-label={`${step.name} ${label}`} className={`chat-step-status chat-step-status-${step.status}${pulse}`} role="status">{label}</p>
      </div>
      {summary === "" ? null : <p className="chat-step-line">{summary}</p>}
      {step.detail === "" ? null : (
        <details className="chat-step-disclosure">
          <summary className="chat-step-summary">原始输出</summary>
          <pre className="chat-step-detail">{step.detail}</pre>
        </details>
      )}
    </section>
    ```
  - 删 `isVerboseToolDetail`。`SESSION_STATUS_LABEL` 的键覆盖步骤的 running/done/failed（`status-label.ts` 注释已声明可复用）。
- `messages.css`：
  - 文件头：`Chat message area (thread, bubbles, Markdown body, caret, step cards), split from chat.css; sources as noted per block.`
  - 步骤卡规则在迁入后修改，来源注释 `adapted from resource/workbuddy-live-demo.html:448-460 (.exec, .exec-head, .st-*)`：
    - `.chat-step-head`：`background: var(--wb-bg-hover-light)`、`font-size: 13px`。
    - `.chat-step-icon`：`display: inline-flex; flex: none; color: var(--wb-icon-muted)`。
    - 徽章：去掉胶囊底色，改 `margin-left: auto; font-family: var(--wb-mono); font-size: 11.5px`。颜色：running 用 `var(--wb-brand-primary-deep)`，done 用 `var(--wb-status-success-text)`，failed 用 `var(--wb-status-error-text)`。
    - `.chat-step-line`：`margin: 0; padding: 0 14px; font-size: 12.5px; color: var(--wb-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap`。
    - `.chat-step-disclosure`、`.chat-step-detail`：沿用现有规则，`pre` 需补 `margin` 归零。
    - 删 `.chat-step > .chat-step-detail`：已无该结构。
- `chat.css` 头注释：来源行号去掉已迁出的 transcript/steps 段（如 `416-549 (transcript/steps)`），迁到 `messages.css` 头注释；保留 `chat-composer.test.tsx:208-209` 断言的 `282-298` 与 `363-378` 锚点。
- `ui-walk-gate.ts`：原样移入 `ui-walk.spec.ts:523-582` 的七个函数。导出 spec 实际使用的 `controlOrigin`、`armGate`、`releaseGate`、`deleteGate`、`gatePhase`，`controlHeaders`、`gateUrl` 保持内部。knip 的 web project 不含 `e2e/**`，以 tsc 为准。文件头一行注释说明用途。
- `ui-walk.spec.ts`：
  - import gate 函数，删掉原定义；
  - `:756-757` 改为 `bash 运行中`/`bash 已完成`，`:797` 改为 `bash 已完成`；
  - `:750` 改为 `(await pair.assistant.locator(".chat-md").innerText()).startsWith(FIRST_REPLY_PART)`；
  - `:796` 改为 `await expect(pair.assistant.locator(".chat-md")).toHaveText(EXPECTED_REPLY)`；
  - 完成态下 `.chat-md` 只含单段正文，光标已消失。

Sketch seams under test：
- (S1) `web/test/step-summary.test.ts` 表驱动，`summarizeStepDetail(input) === expected`：
  - `""` → `""`；`"   \n  "` → `""`
  - `'{"command":"echo workbuddy-smoke"}'` → `command: echo workbuddy-smoke`
  - `'{"output":"workbuddy-smoke"}'` → `output: workbuddy-smoke`
  - `'{"a":1,"text":"hello"}'` → `hello`（text 优先于首键）
  - `JSON.stringify({ text: "  ", content: "c1\nc2" })` → `c1`（空白 text 跳过，取 content 首行；输入必须经 `JSON.stringify` 构造或写成 `\\n`，否则裸换行使 `JSON.parse` 抛错而误走文本分支）
  - `'{"content":"c","text":"t"}'` → `t`（`text` 优先于 `content`，与 JSON 键序无关）
  - `'{"content":["x"]}'` → `content: ["x"]`（content 非字符串时回落首键值）
  - `'{"n":{"k":true}}'` → `n: {"k":true}`
  - `'{}'` → `""`
  - `'[{"text":"x"}]'` → `[{"text":"x"}]`（数组按非 JSON 首行）
  - `'42'` → `42`；`'"quoted"'` → `"quoted"`；`'null'` → `null`
  - `'\n\n  first line  \nsecond'` → `first line`
  - `'{not json'` → `{not json`
  - `"x".repeat(200)` → 120 个 `x`
  - `"😀".repeat(130)` → 120 个 `😀`（码点截断，长度 240 UTF-16 单元）
  - `'{"text":"' + "字".repeat(130) + '"}'` → 120 个 `字`
- (S2) `web/test/chat-steps.test.tsx`，经 `renderChatPage` 挂载会话页，模式照 `chat-messages.test.tsx`。running 快照含两条步骤：`bash`（detail `{"command":"echo workbuddy-smoke"}`）与 `read`（detail `plain line\nsecond`）。
  - `region` bash 内：svg 带 `lucide-terminal` 类；`strong` 文本 `bash`；`getByRole("status", { name: "bash 运行中" })` 的 textContent 为 `运行中` 且 className 含 `ui-pulse`；`p.chat-step-line` 文本 `command: echo workbuddy-smoke`；`details.chat-step-disclosure` 的 `open === false`，其 `summary` 文本 `原始输出`，`pre.chat-step-detail` textContent 逐字等于 detail。
  - `region` read 内：svg 带 `lucide-wrench`；徽章名 `read 运行中`；摘要 `plain line`。
  - 推送 `step.end`（bash，done，detail `{"output":"workbuddy-smoke"}`）与 `step.end`（read，failed，detail `""`）后：
    - bash 徽章名 `bash 已完成`、文本 `已完成`、无 `ui-pulse`，摘要 `output: workbuddy-smoke`；
    - read 徽章名 `read 失败`，且 read 卡内无 `.chat-step-line` 与 `details`（detail 为空）；
    - `queryByRole("status", { name: /running|done|failed/ })` 为 null（全英文状态消失）。
  - 静态：`messages.css` 的 `.chat-step-status-done {` 块含 `var(--wb-status-success-text)`。`chat.css` 行数 ≤ 800 且不再含 `.chat-step`、`.chat-md`、`.chat-msg-` 选择器。`styles.css` 中 `messages.css` 的 import 在 `chat.css` 之后。`messages.css` 无颜色字面量。`messages.css` 的 `@media (max-width: 760px) {` 块含 `.chat-msg-user`。
- (S3) e2e 静态：`chat-steps.test.tsx` 断言以下内容：
  - `web/e2e/ui-walk.spec.ts` 含 `name: "bash 已完成"` 与 `name: "bash 运行中"`，不含 `"bash done"`/`"bash running"`；
  - 不含 `assistant.locator("p")`（#366 验收口径；`:738` 的 `user.locator("p").first()` 属用户气泡，保留）；
  - 行数 ≤ 800；
  - 从 `./ui-walk-gate.js` import（`tsconfig.base.json` 为 NodeNext，相对 import 必须带 `.js`）。
- 改写：`chat-page.test.tsx:132` 改为 `bash 运行中`，`:166` 改为 `bash 运行中`（queryBy 为 null），`:167` 改为 `bash 已完成`；`chat-messages.test.tsx:61,211` 路径改为 `messages.css`，`:210` 测试名随之改。

Required evidence：
- S1–S3 与改写在现实现上先红，记录原因；实现后转绿。
- 反向注入，各自变红后回退（记录失败的测试名）：
  1. text 不优先（直接取首键）→ S1 `{"a":1,"text":"hello"}` 行红。
  2. 截断按 UTF-16（`slice(0,120)`）→ S1 emoji 行红。
  3. 数组按对象处理 → S1 数组行红。
  4. 不取首行 → S1 多行行红。
  5. `<details open>` → S2 红。
  6. 徽章可见文本与 `aria-label` 一起退回英文 → S2 与 `chat-page.test.tsx` 红（只退可见文本时仅 S2 红）。
  7. 图标不区分 bash → S2 read 卡红。
  8. 空 detail 仍渲染 details → S2 红。
  9. ui-walk 保留 `bash done` → S3 红。
- `make check`、`npm run build --workspace web`、`(cd web && npx vitest run)`、CI 形态 ui-walk 全部 exit 0；提交时 pre-commit（size-guard 逐文件）通过。

Not yet specified：
- 非 bash 工具（read/edit 等）的专用摘要形态：沿用通用规则，是否定制留待 S1c。
- 摘要行对超长单行只截 120 码点，不加省略号；视觉省略由 CSS `text-overflow` 提供。
- 服务端 `summarize` 把 detail 截到 120 码点（`server/src/sessions/events.ts:26,289`）：超长 JSON 到前端已是前缀、解析失败回落文本分支，`原始输出` 展示的也是截断后的 detail。这是服务端既有行为，不在本刀范围；父 spec 句 "full raw detail" 的兑现程度受其限制，已作为范围外发现上报。

Implementation deviations（Phase 1 记录）：
- `.chat-step-detail` 保留既有的 `margin: 6px 0 0`（已覆盖 `pre` 默认外边距），没有按字面写成 `margin: 0`，以保留 summary 下方 6px 间距。
- `.chat-step-status` 保留既有的 `line-height: 16px` 与基础色 `var(--wb-text-secondary)`；`margin-left: auto` 沿用原有写法 `margin: 0 0 0 auto`。
- `messages.css` 头注释补上从 `chat.css` 迁来的 `demo.html:416-549 (transcript/steps)` 来源行。
- 拆分为无操作的证据：
  - `chat.css:385-662` 与 `messages.css:7-284` 逐字一致；
  - 去注释、展开逗号选择器后的规则集比对为 116 → 116，零差异；
  - `ui-walk-gate.ts` 与原 523-582 行相比只多了 `export` 前缀。
- `topbar.test.tsx` 的禁 `ui-page-heading` 列表追加了 `messages.css`。

