# Design: ui-walk-fork（#492）

参见父设计 D4（`design.md:66`：fork = 用户消息处分叉，临时进程 branch，201 `{session, draft}`，web 跳转并填草稿不发送）与 D8（`design.md:102`）。行号指 origin/master `577d2fc`。

篇幅超出 20–40 行，原因同 #484/#485：「无 prompt POST」的观察窗口与 mobile 后段的连带破坏只能靠真实 omp 实测；Required evidence 须逐条可执行。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**
- 用 `.github/scripts/ci-compiled-server.sh ui-walk` 起服务，env 与 CI `ui-walk` job 相同；Node 24.13.1；omp 为 `var/omp/omp`（v18.0.10），上游为仓内假上游；每遍全新 DB 与 omp state。
- 编译产物来自 HEAD（`npm run build --workspace server` 与 `--workspace web`）。
- 草稿：按「Change surface」改 `ui-walk-stop.ts`、`ui-walk.spec.ts`、`ui-walk-layout.ts`（biome 格式化后 spec 799 行）。实测后已还原（`cmp` 对原件一致），`git status` 只剩本 change 目录。M6 变异临时改过 `web/src/features/chat/turn-actions.ts` 并重建 web；已按原件还原、重建，`web/dist` 全部文件 SHA 与变异前一致，其后又跑一遍绿（G5）。
- 基线（未改 HEAD）同条件先跑 1 遍：全绿，旅程 12.1/12.6s。

**结果**
1. **草稿全绿**：终版连跑 4 遍（G2–G5），两个 project 均通过，旅程 12.1–12.7s（desktop）/ 13.1–13.2s（mobile）。满载（14 核 `yes` ×14）1 遍全绿，13.5/14.3s。另有 1 遍诊断草稿（断言集相同，加 E0-3 的日志）全绿。
2. **时序**（从步骤开始起算，含正文守护、等可用与点击；两个视口相近）：
   - fork POST 于 +19–23ms 发出（诊断），**201** 于 +560–611ms 到达（满载 782/1314ms）——服务端临时 omp 进程耗时；
   - 再 2–4ms URL `?session=` 等于 201 体新会话 id；再约 3ms `消息` region 可见、0 条 article、无 `重新生成`（满载 mobile +30ms）；
   - 再约 2ms 草稿恰为首条 prompt、`发送` 可用；侧栏 `<title> 未开始`：desktop 再 2–3ms，mobile 再 26–32ms（开关覆盖层）。
3. **守护观察**（一次性诊断草稿，未进入实测代码）：
   - 点击起至侧栏断言，页面发出的请求依次为：`POST …/<walked>/fork`、`GET /api/sessions`（列表刷新）、`GET …/<fork>/messages`、`GET …/<fork>/events`、`GET …/<fork>/messages`；无任何 prompt POST。
   - 201 体 `draft` 恰为首条 prompt `WORKBUDDY_UI_WALK:<首个 gate id>`（omp 回显无截断、无空白变化，carry-forward :107）。REST：新会话 `idle`、`messages: []`、标题 `WORKBUDDY_UI_WALK:`（复制源标题）；列表顺序新会话第一、源会话第二。
   - 分叉后 `document.activeElement` 为 `BODY`（两个 project，carry-forward :126）；按钮 `title="从此处分叉"`，操作条 opacity 1。
   - 旅程后段：回到 `/` 欢迎态时 composer 仍带草稿（page 级 state），欢迎首屏断言照过；mobile 选中的是本 project 的走查会话（非 `未开始`），草稿仍在；`设置` 路由无对话框；登出流程照常。
4. **mobile 连带破坏**：不改 `selectFirstSessionInOverlay` 时，`mobile-dark` 红于 `ui-walk.spec.ts:123`（`article 助手` 5s 未找到），desktop 绿。即 E2 M7，草稿首跑与终版各复现一次。
5. **变异**：见 Required evidence E2。

## Change surface
- `web/e2e/ui-walk-stop.ts`：
  - 头注释（`:1-4`）加两行分叉说明；`@playwright/test` import 加 `type Request`；
  - 常量：`SESSION_ID = /^[0-9a-f]{32}$/`、`PROMPT_PATH = /^\/api\/sessions\/[^/]+\/prompt$/`；
  - `sessionPost`（`:19`）端点联合加 `"fork"`；
  - 新增导出 `walkFork(page, project, sessionId, prompt)`，复用本模块已 import 的 `inspectSidebar`，仿 `walkRegenerate` 的 `mark()` 在 fork 201、URL、空转录、草稿、侧栏各打一点（Node 侧 `console.log`）。监听在 `try` 内使用、`finally` 里 `page.off`。
- `ui-walk.spec.ts`：`:38` 改为 `import { walkFork, walkRegenerate, walkStop } from "./ui-walk-stop.js";`；`:341` `walkRegenerate(...)` 之后、`:342` `} finally {` 之前加 `await walkFork(page, project, sessionId, prompt);`。
- `ui-walk-layout.ts`：`selectFirstSessionInOverlay`（`:309-314`）在 `button.chat-session-button` 上加 `.filter({ hasNot: page.getByRole("status", { name: / 未开始$/u }) })` 再 `.first().click()`；注释改为「首个有消息的会话，跳过 `未开始`——列表按 updated_at 倒序，分叉出的空会话排在最前」。其余两行 expect 不变。

## 行数预算（显式）
- 本刀：798 + 0（import 行复用）+ 1（调用行）= **799/800**，biome 格式化后实测 799。helper 修复在 `ui-walk-layout.ts`，spec 零行。
- 之后 spec 只剩 1 行余量；再加步骤须先做纯搬迁（如 `walkScrollFollow` 族）。
- `ui-walk-stop.ts` 157 → 226 行，`ui-walk-layout.ts` 561 → 567 行，远低于 800。

## Must preserve
- 停止、重新生成步骤的全部断言与次序；`walkStop`/`walkRegenerate` 零改动。
- 禁止区间：`forbidFurtherMessagesGet`（`ui-walk.spec.ts:327`）至 `assertNoForbiddenMessagesGet`（`:330`），由 `detach()`（`:332`）关闭。新步骤在 `:341` 之后，区间不被延长；步骤内的 2 次 messages GET 在区间外。
- 第一个 gate 的 `finally deleteGate`（`:342-344`）不变。分叉不跑回合，本步骤不 arm gate。
- error oracle（`ui-walk-oracle.ts`）不改：恰两次 `/api/auth/me` 401，零 console/page error。
- 旅程后段 `ui-walk.spec.ts:115-150` 不改；`:121-124` 的 #424 断言原文不变，只改其调用的 helper 的选择条件。

## Must add/change（步骤，按序；locator 都限定在首条用户 article、`main`、form 或侧栏当前按钮内）
`first = page.getByRole("article", { name: "用户" }).first()`；`fork = first.getByRole("button", { name: "从此处分叉", exact: true })`。
1. 守护：`first.locator(".chat-msg-body")` `toHaveText(prompt)`（决定 5）；`fork` `toBeEnabled()`（composer 锁定期间禁用，`conversation-view.tsx:154`）。
2. `page.on("request", onRequest)`：记录 method 为 POST 且 pathname 匹配 `PROMPT_PATH` 的请求路径，不限会话（决定 3）。
3. 先挂 `sessionPost(page, sessionId, "fork")`，点 `fork`，断言 **201**；解析 201 体取 `session.id`。走查不发任何 raw HTTP fork。
4. URL：`expect.poll(() => URL 的 session 参数).toBe(body.session.id)`；再断言它匹配 `SESSION_ID` 且 `≠ sessionId`。
5. 空转录（决定 4）：`main` 内 `region 消息` 可见（E0 所用；论证只依赖存在，`toHaveCount(1)` 亦可） → `main` 内 `article` 数量 0 → `main` 内 `button 重新生成`（`exact`）数量 0。
6. 草稿：`getByLabel("给助手发消息")` `toHaveValue(prompt)`（精确相等）；form 内 `发送`（`exact`）可用——草稿非空且 fork 锁已释放（`page.tsx:33-35`）。
7. 侧栏：`inspectSidebar(page, project, …)`，`navigation 会话列表` 内 `button[aria-current="true"]` 数量 1，读其 `aria-label` 作 `<title>`，其 `role=status` 的 accessible name 须为 `<title> 未开始`。
8. `expect(prompts, "no prompt POST after fork").toEqual([])`；`finally` 里 `page.off`。

**观察窗口**：开于步骤 2（点击之前），关于步骤 8（侧栏断言之后）。实测窗口在 201 之后约 25–35ms 关闭。理由与残余见 proposal 决定 3。

**不等 Toast**：分叉无 Toast（`message-actions.tsx:61-79`）。mobile 侧栏检查仍经 `inspectSidebar`（开覆盖层、Escape 关闭），E0 全绿。

**超时**
- expect 默认 5s；`waitForResponse` 与点击用 `actionTimeout` 10s（`playwright.config.ts:25`）；fork 201 实测最长 1.31s（满载）；单测 30s（本机满载最长 14.3s）。

## Governing invariant
步骤通过时，浏览器停在一个新的、服务端为 `idle` 且零消息的会话上，composer 持有首条用户消息的原文；点击以来（至侧栏断言），页面没有为任何会话发出 prompt POST。

## Spec 对账
- 主 spec（#485 归档后）与父 delta 的「UI 走查对话步骤」块 word-diff 只有四处：分叉步骤句、两处枚举「stop and regenerate」→「stop, regenerate and fork」、Scenario「分叉走查」。主 spec 无父块缺失的文字。
- 子 delta 块 = 父块原文：抽出两块后 `cmp` 一致。archive 时父块无需改写，只勾选父 tasks 8.2d。

## Sibling surfaces
- **必然变红、需要编辑的既有调用**：`ui-walk.spec.ts:122` 经 `selectFirstSessionInOverlay` 点到空分叉会话，`:123` 红（E0-4）。改 helper 的选择条件，不改断言。
- **已核对、不受影响**：`expectSessionListInSidebar`（不看具体项）；`expectWelcomeFirstScreen`（草稿在欢迎态 composer 里，首屏断言照过）；`expectSelectedSessionStatus` 仅经 `expectRunningPrefix`（`:730`）/`expectCompletedPair`（`:796`）调用，均在分叉步骤之前，不受影响；设置/主题/登出（ChatPage 卸载，草稿消失，无对话框）。
- **恒绿、零 diff**：`ui-walk-oracle.ts`、`ui-walk-gate.ts`、`ui-walk-approval.ts`、`route-hold.ts`、`fake-upstream.mjs`、`playwright.config.ts`、Makefile、`ci.yml`、`.github/scripts/*`、`web/src/**`、server。

## Seams under test
- 真实浏览器：`make ui-walk` 两个 project，由调用方自起服务。本机用 `ci-compiled-server.sh ui-walk`（E0 条件），CI 用 job `ui-walk`。
- 分叉：web `forkTurn`（`web/src/features/chat/turn-actions.ts:368-410`）在 201 后 `setDraft` → `refreshList` → `selectSession`；`forkSession` 发 JSON `{messageId}` 且带 `Content-Type: application/json`（`web/src/lib/api-sessions.ts:167-185`）；服务端「从此处分叉 REST」（主 spec turn-control）经真 omp 临时进程完成 branch。
- 列表次序：`server/src/sessions/store.ts:248`（`ORDER BY updated_at DESC`）；分叉行 `created_at = updated_at = now`（`store-branch.ts:166`、`:210`）。

## Required evidence
（R = 先红后绿；G = 守护、恒绿）
- **E1 G**：`make ui-walk` 两个 project 退出 0，按 E0 条件连跑 ≥3 遍，另在满载下跑 1 遍。步骤时序日志（fork 201、URL、空转录、草稿、侧栏）记入 PR body。
- **E2**：每个变异单独施加（M6 系列另需改 `turn-actions.ts` 并重建 web，测后还原、重建并核对 `web/dist`）。
  - M1 R 删掉点击：两个 project 红于 fork `waitForResponse` 超时（10s）。E0 实测如此。
  - M2 R 草稿期望改为 `prompt.slice(0, -1)`：两个 project 红于 `toHaveValue`（Received 完整 prompt）——精确相等，不是前缀/包含。E0 实测如此。
  - M3 R 改点第二条用户消息（`users.nth(1)`）的 `从此处分叉`：两个 project 红于空转录 `article` 数量（Received 2：分叉点之前的 1 用户 + 1 助手）。E0 实测如此。
  - M3b R M3 再删掉 `article` 数量与 `重新生成` 数量两条断言：两个 project 红于 `toHaveValue`（Received 第二条 prompt `WORKBUDDY_UI_WALK:<第二个 gate id>`）——草稿断言独立区分分叉点。E0 实测如此。
  - M4 R 侧栏期望改为 `<title> 已完成`：两个 project 红于 `toHaveAccessibleName`（Received `WORKBUDDY_UI_WALK: 未开始`）。E0 实测如此。
  - M5 R 在步骤 8 之前插入 `composer.press("Enter")`（草稿与侧栏断言都已通过后发送）：两个 project 红于 `no prompt POST after fork`（Received `["/api/sessions/<fork id>/prompt"]`）——只有网络观察能抓到。E0 3 遍，两个 project 均红（6/6）。
  - M6a R 产品代码自动发送：`forkTurn` 在 `selectSession(...)` 之后加 `void ownedClient.prompt(fork.session.id, fork.draft).catch(() => undefined);`：两个 project 先红于空转录 `article` 数量（Received 2）。E0 1 遍。
  - M6b R M6a 且删掉步骤 8：仍红于同处（E0 1 遍，两个 project）。这是有利次序下的观察，不是保证：空转录能否抓到取决于服务端先处理 prompt 插入还是先响应新会话首个 messages GET（`toHaveCount(0)` 一旦见 0 即通过）。窗口内发出的请求，由网络观察无竞态地守护；其独有承重由 M5 证明。
  - M6c G 产品代码延迟发送：同 M6a 但包在 `setTimeout(…, 300)` 里：两个 project 全绿、整条旅程全绿。窗口外的定时发送不可见（决定 3 残余），PR body 如实记录。
  - M7 R 还原 `selectFirstSessionInOverlay`：desktop 绿，`mobile-dark` 红于 `ui-walk.spec.ts:123`（`article 助手` 5s 未找到）。E0 实测如此。
- **E3 G**：`make lint`、`make typecheck` 绿；`wc -l web/e2e/ui-walk.spec.ts` ≤800（预期 799）。
- **E4 G**：`git diff --stat origin/master` 只含 `web/e2e/ui-walk-stop.ts`、`web/e2e/ui-walk.spec.ts`、`web/e2e/ui-walk-layout.ts` 与本 change 目录；Makefile、CI、env、`web/src`、server 零 diff。
- **E5（仅 CI）**：PR CI `ui-walk` job 绿（不传 `OMP_MAX_PROCESSES`）。

## Non-goals
见 proposal。

## Review focus
1. 「无 prompt POST」的网络观察：监听先于点击、不限会话；窗口的因果终点（侧栏断言）与 M6c 残余（决定 3）。
2. 空转录先等 `消息` region 可见再数 article，不被加载态满足（决定 4）。
3. 定位不靠会话名：URL 与 201 体交叉核对、侧栏只看 `aria-current`；按钮限定首条用户 article，点击前等可用。
4. `selectFirstSessionInOverlay` 跳过 `未开始` 保住 #424 断言意图，spec 零行；spec 799/800，import 行复用。
