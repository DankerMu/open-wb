# Proposal: artifact-card（#536，父 tasks 7.5b）

## Why
7.5a 之后助手消息里有文件变更卡，但变更出来的网页、图片、文本只能跳到 `/files` 再找。本刀在文件变更卡之后按扩展名派生产物卡：网页在会话内隔离预览，图片下载，文本复制。内容只在用户点击时经既有预览 API 拉取，不预取、不存副本。

## What Changes
- 新建 `web/src/features/chat/artifact-card.tsx`：`ArtifactCards`（按消息汇总后逐项派生）与单张卡（三类操作、拉取纪律、html 预览 Dialog）。
- `stream-artifacts.ts`：加纯函数 `artifactKind(path)`（扩展名 → 类别、标签、文件名）。
- `conversation-view.tsx`：文件变更卡之后、`已停止` 徽章之前渲染产物卡；`client` 属性经 `ConversationView` → `MessageThread` → `MessageArticle` 传到卡片。
- `page.tsx`：`<ConversationView client={client} …>`（+1 行）。
- `messages.css`：产物卡与预览 iframe 的样式（demo:502-515，颜色只用既有 token）。
- 新建 `web/test/chat-page-artifact-card.test.tsx`。

## Fixture
- Level: `expanded`。
- Review priority: contract——iframe 隔离（sandbox 恰为 `allow-scripts`）是本刀的安全边界；拉取纪律（不预取、不并发、卸载 abort、Blob URL 撤销、失败无未处理拒绝）是 7.6 复用的同一实现。

## Spec deltas
- ADDED `turn-artifacts`「产物卡」。
- MODIFIED `turn-artifacts`「文件变更卡」：Scenario「空间不可解析」的 THEN 补回「也不渲染产物卡」（7.5a 归档时留给本刀的一句）。
- MODIFIED `chat-web`「会话页」：Assistant block order 加产物卡；Scenario「助手块次序」加 HTML 产物卡一项。

## Non-goals
- 文件变更卡、`files.changed` 解码归约（7.5a，已合并）；产物面板（7.6）；ui-walk 的 HTML 预览步骤（8.2a）。
- 预览 API 及其 1 MiB 截断、`web/src/lib/api.ts`（`fetchPreview` 原样消费）；服务端 HTML 预览端点、CSP；图片缩略图。
- `stream.ts`、`stream-steps.ts`、`file-changes-card.tsx`、`web/src/ui/**`、files feature、server 不动。

## 与 issue / 父 delta 的偏差（父 change 归档前 rebase 适用）
1. **一个既有测试文件有改动**：issue 写「既有测试零 diff」「既有测试文件不增长」。`web/test/chat-page-file-changes.test.tsx` 的 C13 对 `.chat-msg-main` 做全子元素断言，夹具路径是 `out/index.html`；产物卡出现后那两份期望列表各多一个元素（7.5a 的归档 PR 已预告）。只改这两处期望，别的不动。
2. **`stream-artifacts.ts` 与 `page.tsx` 有改动**：issue 的 PR Boundary 只列了 `artifact-card.tsx` 与 `conversation-view.tsx`。扩展名派生是纯函数，放在汇总函数旁边（7.6 也要用）；卡片要调 `fetchPreview`，而 API client 只在 `page.tsx` 里，所以多传一个 `client` 属性（+1 行，不含运算符，不增加 `ChatPage` 的认知复杂度）。不在卡片里另建 client：页面的归属判断按 client 身份比较。
3. **父文「`globe`、`download`、`package` 三个 lucide 名由本 change 加入注册表」一句不并入**：三者已在注册表（`web/src/ui/icon.tsx:93-95`，7.0 落的）。
4. **下载后的撤销延后一个宏任务**：父文「触发下载后撤销该 URL」。点击临时链接后同步撤销在部分浏览器里会让下载拿不到内容，延后一拍再撤销。
5. 子 delta 另加父文未写的可观察行为：无扩展名不派生；图片过大（413）与类型不符同样走失败 Toast；401 不另出 Toast；被 abort 的拉取不出 Toast；换账号同样 abort；user 消息不渲染产物卡；新增 Scenario「拉取中与卸载」。
6. **图标底色偏离 demo**：demo 的三种图标底色是字面 `rgba()`（demo:505-507），features 下的样式不允许字面颜色与 `--wb-palette-*`。html 用 `--wb-status-warning-soft-bg` + `--wb-status-warning-text`，代码用 `--wb-brand-primary-subtle` + `--wb-brand-primary`，图片没有对应的蓝色语义 token，用 `--wb-bg-tertiary` + `--wb-text-secondary`。
7. **卡片外层是 `<fieldset aria-labelledby>`**（隐含 role `group`），同 7.5a 偏差 8。
8. 只并入父 delta 的产物卡部分；「产物面板」Requirement 与顶栏入口归 7.6。

## Impact
- web：一个新产品文件、`stream-artifacts.ts`/`conversation-view.tsx`/`page.tsx`/`messages.css` 改动、一个新测试文件（可拆出一个 support 文件）、一个既有测试文件的两处期望列表。server 无改动。
- 运行时：只有用户点击产物卡的操作时才多一个 `GET /api/workspaces/:id/file` 请求。#522 合入前服务端不产生 `changes`，产物卡同文件变更卡一样只会出现在快照已带 `changes` 的步骤上。
- 依赖：#535 已合并。
