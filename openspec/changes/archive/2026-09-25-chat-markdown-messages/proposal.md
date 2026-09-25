# Proposal: chat-markdown-messages（#286）

## Why
S1e 组 4 首刀 4.1，依赖 #275（`BrandMark` 与 motion 工具类），已合入。

审查报告 `docs/reviews/2026-09-24-demo-parity-audit.md` §4 把会话消息呈现列为实现偏差。现状与 demo（demo:2378-2406,420-446）的差距：
- 会话页消息（`web/src/features/chat/conversation-view.tsx:104-126`）一律把正文放进 `<p className="chat-msg-body">`，以 `pre-wrap` 显示原文；助手的 Markdown 不渲染。
- 每条消息上方有可见角色标签 `助手/用户`；demo 没有，助手行左侧是头像。
- 流式中没有光标。

父 design 决策 8（D8）已拍板以下三点：
- `md-render.ts` 物理移到 `web/src/lib/`，头注释与来源不变。
- `lib/markdown-view.tsx` 由 files 与 chat 共用。
- running 助手正文容器尾部放 `<span class="ui-caret" aria-hidden>`。

## What Changes
- `git mv web/src/features/files/md-render.ts web/src/lib/md-render.ts`。文件内容逐字节不变，头注释与来源说明保留。
- 新 `web/src/lib/markdown-view.tsx`：
  - 从 `features/files/preview.tsx` 原样搬入 React 渲染器（`preventInertNavigation`、`renderInlineElement`、`renderInline`、`MarkdownHeading`、`renderBlock`），逻辑不改。
  - 导出 `MarkdownView({ source }: { source: string })`，内部 `useMemo(() => parseMarkdown(source), [source])`，返回块元素 Fragment。外层容器由调用方提供。
  - 安全策略不变：只产出 React 元素，不用 `dangerouslySetInnerHTML`；链接 `href="#"` 且不可跳转；源 HTML 为文本。
- `features/files/preview.tsx`：
  - `RenderedMarkdownDocument` 改为 `<div className="files-md" data-markdown-body=""><MarkdownView source={text} /></div>`。
  - 删去搬走的渲染函数，import 改到 `../../lib/`。
  - files 行为与 DOM 不变。
- `features/chat/conversation-view.tsx` 的 `MessageArticle`：
  - 删可见角色标签 `.chat-msg-role`；`article` 的 `aria-label` `用户`/`助手` 不变。
  - 用户消息：`<p className="chat-msg-body">` 原文不变，气泡样式按 demo `.msg-user`。
  - 助手消息：
    - 左侧装饰性头像 `<span aria-hidden="true" className="chat-msg-avatar"><BrandMark size={28} /></span>`。
    - 右侧 `.chat-msg-main` 内依次为 `.chat-md` 正文容器（`MarkdownView` + running 时尾部 `<span aria-hidden="true" className="ui-caret chat-caret" />`）、步骤卡、错误。
- `chat.css`：用户气泡、助手行与头像、`.chat-md` Markdown 排版、`.chat-caret` 光标块，按 demo:420-446 移植，只用语义 token。
- 测试：
  - 新 `web/test/chat-messages.test.tsx`：M1–M5。
  - `web/test/md-render.test.ts`、`web/test/preview.test.tsx` 的 import 路径改到 `../src/lib/md-render.js`。

## Non-goals
- 步骤卡改版（4.2 #287）。
- 操作条 `复制`（4.6）。
- `回到最新` 与自动跟随（4.5）。
- composer、状态（4.3 已合入）。
- 欢迎态（4.4 已合入）。
- files 的 Markdown 视觉。
- `mdRender` 字符串序列化的调用方（只有测试在用，保持导出）。

## Capabilities
- MODIFIED `chat-web`：Requirement「会话页」以已晋升文本为底：
  - 删去旧句 "Messages SHALL preserve complete text and whitespace using safe rendering."：它要求助手原文空白原样保留，与 Markdown 渲染冲突。
  - 在 Welcome state 段后插入父 delta **Messages** 段中属于本刀的句子（用户气泡、助手块与头像、共享安全 Markdown、running 光标）。补充两处：头像为装饰性；源 HTML 转义且不注入。
  - 不含 `复制`、步骤卡与 `回到最新` 句。
  - 新增 Scenario「消息呈现与流式光标」，为父 Scenario「消息与步骤呈现」中属于本刀的子集。
- `files-web`：不改。`文件预览纯组件` 的契约不提文件路径，父 delta 已声明 md-render 移位不改其契约。

## Impact
- 移动：`web/src/features/files/md-render.ts` → `web/src/lib/md-render.ts`。
- 新增：`web/src/lib/markdown-view.tsx`、`web/test/chat-messages.test.tsx`。
- 修改：`web/src/features/files/preview.tsx`、`web/src/features/chat/{conversation-view.tsx,chat.css}`、`web/test/{md-render.test.ts,preview.test.tsx}`（仅 import）。
- 不加依赖，不动服务端、`web/src/ui/**`、`web/e2e/**`。

## 与 oracle 偏差留痕
- 删去可见角色标签：demo 没有；可访问名继续由 `article` 的 `aria-label` 提供。
- 空内容的 running 助手：demo 不渲染正文容器，因而也没有光标（demo:2390）。本刀在 running 时总渲染 `.chat-md` 容器与光标，作为生成中的可见反馈。spec 句 "after the last character" 在空文本时退化为容器内唯一元素。

- 助手块内顺序：demo:2389 为步骤卡在正文之前。本刀改为正文 `.chat-md` 在前、步骤卡在后，原因是 ui-walk `:750/:796` 以 `locator("p").first()` 取助手文本，依赖正文在前。4.2 步骤卡改版与 6.4 清单继承此顺序。
- 过渡期信息损失：Markdown 渲染后，链接目标地址与 `**`、围栏等标记不再可见；原文保全由父 delta 的 `复制`（4.6）提供，4.6 合入前只能从会话历史 API 取原文。子 delta 因此把父句 "SHALL preserve complete text (whitespace per Markdown semantics; `复制` copies the raw text)" 写成 "visible text following Markdown semantics (markup consumed, link destinations dropped)"。

## Risk triage
- Markdown 进入会话页即安全边界复用：助手文本来自模型，可含任意 HTML 或 Markdown。复用同一解析器与 React 渲染器，不引入 HTML 注入。M1 钉住 `<script>`、`<img onerror>` 以文本出现且无元素。
- 既有 jsdom 用例以 `getByText(…, exactText)` 断言助手原文（`chat-page.test.tsx:124,148,162`、`chat-page-ownership*.test.tsx`）。
  - 单行纯文本经 `parseMarkdown` 成为单个 paragraph，文本逐字保留，含尾随空格、`\u0000`、`﻿`。已用 node 对 `"Hello "`、`"Hello \u0000﻿中文 😀"` 实测。
  - 这些用例保持绿；多行助手文本的既有用例不存在（已 grep）。
- ui-walk 以 `pair.assistant.locator("p").first()` 断言助手文本（`web/e2e/ui-walk.spec.ts:750,796`）。Markdown 首段即首个 `<p>`，fake upstream 回复是单行纯文本，保持绿。
  - 助手正文为空时首个 `<p>` 可能落在步骤卡内。`:750` 是 poll，内容到达后首段 `<p>` 在步骤卡之前，不受影响。
- 移动 `md-render.ts` 必须同 PR 改 import，否则 tsc 与测试红。
