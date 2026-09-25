# Design: chat-markdown-messages（#286）

Fixture level: expanded（父 tasks 组 4 声明；review priority decision-dense：安全边界复用）。

Risk packs：
- Public API / CLI / script entry：article 可访问名与 `p` 定位面（jsdom 与 ui-walk）。
- Legacy compatibility：files 预览 DOM 与行为、既有助手原文断言。
- Auth / permissions / secrets：不涉及凭据，但模型输出进入 DOM 的注入面归入本包。

Change surface:
- 移动：`web/src/features/files/md-render.ts` → `web/src/lib/md-render.ts`，用 `git mv`，内容不变。
- 新增：`web/src/lib/markdown-view.tsx`、`web/test/chat-messages.test.tsx`。
- 修改：`web/src/features/files/preview.tsx`、`web/src/features/chat/conversation-view.tsx`、`web/src/features/chat/chat.css`。`web/test/md-render.test.ts:2` 与 `web/test/preview.test.tsx:3` 只改 import 路径。
- 不改：`web/src/ui/**`、`web/src/features/chat/{page.tsx,composer.tsx,stream.ts,welcome.tsx}`、`web/e2e/**`、服务端、`web/src/features/files/files.css`。

Must preserve:
- **files 预览**：
  - `preview.test.tsx` 与 `md-render.test.ts` 的全部断言不变且全绿，只改 import 行。
  - `.files-md[data-markdown-body]` 容器、`key={text}` 快照替换、`查看源码/渲染视图` 切换不变。
- **Markdown 安全策略**：
  - 只生成 React 元素，`web/src` 中不出现 `dangerouslySetInnerHTML`/`innerHTML`。
  - 链接 `href="#"`，click 与 Enter/Space 时 `preventDefault`；目标地址丢弃；代码为字面值。
  - 深层 `strong` 迭代渲染（非递归）不变。
- **会话页**：
  - `article` 的 `aria-label` 为 `用户`/`助手`（`chat-page-ownership-gaps.test.tsx:158-170`、`topbar.test.tsx:129,247`、`web/e2e/ui-walk.spec.ts:734-735`）。
  - 用户正文仍是 `p.chat-msg-body` 且为 `article` 内首个 `p`（ui-walk `:738`）。
  - 单行助手文本的逐字 `getByText(…, exactText)` 断言保持绿，见 proposal Risk triage。
  - 步骤卡（`StepCard`）与消息错误（`p.ui-alert.chat-msg-error[role=alert]`）的结构与文本不变，只移入 `.chat-msg-main`。
- **页面 heading**：助手 Markdown 的 `<h1>` 是内容，不是页面 heading（spa-shell 已声明）。会话态 level-1 断言使用的历史文本不含 `#` 行，保持绿。
- ui-walk 全绿、不改。
- ui-guardrails：
  - feature css/tsx 无字面颜色或 palette。
  - 基元只经 `../../ui/index.js`；`lib/markdown-view.tsx` 不从 `ui/` 或 `features/` 导入。
  - 注释不含 `#NNN`。
  - size-guard：各文件 ≤ 800 行（`md-render.ts` 797 行，移动不变）。

Must add/change:
- `web/src/lib/markdown-view.tsx`：
  - 头注释：`React renderer for the shared Markdown subset (lib/md-render.ts); moved from features/files/preview.tsx unchanged. Emits React elements only: source HTML stays text, links are inert (href="#", destinations dropped).`
  - 函数体从 `preview.tsx:60-188` 原样搬入：`preventInertNavigation`、`InlineElementNode`/`InlineRenderFrame` 类型、`renderInlineElement`、`renderInline`、`MarkdownHeading`、`renderBlock`，含 biome-ignore 注释。
  - 导出：
    ```tsx
    export function MarkdownView({ source }: { source: string }) {
      const blocks = useMemo(() => parseMarkdown(source), [source]);
      return <>{blocks.map(renderBlock)}</>;
    }
    ```
- `preview.tsx`：
  - 删除上述函数与仅它们使用的 import（`MdBlock`、`MdInline`、`KeyboardEvent`、`MouseEvent`、`ReactNode`、`parseMarkdown` 等，以 biome/tsc 为准），`import { MarkdownView } from "../../lib/markdown-view.js"`。
  - `RenderedMarkdownDocument` 改为 `<div className="files-md" data-markdown-body=""><MarkdownView source={text} /></div>`。
  - 若 `CodeView`/`CsvTable` 仍用到别的 import，保留。
- `conversation-view.tsx`：
  - `import { BrandMark } from "../../ui/index.js"`、`import { MarkdownView } from "../../lib/markdown-view.js"`。
  - `MessageArticle`：
    ```tsx
    const assistant = message.role !== "user";
    if (!assistant) {
      return (
        <article aria-label="用户" className="chat-msg chat-msg-user">
          <p className="chat-msg-body">{message.content}</p>
          {steps}{error}
        </article>
      );
    }
    return (
      <article aria-label="助手" className="chat-msg chat-msg-assistant">
        <span aria-hidden="true" className="chat-msg-avatar"><BrandMark size={28} /></span>
        <div className="chat-msg-main">
          <div className="chat-md">
            <MarkdownView source={message.content} />
            {message.status === "running" ? <span aria-hidden="true" className="ui-caret chat-caret" /> : null}
          </div>
          {steps}{error}
        </div>
      </article>
    );
    ```
    - `steps` 与 `error` 的 JSX 与现状相同，抽成局部变量复用。
    - 删 `.chat-msg-role` 元素。
    - `message.status` 取 `ChatMessageView` 既有字段（`stream.ts:21`）。
- `chat.css`（来源注释 `adapted from resource/workbuddy-live-demo.html:420-446 (.user-msg-row, .msg-user, .assistant-*, .stream-caret)`）：
  - 删 `.chat-msg-role` 规则。
  - `.chat-msg-user`：`align-self:flex-end; max-width:80%; padding:10px 15px; border-radius:16px 16px 4px 16px; background:var(--wb-bg-hover-light)`，去掉现有边框与固定宽度。
  - `.chat-msg-user .chat-msg-body`：`white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; font-size:14px; line-height:1.65`。现有 `.chat-msg-body` 的 `pre-wrap` 规则可收窄到用户气泡；助手不再有 `.chat-msg-body`。
  - `.chat-msg-assistant`：`flex-direction:row; gap:10px; align-self:stretch`。
  - `.chat-msg-avatar`：`flex:none; width:28px; height:28px; margin-top:2px; display:flex`。
  - `.chat-msg-main`：`flex:1; min-width:0; display:flex; flex-direction:column; gap:10px`。
  - `.chat-md`：`font-size:14px; line-height:1.75; overflow-wrap:anywhere; color:var(--wb-text-primary)`。子元素规则按 demo:429-442：
    - p、h1–h4、ul/ol/li 的间距与字号；
    - code：`var(--wb-code-bg)`/`var(--wb-code-border)`，`var(--wb-mono)` 12.5px；
    - pre：`overflow-x:auto`，radius 8，padding 12px 14px；pre code 去底去框；
    - blockquote：左边框 `var(--wb-brand-primary)`、底 `var(--wb-brand-primary-subtle)`、字 `var(--wb-text-secondary)`；
    - table：`display:block; overflow-x:auto; border-collapse:collapse`，th/td 边框 `var(--wb-border-default)`，th 底 `var(--wb-bg-hover)`；
    - strong：600；
    - `a`：`color:var(--wb-brand-primary); cursor:default`。
  - `.chat-caret`：`display:inline-block; width:7px; height:15px; margin-left:2px; vertical-align:-2px; border-radius:1px; background:var(--wb-brand-primary)`。动画由 `ui-caret` 提供，reduced-motion 已在 `motion.css` 覆盖。
  - ≤760 媒体块中 `.chat-msg-user { width:100% }` 改为 `max-width:100%`。

Sketch seams under test（issue 与父 4.1 写的是"`chat-page.test.tsx` 增断言"；该文件已 448 行，改为新建 `web/test/chat-messages.test.tsx`，沿用 `chat-page-support.tsx` 的 `renderChatPage`/`cleanupChatPage` 与 `chat-stream-support.ts` 的 `chatSnapshot`/`FakeEventSource`/`latestSource`/`SESSION_ID`；路由模式照 `chat-page.test.tsx:44-58`）：
- (M1) Markdown 与安全：已完成快照，助手 `content`：
  ````
  # 标题\n\n段落 **粗体** 与 `行内`\n\n```\n<script>alert(1)</script>\n```\n\n<img src=x onerror=alert(1)> [链接](https://example.com)
  ````
  在 `getByRole("article", { name: "助手" })` 内：
  - `getByRole("heading", { level: 1, name: "标题" })` 命中；`strong` 文本 `粗体`；
  - `pre > code` 的 textContent 为 `<script>alert(1)</script>`，行内 `code` 为 `行内`；
  - 整个 `document` 中 `querySelector("script")` 与 `querySelector("img")` 均为 null；
  - 助手 article 的 textContent 含字面 `<img src=x onerror=alert(1)>`；
  - 链接 `getByRole("link", { name: "链接" })` 的 `getAttribute("href")` 为 `#`，click 返回的事件 `defaultPrevented` 为 true（`fireEvent.click` 返回 false）。
- (M2) 用户气泡（保持性用例：运行期断言现即绿，只有静态选择器先红）：`chatSnapshot` 只提供固定 `historyUser`，需覆写快照 `messages[0].content` 为 `"第一行\n  第二行\n\n末行"`。
  - 用户 article 内 `p.chat-msg-body` 的 textContent 严格等于该字符串，且是 article 的首个 `p`。
  - 静态契约：`chat.css` 的 `.chat-msg-user .chat-msg-body {` 块含 `white-space: pre-wrap`，`.chat-msg-user {` 块含 `align-self: flex-end`。
- (M3) 光标生命周期：running 快照（助手 `content: "进行中"`，`assistantStatus: "running"`，cursor 同 `chat-page.test.tsx` 的 running 例）。
  - 助手 `.chat-md` 的 `lastElementChild` 为 `span.ui-caret.chat-caret[aria-hidden=true]`。
  - 通过 `latestSource()` 依次推送 `text.delta`（`"！"`）与 `turn.end` done 帧（帧格式照 `chat-page.test.tsx` 首例），然后 `waitFor` 断言 `.ui-caret` 在 document 中不存在，且正文为 `进行中！`。
  - 静态：`chat.css` 的 `.chat-caret {` 块含 `background: var(--wb-brand-primary)`。
- (M4) 头像与结构：已完成快照中：
  - 助手 article 首个子元素为 `span.chat-msg-avatar[aria-hidden=true]`，内含 `svg.ui-brand-mark`；
  - `within(assistantArticle).queryByRole("img")` 为 null；
  - 用户 article 无 `.chat-msg-avatar`；
  - 全页无 `.chat-msg-role`；
  - 助手 article 内的步骤卡（快照含一条 bash 步骤）位于 `.chat-msg-main` 内且在 `.chat-md` 之后。
- (M5) 静态契约（`readRepoFile`）：
  - `web/src/lib/md-render.ts` 含 `Markdown subset renderer ported from resource/workbuddy-live-demo.html:1145-1185`；
  - `web/src/features/files/md-render.ts` 不存在（`existsSync`）；
  - `preview.tsx` 含 `MarkdownView` 且不含 `function renderBlock`；
  - `conversation-view.tsx` 含 `MarkdownView` 与 `BrandMark`；
  - `listRepoFiles("web/src", …)` 的 ts/tsx 中均不含 `dangerouslySetInnerHTML` 与 `.innerHTML`；
  - `markdown-view.tsx` 不含 `from "../features` 与 `from "../ui`。
  - `chat.css` 无 `COLOR_LITERAL_PATTERNS` 命中。

Required evidence：
- M1–M5 在现实现上先红，记录原因；实现后转绿。
- `md-render.ts` 移动前后 `git diff -M` 显示 100% rename。
- 反向注入，各自变红后回退（记录失败的测试名）：
  1. 助手正文仍用 `<p>` 原文 → M1 红。
  2. `MarkdownView` 改用 `dangerouslySetInnerHTML={{ __html: mdRender(source) }}` → M5 红。M1 的 `href="#"`/`defaultPrevented` 行也应红，如实记录。
  3. 光标无条件渲染 → M3 done 后断言红。
  4. 光标不渲染 → M3 running 断言红。
  5. 头像不加 `aria-hidden` → M4 `queryByRole("img")` 红。
  6. 保留 `.chat-msg-role` → M4 红。
  7. 用户消息改走 `MarkdownView` → M2 红（多行被拆段，`p` 文本不等）。
  8. `preview.tsx` 保留旧渲染函数副本（不删）→ M5 红。
- `make check`、`npm run build --workspace web`、`(cd web && npx vitest run)`、CI 形态 ui-walk 全部 exit 0。

Not yet specified：
- 助手正文 Markdown 在流式中途（未闭合代码块等）的闪烁观感：解析器对未闭合块的既有行为不改，视觉由 6.3a 签收。
- 长会话逐帧全量 `parseMarkdown` 的性能：以 `useMemo` 按正文缓存，未做增量解析。消息体量在 S1e 范围内不构成瓶颈；如成为瓶颈，另开 issue。

Implementation deviations（Phase 1 记录）：
- M2 断言写成"article 首个 `p` 的文本等于原文且带 `.chat-msg-body`"，与 design 原写法等价。
- M4 先断言 `queryByRole("img")` 为 null，再检查 `firstElementChild`，使注入 5 失败在点名的断言上。
- `chat.css` 与清单的出入：
  - 补 `.chat-md hr`（demo:445，在引用范围内）。
  - `.chat-msg-user .chat-msg-body` 保留旧规则的 `margin: 0` 与 `color`。
  - `.chat-msg-assistant` 去掉旧 padding。
- `chat.css` 已 784 行（上限 800）：4.2 #287 步骤卡改版前须先拆分该文件。

