# Tasks: ui-walk-regenerate（#485）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.2c 原文）

- [ ] 8.2c ui-walk 重新生成：末条助手消息点 `重新生成` → 回合完成且旧回答被替换。验证：`make ui-walk` 两个 project 全绿；CI 不传 `OMP_MAX_PROCESSES`
- [ ] （本 fixture 追加，见 design「Must add/change」1–2；决定 2）点击前 `deleteGate` 第二个 gate，`gatePhase` 轮询到 `status:404`；再断言第二条助手仍带徽章 `助手消息 已停止`。验证：design E2 M2（承重）、M6（如实记录恒绿）
- [ ] （本 fixture 追加，design 3–5；决定 3）先挂 `waitForResponse` 再点第二条助手（按位置 `nth(1)`）的 `重新生成` → 202 → 通知 region 内 Toast `正在重新生成…` → 徽章数量 0 → `.chat-md` 精确为原回复全文 → 无审批条、无 bash 步骤、无 `role=alert` → 用户、助手各恰 2。不断言瞬时运行态、不点 `停止`（carry-forward :118）。验证：design E1、E2 M1/M2/M5
- [ ] （本 fixture 追加，design 6；决定 5）解锁：输入框可用、`发送` 可见、`停止`/`生成中` 为 0、新末条 `重新生成` 可用。验证：design E1
- [ ] （本 fixture 追加，design 7–8；决定 6）`expect(toast).toHaveCount(0, { timeout: 10_000 })` 在侧栏检查之前；`inspectSidebar` 内当前会话状态元素名为 `<aria-label> 已完成`。验证：design E2 M3、M4
- [ ] （本 fixture 追加；决定 1）`walkStop` 返回第二个 gate 的 id（finally 不变），`walkRegenerate` 导出自 `ui-walk-stop.ts`；`ui-walk.spec.ts` 复用 import 行，调用点净增 1 行，≤800 行（预期 798）。验证：design E3、E4

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | DELETE + GET 404 先于点击，否则重放回合撞 armed（挂起）或 held（409）gate；「已替换」不能被残留前缀或先于正文的徽章消失满足；messages GET 禁止区间不被延长 → design「Must add/change」1、5，Must preserve 的禁止区间，E2 M2/M6 |
| Resource limits / large input / discovery | yes | 单测 30s、Toast 2.4s、expect 5s、action 10s；本机旅程 11.6–12.8s，满载 14.0s → design「超时」、E0-1、E1（含满载一遍）；spec 798/800 → 行数预算 |
| Legacy compatibility / examples | yes | 停止步骤断言零改动（只加返回值）；既有登录、四路由、文件、held-gate、W-scroll、侧栏、设置、主题、登出与 error oracle 零改动。会话终态由 stopped 回到 done 后后段仍全绿 → E0-1、E1、E4 |
| Error handling / rollback / partial outputs | yes | 被停止的部分回答 `你好，` 必须被整段原回复替换而不是追加（恰 2 条助手，#633 类）；无错误文案；`deleteGate` 吞异常不掩盖旅程错误（`ui-walk-gate.ts:44-50`） → 决定 3，E2 M2 |
| Public API / CLI / script entry | no | 不改 `make ui-walk` 配方与 Playwright 配置，不新增 project |
| Config / project setup | no | Makefile、CI、env 零 diff；CI 不传 `OMP_MAX_PROCESSES` → E4 |
| File IO / path safety / overwrite | no | 不涉文件读写 |
| Schema / columns / units / field names | no | 只消费已定形的 aria 契约、Toast 文案与 regenerate 202（#467/#478） |
| Auth / permissions / secrets | no | 沿用既有登录态与 gate 控制面 bearer（`MODEL_UPSTREAM_API_KEY` 为 `fake`），不引入新凭证 |
| Release / packaging / dependency compatibility | no | 无依赖变化；omp 仍为 v18.0.10 |
| Documentation / migration notes | no | demo-parity-checklist CH-09/CH-12 更新归 #486（carry-forward :134），本刀只提供证据 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `web/e2e/ui-walk-stop.ts`（`walkStop` 返回值、`sessionPost` 端点联合、新增 `walkRegenerate`（含 `mark()` 打点）与两个常量）与 `web/e2e/ui-walk.spec.ts`（import 名 + 调用点 2 行）。`web/src`、server、Makefile、CI、env 以及其它 `web/e2e/*` 零 diff。
- [ ] 既有测试断言零改动，不搬 helper。若出现 design「Sibling surfaces」之外的破坏，停下上报。
- [ ] 红/绿：
  - E2 的 M1/M2/M3/M5 各自施加后红，失败输出记入 PR body；
  - M4 记录间歇红的观察，M6 记录恒绿；
  - E1、E3、E4 为守护，恒绿。
- [ ] 按 design E0 条件自起服务：Node 24、编译 server/web、真 omp `var/omp/omp`、假上游。`make ui-walk` 连跑 ≥3 遍加满载 1 遍，全部退出 0；结束后确认没有残留进程。
- [ ] `make lint`、`make typecheck` 退出 0；`wc -l web/e2e/ui-walk.spec.ts` ≤800，实测值记入 PR body。
- [ ] PR CI `ui-walk` job 绿。
- [ ] `openspec validate ui-walk-regenerate --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「决定与偏离」与 Orchestrator decisions，并附 E1 步骤时序日志（两个 project）。
