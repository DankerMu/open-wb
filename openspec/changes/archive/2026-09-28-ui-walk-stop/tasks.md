# Tasks: ui-walk-stop（#484）

## 8. chat-harness — smoke 与 ui-walk（父 tasks 8.2b 原文）

- [ ] 8.2b ui-walk 停止：同会话第二个受控 prompt 在 `held` 时点 `停止` → Toast `已停止生成`、会话 `已停止`、助手消息徽章 `助手消息 已停止` 可见、composer 解锁。验证：`make ui-walk` 两个 project 全绿
- [ ] （本 fixture 追加，见 design「Must add/change」1–2）同步点：prompt 202 后 `gatePhase` 轮询到 `held`；用户、助手 article 各 2 条；第二条助手 `.chat-md` 精确为 `你好，`；form 内 `生成中` 可见、`停止` 可用、`发送` 为 0；点击前再读一次 gate 仍为 `held`。不得以按钮可用作为 running 证据（carry-forward :113）。验证：design E2 M4
- [ ] （本 fixture 追加，design 3–7）点 `停止` → stop 响应 202 → 通知 region 内 Toast `已停止生成` → 第二条助手徽章 `助手消息 已停止`、无 `role=alert`、正文仍为 `你好，`、消息数仍 2+2 → form 内 `发送` 回来、`停止`/`生成中` 为 0 → `inspectSidebar` 内当前会话状态元素名为 `<aria-label> 已停止`。验证：design E1、E2 M1/M2
- [ ] （本 fixture 追加，design 8、10；决定 1）`gatePhase` 轮询到 `status:404`；finally 只 `deleteGate`，全程不调用 `releaseGate`。验证：design E2 M3
- [ ] （本 fixture 追加，design 9；决定 2）步骤末尾 `expect(toast).toHaveCount(0, { timeout: 10_000 })`，防止 Toast 泄漏到后续 mobile 覆盖层的 Escape。验证：design E0-4、E2 M5
- [ ] （本 fixture 追加）步骤代码放新建的 `web/e2e/ui-walk-stop.ts`；`ui-walk.spec.ts` 只加 1 行 import，并在 `:338` `walkScrollFollow` 之后加 1 行调用，≤800 行（预期 797）。验证：design E3、E4

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 点击时点必须落在真实 in-flight 窗口：gate `held` 加 DOM 前缀加 `生成中`。gate 生命周期是断连销毁加 finally DELETE，从不 release。messages GET 禁止区间不被延长 → design「Must add/change」2、8、10，Must preserve 的禁止区间，E2 M3/M4 |
| Resource limits / large input / discovery | yes | 单测 30s、gate TTL 30s、Toast 2.4s、expect 5s、action 10s，满载实测旅程 ≤11.5s → design「超时」、E0-4、E1（含满载一遍） |
| Legacy compatibility / examples | yes | 既有登录、四路由、文件、held-gate、W-scroll、侧栏、设置、主题、登出与 error oracle 断言零改动。会话终态从 done 变为 stopped 后后段仍全绿 → E0-1、E1、E4 |
| Error handling / rollback / partial outputs | yes | 失败路径上 gate 可能停在 `armed`（E2 M4），所以 finally DELETE 必需且不得掩盖旅程错误（`deleteGate` 吞异常，`ui-walk-gate.ts:44-50`）。停止后的「部分回答」须精确为 `你好，`，且无错误文案 → E2 M3/M4，design 5 |
| Public API / CLI / script entry | no | 不改 `make ui-walk` 配方与 Playwright 配置，不新增 project |
| Config / project setup | no | Makefile、CI、env 零 diff；CI 不传 `OMP_MAX_PROCESSES` → E4 |
| File IO / path safety / overwrite | no | 不涉文件读写 |
| Schema / columns / units / field names | no | 只消费已定形的 aria 契约与 stop 202 响应（#477/#475） |
| Auth / permissions / secrets | no | 沿用既有登录态与 gate 控制面 bearer（`MODEL_UPSTREAM_API_KEY` 为 `fake`），不引入新凭证 |
| Release / packaging / dependency compatibility | no | 无依赖变化；omp 仍为 v18.0.10 |
| Documentation / migration notes | no | demo-parity-checklist CH-09/CH-12 更新归 #486（carry-forward :134 ROUTING），本刀只提供证据 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只新建 `web/e2e/ui-walk-stop.ts`，只改 `web/e2e/ui-walk.spec.ts`（1 行 import 加 1 行调用）。`web/src`、server、Makefile、CI、env 以及其它 `web/e2e/*` 零 diff。
- [ ] 既有测试断言零改动，不搬 helper。若出现 design「Sibling surfaces」之外的破坏，停下上报。
- [ ] 红/绿：
  - E2 的 M1–M4 各自施加后红，失败输出记入 PR body；
  - M5 记录间歇红的观察；
  - E1、E3、E4 为守护，恒绿。
- [ ] 按 design E0 条件自起服务：Node 24、编译 server/web、真 omp `var/omp/omp`、假上游。`make ui-walk` 连跑 ≥3 遍加满载 1 遍，全部退出 0；结束后确认没有残留进程。
- [ ] `make lint`、`make typecheck` 退出 0；`wc -l web/e2e/ui-walk.spec.ts` ≤800，实测值记入 PR body。
- [ ] PR CI `ui-walk` job 绿。
- [ ] `openspec validate ui-walk-stop --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal 的「决定与偏离」与 Orchestrator decisions；Toast/覆盖层 Escape 已开 #643。
