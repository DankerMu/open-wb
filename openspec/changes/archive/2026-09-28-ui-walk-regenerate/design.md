# Design: ui-walk-regenerate（#485）

参见父设计 D3（`design.md:58`：重新生成 = 末条助手消息、非 running、branch 后重发）与 D8（`design.md:102`）。行号指 origin/master `b7be8e3`。

篇幅超出 20–40 行，原因同 #484：gate 前置与「已替换」判据只能靠真实 omp 实测；Required evidence 须逐条可执行。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**
- 用 `.github/scripts/ci-compiled-server.sh ui-walk` 起服务，env 与 CI `ui-walk` job 相同；Node 24.13.1；omp 为 `var/omp/omp`（v18.0.10），上游为仓内假上游。
- 编译产物来自 HEAD（`npm run build --workspace server` 与 `--workspace web`）。
- 草稿：按「Change surface」改 `ui-walk-stop.ts` 与 `ui-walk.spec.ts`（biome 格式化后 spec 798 行）。实测后已还原，`git status` 只剩本 change 目录。
- 基线（未改 HEAD）同条件先跑 1 遍：全绿，旅程 9.3/9.6s。

**结果**
1. **草稿全绿**：连跑 5 遍（其中 1 遍带 REST 诊断日志，断言集相同），两个 project 均通过，旅程 11.6–12.8s。满载（14 核 `yes` ×14）1 遍全绿，14.0/13.9s。
2. **时序**（从步骤开始起算，含 DELETE、GET 404、点击；两个视口相近）：
   - regenerate 响应 **202** 在 19–30ms（满载 40–45ms）；请求无 `content-type`、无 body（web 客户端发出，carry-forward :109）；
   - 再约 2ms Toast `正在重新生成…` 可见，再约 1ms 徽章 `助手消息 已停止` 消失；
   - 约 +50ms 末条助手 `.chat-md` 精确为原回复全文；约 +60ms composer 解锁断言全过；
   - Toast 在 +2.85–2.92s 消失，侧栏 `WORKBUDDY_UI_WALK: 已完成` 断言在其后 4–32ms 通过。
3. **守护观察**（一次性诊断草稿，未进入实测代码）：
   - REST 快照：步骤前会话 `stopped`，消息 `[1 user done, 2 assistant done, 3 user done, 4 assistant stopped(3 字)]`；步骤后会话 `done`，`[1, 2, 3, 5 assistant done(25 字)]`。末条助手换了 id，用户消息 id 不变；mobile 同形（9→10）。
   - 步骤期间 messages GET 共 2 次（202 后的快照重装与回合结束对账），都在禁止区间之外。
   - 重放回合没有 bash 步骤、没有审批条：`omp branch` 后的历史里已有首轮 tool result，`hasToolRole` 为真（`fake-upstream.mjs:112-117`、`:371-375`），直接进 `serveFinal`；gate 不存在时走 `:137` 的整段 `textFrames`。
4. **Toast 泄漏**：见 E2 M4。
5. **变异**：见 Required evidence E2。

## Change surface
- `web/e2e/ui-walk-stop.ts`：
  - `sessionPost`（`:15-21`）端点联合加 `"regenerate"`；
  - `walkStop`（`:25`）返回类型改 `Promise<string>`，在 `try` 末尾（侧栏检查之后）`return gateId`；finally（`:85-87`）不变；
  - 新增导出 `walkRegenerate(page, project, sessionId, gateId)`，复用本模块已 import 的 `deleteGate`/`gatePhase`/`controlOrigin`、`generatingStatus`、`inspectSidebar`，不新增 import；仿 `walkStop` 的 `mark()` 在 regenerate 202、Toast 可见、徽章消失、原回复、Toast 消失各打一点（Node 侧 `console.log`，不进浏览器 error oracle）。
- `ui-walk.spec.ts`：`:38` 改为 `import { walkRegenerate, walkStop } from "./ui-walk-stop.js";`；`:340` 改为 `const stopGate = await walkStop(page, project, sessionId);`，其后、`:341` `} finally {` 之前加 `await walkRegenerate(page, project, sessionId, stopGate);`。

## 行数预算（显式）
- 本刀：797 + 0（import 行复用）+ 1（调用行）= **798/800**，biome 格式化后实测 798。
- #492 只剩 2 行：须复用已有 import 行（从已 import 的模块导出分叉步骤），只加 1 行调用 → 799；或先做纯搬迁。
- `ui-walk-stop.ts` 88 → 150 行，远低于 800。

## Must preserve
- 停止步骤的全部断言与次序（`ui-walk-stop.ts:42-84`）；返回值只加在 `try` 末尾，finally 的 DELETE 照旧先于调用方拿到 id。
- 禁止区间：`forbidFurtherMessagesGet`（`ui-walk.spec.ts:327`）至 `assertNoForbiddenMessagesGet`（`:330`），由 `detach()`（`:332`）关闭。新步骤在 `:340` 之后，区间不被延长；E0-3 的 2 次 GET 在区间外。
- 第一个 gate 的 `finally deleteGate`（`:341-343`）不变。本步骤不 arm 新 gate，不需要自己的 `try/finally`。
- error oracle（`ui-walk-oracle.ts`）不改：恰两次 `/api/auth/me` 401，零 console/page error。
- 旅程后段 `ui-walk.spec.ts:115-150` 不改。

## Must add/change（步骤，按序；locator 都限定在 `page.locator("form")`、第二条助手 article、侧栏当前按钮或通知 region 内）
`second = page.getByRole("article", { name: "助手" }).nth(1)`：按位置定位。重新生成后末条助手换了 id（React 以新 key 重挂），按位置的 locator 自动指向新 article。
1. `deleteGate(origin, gateId)`，再 `expect.poll(gatePhase)` 为 `status:404`（决定 2）。
2. 点击前：`second` 内徽章 `助手消息 已停止`（`exact`）可见，证明点的是被停止的那条。
3. 先挂 `waitForResponse`（`POST /api/sessions/<id>/regenerate`），点 `second.getByRole("button", { name: "重新生成", exact: true })`，断言 **202**。走查不发任何 raw HTTP regenerate。
4. Toast：`getByRole("region", { name: /通知/ }).getByText("正在重新生成…", { exact: true })` 可见（`…` 为 U+2026，逐字取 `message-actions.tsx:45`）。
5. 已替换判据（决定 3）：
   - `second` 内徽章数量 0；
   - `second.locator(".chat-md")` 精确为 `你好，这是 WorkBuddy 的第一条流式回复。`（`fake-upstream.mjs:12` 的三段拼接，与 `ui-walk.spec.ts:46` 相同）；
   - `second` 内 `group 需要你的确认` 数量 0、`region bash` 数量 0、`role=alert` 数量 0（无审批：bash 卡片比审批条更持久，漏看瞬时审批条也会留下它）；
   - 用户、助手 article 各恰 2。
6. 解锁：`给助手发消息` 可用；form 内 `发送` 可见、`停止` 数量 0、`生成中` 数量 0；`second` 内 `重新生成` 可用（决定 5）。
7. `expect(toast).toHaveCount(0, { timeout: 10_000 })`，放在侧栏检查之前（#643）。点击后指针停在消息操作条上；Toast 在 `top:52px`，实测消失时点与 2.4s 时长加退场一致，未见悬停暂停。
8. 侧栏：`inspectSidebar(page, project, …)`，在 `navigation 会话列表` 内找 `button[aria-current="true"]`，数量 1；读其 `aria-label` 作 `<title>`，其 `role=status` 的 accessible name 须为 `<title> 已完成`。

**「done 状态」的 DOM 证据**：无徽章、无 alert，新末条带可用的 `重新生成`（只挂在非 running 且会话为 done/failed/stopped 的末条上，`conversation-view.tsx:38-39`、`:127`、`:157-161`），侧栏 `已完成`。

**超时**
- expect 默认 5s；`waitForResponse` 与点击用 `actionTimeout` 10s（`playwright.config.ts:25`）；Toast 等待 10s；单测 30s（本机满载最长 14.0s）。

## Governing invariant
点击 `重新生成` 只在第二个 gate 的 GET 为 404 之后发生；步骤通过时，末条助手必然已是新一轮完整回复，而不是残留的已停止前缀。

## Sibling surfaces
- **必然变红、需要编辑的既有断言**：无（E0-1 全绿）。允许的既有文件改动**仅** `walkStop` 的返回类型与 `return`、`ui-walk.spec.ts` 的 import 名与调用点。
- **会被 Toast 泄漏打破的相邻面**：步骤自己的侧栏检查（步骤 8）与调用点之后的 `ui-walk.spec.ts:117`（`expectAuthenticatedRoute` → `ui-walk-layout.ts:354`）、`:118`（`test.step` → `expectSessionListInSidebar` → `:281`）、`:127`（设置路由）。步骤 7 就是为它们而设，不改这些断言。
- **不受影响**：`dialoguePair` 的「恰 1 条」断言（`:715-716`）只在停止步骤之前使用。
- **恒绿、零 diff**：`ui-walk-oracle.ts`、`ui-walk-gate.ts`、`ui-walk-approval.ts`、`ui-walk-layout.ts`、`route-hold.ts`、`fake-upstream.mjs`、`playwright.config.ts`、Makefile、`ci.yml`、`.github/scripts/*`、`web/src/**`。

## Seams under test
- 真实浏览器：`make ui-walk` 两个 project，由调用方自起服务。本机用 `ci-compiled-server.sh ui-walk`（E0 条件），CI 用 job `ui-walk`。
- gate：`gatePhase` 未知 id 返回 `status:404`（`ui-walk-gate.ts:52-56`）；armed gate 让重放回合进 `holdFinal`（`fake-upstream.mjs:133-135`），held gate 让它 409（`:128-131`）。
- 重新生成：web `regenerateTurn`（`web/src/features/chat/turn-actions.ts:308-364`）在 202 后关旧源、取快照重装、开新源；服务端「重新生成 REST」（主 spec turn-control）。

## Required evidence
（R = 先红后绿；G = 守护、恒绿）
- **E1 G**：`make ui-walk` 两个 project 退出 0，按 E0 条件连跑 ≥3 遍，另在满载下跑 1 遍。步骤时序日志（regenerate 202、Toast 可见、徽章消失、原回复、Toast 消失）记入 PR body。
- **E2**：每个变异单独施加。
  - M1 R 不点 `重新生成`：两个 project 红于 regenerate `waitForResponse` 超时（10s）。E0 实测如此。
  - M2 R 步骤 1 整体（DELETE 与其后的 GET-404 轮询）替换为 `armGate(origin, gateId)`（重新 arm 同一 id，不删、不轮询 404）：两个 project 红于步骤 5 的精确原回复（5s，Received `你好，`）；此前徽章已消失。E0 实测如此，证明 gate 前置是承重的、徽章不足以证明完成。
  - M3 R 侧栏期望改为 `<title> 已停止`：两个 project 红于 `toHaveAccessibleName`（Received `WORKBUDDY_UI_WALK: 已完成`）。E0 实测如此。
  - M4 去掉步骤 7：`mobile-dark` 间歇红于 `ui-walk-layout.ts:269`，desktop 恒绿。E0 9 次红 8 次，调用方为 `ui-walk.spec.ts:117` ×2、`:118`（`test.step` 帧）×3、`:127` ×2、步骤自己的侧栏检查 ×1。只记录，不要求每次复现。
  - M5 R 改点 `assistants.nth(0)` 的 `重新生成`：两个 project 红于点击超时（10s）——首条助手没有该按钮，定位按位置限定有效。E0 实测如此。
  - M6 G 删掉步骤 1：两个 project 仍绿（E0 实测）。`walkStop` 已使 gate 为 404，此前置在正常路径上是防御性的（决定 2），承重性由 M2 证明。PR body 如实记录。
- **E3 G**：`make lint`、`make typecheck` 绿；`wc -l web/e2e/ui-walk.spec.ts` ≤800（预期 798）。
- **E4 G**：`git diff --stat origin/master` 只含 `web/e2e/ui-walk-stop.ts`、`web/e2e/ui-walk.spec.ts` 与本 change 目录；Makefile、CI、env、`web/src` 零 diff。
- **E5（仅 CI）**：PR CI `ui-walk` job 绿（不传 `OMP_MAX_PROCESSES`）。

## Non-goals
见 proposal。

## Review focus
1. DELETE + GET 404 先于点击；`deleteGate` 吞状态码，GET 404 才是承重断言。
2. 「已替换」= 徽章消失 + 精确全文 + 恰 2+2，不是单看徽章（M2）。
3. 所有 locator 都限定作用域：`second`（按位置）、form、侧栏当前按钮、通知 region；`重新生成`/`发送`/`停止` 用 `exact`。
4. 不断言重新生成回合的瞬时运行态，不点 `停止`（carry-forward :118）。
5. Toast 等待是有上限的 DOM 条件，放在侧栏检查之前；spec 798 行，import 行复用。
