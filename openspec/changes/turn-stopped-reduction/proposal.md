# Proposal: turn-stopped-reduction（#455）

## Why
父 change `s1c-turn-control-governance` tasks 3.1（epic #448）。停止生成需要与 `failed` 语义分离的独立终态：omp 被 `abort` 后发 `message_end{stopReason:"aborted"}`，现行归约器把它当失败（`error` + `turn.end failed`），store 也只接受 `done|failed`。本刀让归约器产出 `turn.end stopped`、提供有界退回用的 `applyStop`，并让 store 以 `stopped` 结算，是 4.2a/4.2b/5.1a/7.x 的公共前提。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: `turn.end.status` 是 server/web 共享 SSE 契约，且同刀改持久化终态)
Blast radius: 全部回合终态——`stopped` 若伴随 `error`、首个原因被覆盖或结算非原子，web/审计/侧栏将把停止显示为失败或残留 running；`finishStep` 若随之放宽则 `step.end` 契约漂移。
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Legacy compatibility / examples；Concurrency / shared state / ordering；Error handling / rollback / partial outputs
Evidence floor: 新建归约表驱动测试（aborted/error/正常三路、首因胜出、`applyStop` 恰一次与终态后静默、审批帧过滤）+ 新建 store 测试（三表 `stopped`、done 步骤不变、单事务、`stopped` 可再受理且 rollback 恢复、REST GET 读回）；`make typecheck`（含 `supervisor.ts` 穷举）、`npm test --workspace server`、`make lint`、`make anti-drift` 退出 0；既有测试只改 design 所列一处。

## What Changes
- `server/src/sessions/events.ts`：`turn.end.status` 加 `stopped`；assistant `message_end aborted` 记为中断（与失败分开记忆，首个胜出），终止 `agent_end` 发恰一个 `turn.end stopped`、无 `error`；新导出纯函数 `applyStop(state)`。审批形状 `extension_ui_request` 与 `response{command:"abort"}` 已被现有过滤覆盖，只加守护测试。
- `server/src/sessions/store.ts`：`FinishStatus = done|failed|stopped`；会话/消息/步骤 status 类型加 `stopped`；`finishStep` 参数保持 `done|failed`。`finishOwnedTurn`（`store-approvals.ts`）运行时已按参数通写三表，零改动。
- `supervisor.ts` 零 diff：`persistEvent` 的 `turn.end → finishTurn` 随联合扩展通过类型检查。
- 新建两个测试文件；既有 `session-events.test.ts:241-248` 一处期望值随新语义改写。

## Capabilities
- MODIFIED `chat-stream`「纯协议事件归约」：父 delta 整段逐字（全量交付）。
- ADDED `turn-control`「stopped 终态」（部分交付，新 capability）：CHECK 句（#449 已交付，重述）、`finishTurn(stopped)` 结算、视图与两条 GET 接受 `stopped`、`stopped` 可再受理；Scenario「停止落盘形状」。web 联合子句 → #472；对账句与 Scenario「停止后继续对话」「对账不触碰 stopped」→ #473。
- ADDED `turn-control`「中断帧归约与有界退回」（部分交付）：归约器与 `turn.end.status` 联合两句 + `applyStop` 纯函数一句；Scenario「归约纯函数」。grace/retire/迟到帧与 Scenario「原生 abort 收尾」「忽略 abort 时有界退回」→ #473。
- MODIFIED `chat-sessions`「会话持久化与回合刷盘」（部分交付）：主 spec 为底，并入 acceptPrompt/rollbackPrompt 的 `stopped`、`finishTurn` 接受 `stopped` 与步骤结算句、「Atomic admission…」的 `/stopped`、新 Scenario「Stopped turn settlement」。审批 deny 结算/审计 → #474；对账 `stopped` 子句 → #473。

## Impact
- 仅 `events.ts`、`store.ts` 类型/归约逻辑 + 两个新测试文件。server 在 #488/#473 写出 `abort` 帧前不会真正产出 `turn.end stopped`，web（`stream.ts:34`）按 D6 由 #472 先放宽，故单独合入保绿。

## Deviations
- `finishStep` 不随 `FinishStatus` 放宽（issue 文字只说放宽 `FinishStatus`，而 `finishStep` 现共用该类型）：父 spec 规定 `step.end.status` 不扩展、stopped 步骤只由 `finishTurn` 结算，故拆出窄类型保持 `done|failed`。
- REST GET 读回用例放在 store 新测试文件内（经 `withSessionRest`，REST 源码不改），以交付「停止落盘形状」末句与「视图、GET 接受 `stopped`」句，不超出「两个新测试文件」边界。
- `turn-control`「stopped 终态」重述 #449 已交付的 CHECK 句，使该 requirement 在新 capability 中完整，后续无 issue 需补回。
- 既有测试 `session-events.test.ts:241-248`（aborted 先于 error 期望 failed）与新契约直接冲突，必须改期望值与标题（issue「既有测试不改动」的唯一例外）。
- `turn-control`「中断帧归约与有界退回」的 `applyStop` 句为自写（父句把 supervisor grace/retire 与纯函数写在同一句，逐字引入会多承诺 #473 的行为）；#473 归档时以父 delta 原句整句替换。

## Non-goals
- pending 审批的 deny 结算与审计（4.6 #474）；supervisor 发 `abort`、`OMP_ABORT_GRACE_MS` 有界退回与调用 `applyStop`（4.2a #473）；stop REST（5.1a #475）；web 解析 `stopped`（7.1 #472）；`step.end.status` 扩展。
