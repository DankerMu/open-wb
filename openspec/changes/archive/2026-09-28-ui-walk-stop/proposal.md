# Proposal: ui-walk-stop（#484）

## Why
父 change `s1c-turn-control-governance` task 8.2b（epic #448，issue #484）。

停止链路已经在 master 上：停止 REST（#475）、停止按钮与已停止呈现（#477）、审批作答（#481）。
但 `make ui-walk` 仍只有一个 gate，从未在真实浏览器里点过 `停止`。本刀在同一会话上追加停止步骤，给父 chat-harness「UI 走查对话步骤」的停止段提供真实浏览器、两个视口的证据。

走法已在本机实测，见 design「实测」E0：
- 草稿步骤两个 project 全绿；
- 五个变异中四个恒红、一个（M5，不等 Toast）间歇红。
- 实测还暴露一个必须处理的坑：停止后 `已停止生成` Toast 还没消失时，后续 mobile 覆盖层按 Escape 关不掉（9 次里红 5 次）。步骤末尾须等 Toast 消失，见决定 2。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：真实浏览器 + 真 omp + 假上游 gate 的并发时序；CI 共享 `ui-walk` job；两个视口）
Blast radius: 同步点写错会让 CI `ui-walk` job 间歇红，或在错误时点点 `停止`（gate 仍 armed，204 或非确定结果）而假绿。gate 用 release 而不是 delete 会伪造「完成」；不清 gate 会让 8.2c 重放的 prompt 挂到 TTL。Toast 泄漏到后续覆盖层步骤会让 mobile 间歇红。
Selected risk packs: Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: `make ui-walk` 两个 project 全绿（本机 CI 脚本连跑 ≥3 遍，含一遍满载）；design E2 的五个变异各自红；`make lint`、`make typecheck`；`wc -l web/e2e/ui-walk.spec.ts` ≤800；PR CI `ui-walk` job 绿

## What Changes
- 新建 `web/e2e/ui-walk-stop.ts`，导出一个停止步骤。
  - 内容：arm 第二个 gate → 经 composer 发第二个模板化 prompt → 等 gate `held` 与第二条助手的前缀 → 断言 composer 运行态 → 点 `停止` → 断言 202、Toast、徽章、composer 解锁、侧栏 `<title> 已停止`、gate 已被断连移除 → 等 Toast 消失。
  - finally 中 `deleteGate`，不 release。
- `web/e2e/ui-walk.spec.ts`：只加 1 行 import，并在 `walkHeldDialogue` 的 `walkScrollFollow(page, project)`（`:338`）之后加 1 行调用。795 → 797 行，不搬任何 helper。
- 其它文件零 diff：`web/src`、server、Makefile、CI、env、`ui-walk-gate.ts`、`ui-walk-oracle.ts`、`ui-walk-layout.ts`、`ui-walk-approval.ts`、`route-hold.ts`、`fake-upstream.mjs`。

## Capabilities
- MODIFIED chat-harness「UI 走查对话步骤」：以主 spec 原文为底，只并入父 delta 的以下部分：
  - 停止步骤句（逐字）；
  - 双 project 句，裁到「approval, reload and stop steps」；
  - 禁止区间句，裁到「completed-page reload and the stop step」；
  - 清理句「gates (both)」；
  - Scenario「停止按钮走查」（逐字）。
- 其余三个既有 Scenario 保持主 spec 原样，审批括注「in no asserted order」也保持主 spec 原样。
- 不交付的部分：重新生成步骤与 Scenario「重新生成走查」归 #485（8.2c），分叉步骤与 Scenario「分叉走查」归 #492（8.2d）。

## Impact
- CI `ui-walk` job：每个 project 的旅程多约 3s。
  - 本机实测旅程：master 6.4–6.6s（#481 E0-8），含停止步骤但不等 Toast 时 6.8s，本刀完整形态约 9–9.5s，满载约 10–11.5s；单测上限 30s（`playwright.config.ts:14`）；
  - 其中停止步骤本身约 0.2s，其余是等 Toast 消失（Toast 时长 2.4s，`web/src/ui/toast.tsx:20`，加退场动画）。
- 第二个 gate 的 TTL 是 30s（`fake-upstream.mjs:21`），实测从 arm 到 404 不到 0.3s。
- 走查会话结束时状态为 `stopped`，不再是 `done`。后续 `expectSessionListInSidebar`、`expectWelcomeFirstScreen`、mobile `selectFirstSessionInOverlay`（`ui-walk.spec.ts:115-124`）不读状态文案，E0 实测全绿。
- 行数：`ui-walk.spec.ts` 797/800。本刀之后只剩 3 行余量，#485、#492 须按 design「行数预算」处理。

## 决定与偏离
1. **断言 gate 已被断连移除（硬断言）。** 点击后 `expect.poll(gatePhase)` 须变为 `status:404`。
   - Scenario THEN 只要求「gate is deleted in finally」。父文括注写「the abort closes omp's upstream request, which removes the gate」，这是走查里唯一能证明「断连销毁、没有 release」的观察。
   - 实测每次在徽章出现时 gate 已是 404（E0-3）。
   - 后果：父 8.2c 句「DELETE answers 204 … or 404 …; both are accepted」中，204 分支在本刀之后正常路径不可达。这不冲突，#485 仍须两者都接受。见 Orchestrator decisions。
2. **步骤末尾等 Toast 消失**（`toHaveCount(0)`，上限 10s）。
   - 不等时，后续 mobile 覆盖层 Escape 关不掉：9 次里红 5 次，都在 `mobile-dark`，红于 `ui-walk-layout.ts:269`（经 `:354`/`:281`）。等待后 12 次全绿，其中 2 次满载（E0-4）。
   - 这是停止窗口之后对 DOM 条件的等待，不是替代真实 in-flight 窗口的定时 sleep，与 spec「arbitrary timing sleeps」一句不冲突。
   - 根因在 `web/src`（Toast 与导航覆盖层的 Escape 分派），越界不修，已开 #643，见 Orchestrator decisions。
3. **常量重复。** `WORKBUDDY_UI_WALK:` 与 `你好，` 在新模块内各定义一次，不从 spec 导出：导出会让 spec 增长，也会让新模块反向依赖 spec。
4. **issue「Module / Scope」写 `ui-walk.spec.ts` 及既有辅助。** 本刀新建 `ui-walk-stop.ts`，与 #481 的 `ui-walk-approval.ts` 同一先例。原因是 spec 只剩 5 行余量，内联必超 800。仍在 PR Boundary「`web/e2e/` 走查文件与其辅助」之内。

## Orchestrator decisions（原 Open questions，已裁定）
- 第二个 gate 由本刀停止步骤 finally 内 `deleteGate`；#485 的前置 DELETE/GET 恒为 404，已记 carry-forward 要求 #485 不依赖其存在。
- 行数预算：本刀 797/800；#485/#492 优先复用已有 import 行或先做纯搬迁，已记 carry-forward。
- Toast 显示期间 mobile 导航覆盖层 Escape 失效：web/src 越界问题，另开 #643 跟踪；本刀以「等 Toast 消失」DOM 条件等待规避（决定 2）。
- demo-parity-checklist CH-09/CH-12 归 #486，本刀只提供证据。
- #482 所见真 omp abort 后空助手消息在本场景未复现，只记录。

## Non-goals
- 重新生成走查（8.2c #485）、分叉走查（8.2d #492）。
- 任何 `web/src`、server、Makefile、CI、env 改动；不新增 Playwright project；不 build/start/stop 服务。
- 修复 Toast/覆盖层的 Escape 交互（#643）。
- demo-parity-checklist 与其它文档更新（#486）。
