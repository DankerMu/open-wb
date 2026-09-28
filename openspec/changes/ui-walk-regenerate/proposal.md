# Proposal: ui-walk-regenerate（#485）

## Why
父 change `s1c-turn-control-governance` task 8.2c（epic #448，issue #485）。

重新生成链路已经在 master 上：重新生成 REST（#465/#467）、`重新生成` 按钮与 Toast（#478）、停止走查（#484）。
但 `make ui-walk` 从未在真实浏览器里点过 `重新生成`。本刀在停止步骤之后、同一会话上追加重新生成步骤，给父 chat-harness「UI 走查对话步骤」的重新生成段提供真实浏览器、两个视口的证据。

走法已在本机实测，见 design「实测」E0：
- 草稿步骤两个 project 全绿（连跑 5 遍，另满载 1 遍）；
- 六个变异中四个恒红（两个 project 同红），一个（M4，不等 Toast）mobile 9 次红 8 次，一个（M6，不删 gate）恒绿——如实记录，原因见决定 2。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：真实浏览器 + 真 omp + 假上游 gate；CI 共享 `ui-walk` job；两个视口）
Blast radius: 旧回答残留（`你好，`）或徽章消失被当成「已替换」会假绿；第二个 gate 若仍 armed，重放回合会挂在 `held` 直到 TTL（30s），若 held 则上游 409 让回合失败。Toast 泄漏到后续 mobile 覆盖层会间歇红（#643）。
Selected risk packs: Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: `make ui-walk` 两个 project 全绿（本机 CI 脚本连跑 ≥3 遍，含一遍满载）；design E2 的 M1/M2/M3/M5 各自红、M4 记录间歇红、M6 记录恒绿；`make lint`、`make typecheck`；`wc -l web/e2e/ui-walk.spec.ts` ≤800（预期 798）；PR CI `ui-walk` job 绿

## What Changes
- `web/e2e/ui-walk-stop.ts`：
  - `walkStop` 改为返回第二个 gate 的 id（`Promise<string>`，`try` 末尾 `return gateId`；finally 的 `deleteGate` 不变）。其余停止断言零改动。
  - 新增导出 `walkRegenerate(page, project, sessionId, gateId)`：`deleteGate` → gate GET 为 404 → 点第二条（末条、已停止）助手的 `重新生成` → 断言 202、Toast、徽章消失、精确原回复、无审批/bash、2+2 条、composer 解锁 → 等 Toast 消失 → 侧栏 `<title> 已完成`。
  - `sessionPost` 的端点联合加 `"regenerate"`；模块内加两个常量（原回复全文、Toast 文案）。
- `web/e2e/ui-walk.spec.ts`：复用既有 `ui-walk-stop.js` import 行（只加名字）；调用点 `:340` 改为 `const stopGate = await walkStop(...)`，其后加 1 行 `await walkRegenerate(...)`。797 → **798** 行。
- 其它文件零 diff：`web/src`、server、Makefile、CI、env、`ui-walk-gate.ts`、`ui-walk-oracle.ts`、`ui-walk-layout.ts`、`ui-walk-approval.ts`、`route-hold.ts`、`fake-upstream.mjs`、`playwright.config.ts`。

## Capabilities
- MODIFIED chat-harness「UI 走查对话步骤」：以当前主 spec 原文（#484 归档后）为底，只并入父 delta 的以下部分：
  - 重新生成步骤句（逐字），接在停止步骤句之后；
  - 双 project 句，裁到「approval, reload, stop and regenerate steps」；
  - 禁止区间句，裁到「the stop and regenerate steps」；
  - Scenario「重新生成走查」（逐字）。
- 其余四个既有 Scenario、审批括注与停止步骤句保持主 spec 原样。
- 不交付的部分：分叉步骤句与 Scenario「分叉走查」归 #492（8.2d）。

## Impact
- CI `ui-walk` job：每个 project 的旅程多约 3s。
  - 本机实测旅程：master（#484）9.3/9.6s；本刀 11.6–12.8s；满载（14 核 `yes` ×14）14.0/13.9s；单测上限 30s（`playwright.config.ts:14`）。
  - 步骤本身到侧栏断言前约 60ms，其余是等 `正在重新生成…` Toast 消失（2.4s，`web/src/ui/toast.tsx:20`，加退场动画，实测 ~2.85–2.92s）。
- 走查会话结束时状态回到 `done`（#484 之后为 `stopped`）。调用点之后的 `ui-walk.spec.ts:115-150` 不读状态文案，E0 全绿。
- 行数：`ui-walk.spec.ts` 798/800。#492 只剩 2 行，须复用已有 import 行（见 design「行数预算」）。

## 决定与偏离
1. **walkStop 返回 gateId，walkRegenerate 与之同模块**（carry-forward :138 二选一的合并形态）。调用点净增 1 行、import 行不增。`walkStop` 的 finally 仍先于返回执行 DELETE，所以返回的 id 已经不存在。
2. **点击前的 DELETE 在正常路径上恒为 404，「不删」变异恒绿（M6）。**
   - `walkStop` 已在 `:73` 硬断言 gate 为 `status:404`，finally 又 DELETE 一次（carry-forward :135）。父句「204 … or 404 …; both are accepted」的 204 分支不可达。
   - `deleteGate` 吞掉状态码与异常（`ui-walk-gate.ts:44-50`），「两者都接受」由构造满足；承重断言是其后的 GET `status:404`。
   - 前置的必要性由 M2 证明：把步骤 1（DELETE + GET 404 轮询）整体换成重新 arm 同一 id，重放回合进入 `holdFinal`（`fake-upstream.mjs:133-135`），末条助手停在 `你好，`，步骤红于精确原回复断言。
3. **「旧回答被替换」的 DOM 判据 = 徽章消失 + 精确全文 + 恰 2 条助手。**
   - 旧正文是 `你好，`，是原回复的前缀；精确 `toHaveText(原回复全文)` 不会被残留的旧文本满足。
   - M2 实测徽章在 +36ms 就消失、正文却停在 `你好，`：单看徽章不足以证明完成，全文断言才是承重的。
   - 恰 2 条助手挡住「追加而非替换」（#633 类重复回答）。
   - 不在 DOM 断言消息 id（页面不暴露）。E0 用 REST 旁证：末条助手 id 4→5（desktop）、9→10（mobile），用户消息 id 不变。
4. **不断言重新生成回合的瞬时运行态**（`生成中`/`停止`）。无 gate 时回合约 25ms 内完成，断言会抖；carry-forward :118 也要求这里不期待 stop。
5. **composer「解锁」判据是输入框可用 + `发送` 可见，不是 `发送` 可用。** 草稿为空时 `发送` 本来就禁用（`web/src/features/chat/page.tsx:34-35`）；E0 第一版以 `发送` 可用为判据，恒红于此。另断言新末条的 `重新生成` 可用——它的 `disabled` 就是 `composerDisabled`（`conversation-view.tsx:160`）。
6. **步骤末尾等 Toast 消失**（`toHaveCount(0)`，上限 10s，放在侧栏检查之前），同 #484 决定 2。不等时 `mobile-dark` 9 次红 8 次（M4）。根因 #643，越界不修。
7. **常量重复。** 原回复全文在 `ui-walk-stop.ts` 再定义一次，不从 spec 导出（同 #484 决定 3）。

## Orchestrator decisions / Open questions
- 已裁定（编排者）：不把「DELETE 为 204 或 404」写成显式状态码断言，不改 `ui-walk-gate.ts`；承重断言是其后的 GET `status:404`，理由见决定 2。
- #478 为「空正文的已停止消息仍显示 `重新生成`」放宽了条件（carry-forward :112）。本场景停止后正文是 `你好，`，不是空，所以该分支未被走查覆盖。只记录。
- demo-parity-checklist CH-09/CH-12 归 #486，本刀只提供证据（carry-forward :134）。

## Non-goals
- 分叉走查（8.2d #492）；停止（8.2b）与审批（8.2a）步骤本身的行为。
- 任何 `web/src`、server、Makefile、CI、env 改动；不新增 Playwright project；不 build/start/stop 服务。
- 修复 Toast/覆盖层的 Escape 交互（#643）。
- demo-parity-checklist 与其它文档更新（#486）。
