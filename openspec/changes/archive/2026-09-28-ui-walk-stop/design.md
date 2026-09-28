# Design: ui-walk-stop（#484）

参见父设计 D8（`design.md:107`：ui-walk 用同会话第二个受控 prompt，以 `held` 为 running 点）。行号指 origin/master `4d01265`。

篇幅超出 20–40 行，原因有二：
- 同步点与 gate 生命周期只能靠真实 omp 实测；
- Required evidence 须逐条可执行。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**
- 用 `.github/scripts/ci-compiled-server.sh ui-walk` 起服务，env 与 CI `ui-walk` job 相同；omp 为 `var/omp/omp`（v18.0.10），上游为仓内假上游。
- 编译产物来自 HEAD（`npm run build --workspace server` 与 `--workspace web`）。
- 草稿：新建 `web/e2e/ui-walk-stop.ts`；`ui-walk.spec.ts` 加 1 行 import，并在 `:338` 后加 1 行调用。实测后已删除并还原，`git status` 只剩本 change 目录。

**结果**
1. **草稿全绿**：两个 project 均通过，旅程约 9.0s / 9.5s。
2. **时序**（从 arm 起算，两个视口相近）：
   - prompt 202 约 12ms；`held` 约 117ms，此时第二条助手 `.chat-md` 已为 `你好，`；
   - 点击后 stop 响应 **202**，请求无 `content-type`（web 客户端发出，非走查 raw HTTP）；
   - 约 3ms 后 Toast `已停止生成` 可见，再约 3ms 徽章 `助手消息 已停止` 可见；**此时 gate 已是 404**；
   - composer 恢复 `发送`，侧栏状态元素名为 `WORKBUDDY_UI_WALK: 已停止`（标题取自当前按钮的 `aria-label`）；
   - 步骤至 404 断言共约 0.2s；Toast 约 2.9s 后消失。
3. **守护观察**：
   - 停止后仍恰 2 条用户、2 条助手 article，第二条助手正文仍恰为 `你好，`，无 `role=alert`；
   - 步骤期间 messages GET 共 2 次，都在 `held` 之前（发送后的页面对账），停止之后为 0；
   - 与 #482 E0 不同，abort 后没有多出空 assistant（那次是审批挂起时的停止）。
4. **Toast 泄漏**：步骤末尾不等 Toast 消失时，9 次里红 5 次，都在 `mobile-dark`。
   - 失败点是后续覆盖层 `inspectSidebar` 按 Escape 后，`dialog 导航` 5s 内仍为 1（`ui-walk-layout.ts:269`）；
   - 调用方为 `ui-walk.spec.ts:126`（设置 路由的 `expectAuthenticatedRoute` → layout `:354`）×4、`:117-118`（`expectSessionListInSidebar` → layout `:281`）×1；
   - 加 `await expect(toast).toHaveCount(0, { timeout: 10_000 })` 后 12/12 绿，其中 2 次在 14 核满载（`yes` ×14）下：旅程 10.0–11.5s，单测上限 30s。
5. **变异**：见 Required evidence E2。

## Change surface
- 新建 `web/e2e/ui-walk-stop.ts`：导出一个停止步骤，签名形如 `(page, project, sessionId)`。
  - 模块内自取 `controlOrigin()` 与 `randomUUID()`；
  - 复用 `armGate`/`gatePhase`/`deleteGate`（`ui-walk-gate.ts`）、`generatingStatus`（`ui-walk-approval.ts:11`）、`inspectSidebar`（`ui-walk-layout.ts:261`）。
- `ui-walk.spec.ts`：`:37` 后加 1 行 import；`:338` `walkScrollFollow(page, project)` 之后、`:339` `} finally {` 之前加 1 行调用。

## 行数预算（显式）
- 本刀：795 + 1 行 import + 1 行调用 = **797/800**，不搬任何 helper。biome 格式化后实测值记入 PR body。
- 之后只剩 3 行。#485/#492 若各加 1 行 import 和 1 行调用，后到者会到 801。二选一：
  - 复用 `ui-walk-stop.ts` 这一行 import，从中导出后续步骤；
  - 或先做纯搬迁（size 0 增长、既有断言不改、全绿）。
- 这是后续切片的约束，本刀不预做。

## Must preserve
- held-gate 流程顺序（`ui-walk.spec.ts:291-337`）。
- 禁止区间：`forbidFurtherMessagesGet`（`:326`）至 `assertNoForbiddenMessagesGet`（`:329`），由 `detach()`（`:331`）关闭。停止步骤在 `:338` 之后，watcher 已解除，因此区间不被延长。步骤自身的 2 次 GET（E0-3）在区间外，与 spec「legitimately issues messages GETs」一致。
- 第一个 gate 的 `finally deleteGate`（`:339-341`）不变；第二个 gate 由新步骤自己的 `try/finally` 负责。
- `walkScrollFollow`（`:406-564`）在停止步骤之前、在单对话上执行，不受影响。它结束时转录区滚到顶、`原始输出` 已展开；停止步骤的断言不依赖滚动位置（`toBeVisible` 不要求在视口内，composer 固定在底部）。
- error oracle（`ui-walk-oracle.ts`）不改：恰两次 `/api/auth/me` 401，零 console/page error。E0 全绿即证明停止与断连没有引入新的浏览器错误。
- 旅程后段 `:115-150`（会话列表、欢迎首屏、mobile 选首个会话、设置、主题、登出）不改。

## Must add/change（步骤，按序；locator 都限定在 `page.locator("form")`、第二条助手 article 或侧栏内）
1. `try` 内：
   - `armGate(origin, gateId)`；
   - composer 填 `WORKBUDDY_UI_WALK:<gateId>`；
   - 先挂 `waitForResponse`（`POST /api/sessions/<id>/prompt`），再按 Enter，断言状态 202。
2. **同步点**（carry-forward :113：`停止` 在 history loading 或 stream error 时也可用，所以不能以「按钮可用」为 running 证据）：
   - `expect.poll(gatePhase)` 为 `held`；
   - 用户、助手 article 各为 2；
   - 第二条助手 `.chat-md` 精确为 `你好，`，证明 live SSE 已把 running 视图送到页面；
   - form 内：`生成中`（`generatingStatus`）可见，`停止`（`exact`）可用，`发送` 数量 0；
   - 点击前再读一次 `gatePhase` 须仍为 `held`（不轮询）。
3. 先挂 `waitForResponse`（`POST …/stop`），点 `停止`，断言 **202**。走查不发任何 raw HTTP stop（carry-forward :75 不适用；E0-2 观察到浏览器请求无 content-type）。
4. Toast 断言：`getByRole("region", { name: /通知/ }).getByText("已停止生成", { exact: true })` 可见。限定在 region 内，是因为 Radix 的播报节点会在 region 外复制同一文本。
5. 第二条助手：
   - `getByRole("status", { name: "助手消息 已停止", exact: true })` 可见；
   - `getByRole("alert")` 数量 0；
   - `.chat-md` 仍精确为 `你好，`；
   - 用户、助手 article 仍各为 2。
6. form 内：`发送` 可见；`停止` 数量 0；`生成中` 数量 0。
7. `expect.poll(gatePhase)` 为 `status:404`：held 响应已被断连销毁（决定 1）。
8. `expect(toast).toHaveCount(0, { timeout: 10_000 })`（决定 2）。放在侧栏检查之前：侧栏检查在 mobile 上要开覆盖层并按 Escape，Toast 显示期间正处在 #643 的冲突窗口；点击后指针停在 composer，Toast 在 `top:52px`（`web/src/ui/toast.css`），无悬停暂停风险。
9. 侧栏：`inspectSidebar(page, project, …)`。
   - mobile 下它打开覆盖层、断言后按 Escape 关闭，并断言覆盖层消失；
   - 在 `navigation 会话列表` 内找 `button[aria-current="true"]`，数量须为 1；
   - 读其 `aria-label` 作为 `<title>`，断言其 `role=status` 的 accessible name 为 `<title> 已停止`。
10. `finally`：`deleteGate(origin, gateId)`。全程不调用 `releaseGate`。

**超时**
- expect 默认 5s（config 未设 `expect.timeout`）；`waitForResponse` 与点击用 `actionTimeout` 10s（`playwright.config.ts:25`）；
- Toast 等待 10s（2.4s + 退场，余量 >3 倍）；
- gate TTL 30s，从 arm 起算（实测 <0.3s 用完）；单测 30s（本机满载最长 11.5s）。

## Governing invariant
停止点击只在「gate `held` + 第二条助手已呈现前缀 + composer `生成中`」同时成立时发生。第二个 gate 只能因断连或 finally 的 DELETE 消失，从不因 release 消失。

## Sibling surfaces
- **必然变红、需要编辑的既有断言**：无（E0-1 全绿）。允许的既有文件改动**仅** `ui-walk.spec.ts` 的 1 行 import 与 1 行调用。
- **会被 Toast 泄漏打破的相邻面**：
  - 调用点之后 mobile 覆盖层的 Escape 路径：停止步骤自己的侧栏检查（步骤 9，已排在 Toast 等待之后）与调用点之后的 `ui-walk.spec.ts:115-118`、`:126`，经 `inspectSidebar`/`clickRoute`（`ui-walk-layout.ts:261-270`、`:329-335`）；
  - 步骤末尾的 Toast 等待就是为它们而设。不改这些断言。
- **不受影响**：`dialoguePair` 的「恰 1 条」断言（`:713-714`）只在停止步骤之前使用；`expectSelectedSessionStatus`（`ui-walk-layout.ts:317`）不被停止步骤调用，调用点之后也不再使用。
- **恒绿、零 diff**：`ui-walk-oracle.ts`、`ui-walk-gate.ts`、`ui-walk-approval.ts`、`ui-walk-layout.ts`、`route-hold.ts`、`fake-upstream.mjs`、`playwright.config.ts`、Makefile、`ci.yml`、`.github/scripts/*`、`web/src/**`。

## Seams under test
- 真实浏览器：`make ui-walk` 两个 project，由调用方自起服务。本机用 `ci-compiled-server.sh ui-walk`（E0 条件），CI 用 job `ui-walk`。
- gate 相位：既有 `gatePhase`，未知 id 返回 `status:404`（`ui-walk-gate.ts:52-56`；`fake-upstream.mjs:195-201` GET 404）。
- 断连移除：`fake-upstream.mjs:284-295` 的 `onClose` → `destroyGate`。

## Required evidence
（R = 先红后绿；G = 守护、恒绿）
- **E1 G**：`make ui-walk` 两个 project 退出 0，按 E0 条件连跑 ≥3 遍，另在满载下跑 1 遍。停止步骤的时序日志（held、stop 202、404、Toast 消失）记入 PR body。
- **E2 R**：每个变异单独施加，`make ui-walk` 都须红，两个 project 同红，除非注明。
  - M1 不点 `停止`：红于 stop `waitForResponse` 超时（10s）。
  - M2 徽章名改为 `助手消息 已完成`：红于徽章 `toBeVisible`（element not found）。
  - M3 finally 用 `releaseGate` 代替 `deleteGate`：红于 `gate release failed: 404`。这同时证明 gate 已被断连销毁。
  - M4 把步骤 3（挂 stop `waitForResponse`、点 `停止`、断言 202）挪到步骤 1 的 prompt 202 之后、步骤 2 之前：预期红于 `expect.poll(gatePhase).toBe("held")` 超时，末读值为 `armed` 或 `status:404`；也可能红于 202 断言（stop 返回 204）。两种红法均接受，PR body 记实测走的是哪一种。这也说明失败路径上 gate 可能停在 `armed`，所以 finally 的 DELETE 必需。
  - M5 去掉末尾 Toast 等待：`mobile-dark` 间歇红于 `ui-walk-layout.ts:269`（E0-4：9 次红 5 次），desktop 恒绿。只记录，不要求每次复现。
  - E0 已逐个实测 M1–M5（M4 两遍）。
- **E3 G**：`npm run lint --workspace web`（或 `make lint`）、`make typecheck` 绿；`wc -l web/e2e/ui-walk.spec.ts` ≤800（预期 797）。
- **E4 G**：`git diff --stat origin/master` 只含 `web/e2e/ui-walk-stop.ts`、`web/e2e/ui-walk.spec.ts` 与本 change 目录；Makefile、CI、env、`web/src` 零 diff。
- **E5（仅 CI）**：PR CI `ui-walk` job 绿（不传 `OMP_MAX_PROCESSES`）。

## Non-goals
见 proposal。

## Review focus
1. 同步点是 `held` + 前缀 + form 内 `生成中`，不是按钮可用；点击前再读一次 `held`。
2. gate：finally 只 DELETE，不 release；404 轮询在断言链末尾；步骤返回时 gate 必已不存在。
3. 所有 locator 都限定作用域：form、第二条助手、侧栏当前按钮、通知 region；`停止`/`发送` 用 `exact`。
4. 调用点在 `:338` 之后，禁止区间未被延长；spec 只多 2 行，≤800。
5. Toast 等待是 DOM 条件，有 10s 上限，放在停止断言之后、侧栏检查之前。
