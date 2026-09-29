# Tasks: stop-after-agent-start（#650）

## 1. fake-omp

- [ ] 1.1 纯搬迁：把 argv 解析（`VALUE_ARGS`、`FLAG_ARGS`、`parseArgs`、`missingValue`、`parseReadyDelay`）移到新模块 `server/test/support/fake-omp-argv.mjs`。新模块只导入 `node:` 内建，不持有模块级可变状态，不发帧；`fake-omp.mjs` 以相对路径静态导入它。搬迁本身零行为变化，既有 fake 测试全绿。
- [ ] 1.2 `--start-delay-ms <n>`（解析放在 1.1 的模块里）与 `abort-ok`/`slow-ready` 的开始前 abort 丢弃语义（design「Must add/change」）。验证：F1–F3。

## 2. omp-runtime

- [ ] 2.1 `SessionRuntime` 回合「已开始」标记与推迟的 `abort()`（design「Must add/change」、proposal 偏离 1–3）。验证：R1–R7、S1–S3。
- [ ] 2.2 既有测试中前提失效的用例，只允许两种改动，不删断言、不放宽断言：
  - 脚本化 FakeChild 世界里回执后不发 `agent_start` 就期待 `abort` 帧（例如 `omp-runtime-commands.test.ts` A2）：在期待 abort 帧之前补发该回合的 `agent_start`（或本地完成应答）；
  - 真实 fake 世界里在 `await prompt` 之后立即同步读取 abort 帧（fixture 审查点名：`session-stop-intent.test.ts:178-179` I4、`session-stop-intent-windows.test.ts:110-113` I6、`:138-142` I7）：改为等到该 abort 帧出现（`until`/`waitFor`）后再做原断言；
  - 回合从未开始（fake `crash` 在 ack 后退出）却断言写出 abort 的用例（`session-stop-intent.test.ts` I5）：按新契约把精确帧数从 1 改为 0（实现期补入，编排者认可：spec Scenario「deferred abort is rejected when the turn never starts」）。
  每一处改动都在偏离报告里列出文件、用例名与理由。

## 3. 证据与收尾

- [ ] 3.1 新测试文件 `server/test/omp-runtime-abort-start.test.ts`（R1–R7）、`session-stop-early.test.ts`（S1–S3）、`fake-omp-early-abort.test.ts`（F1–F3），各 ≤800 行；复用 `omp-runtime-commands.test.ts` 的世界构造方式、`session-stop-helpers.ts`/`session-stop-intent-helpers.ts`、`fake-omp-helpers.ts`，不改这些 helper（需要的新 helper 放在新文件里）。
- [ ] 3.2 红/绿：F1 在 master fake 上为红；R1、R2、S1、S2 在「tasks 1 的新 fake + master `runtime.ts`」基线上为红（未改的 master 忽略 `--start-delay-ms`，不构成基线）；design 变异表 M1–M5 逐条临时施加并确认对应用例变红，把失败输出摘要记入报告。
- [ ] 3.3 `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`、knip 零新增，全部退出 0；`wc -l server/src/sessions/omp/runtime.ts server/test/support/fake-omp*.mjs` 记入报告（runtime ≤798，fake 各 ≤800）。
- [ ] 3.4（编排者）E-real：真 omp v18.0.10 复测两个分支，结论回写父 change design Open Questions 第二项 (c)。
- [ ] 3.5 `openspec validate stop-after-agent-start --strict --no-interactive` 通过。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | abort 写出时点由帧到达驱动；推迟、开始与结束之间的竞争 → R1–R7、S1、S2、M1–M5 |
| Error handling / rollback / partial outputs | yes | 回合开始前结束、失败、被放弃或退役时，推迟的 Promise 必须拒绝且被 catch；grace 仍兜底 → R3、R4、R6、S3（`collectRejections`） |
| Public API / CLI / script entry | yes | `SessionRuntime.abort()` 返回语义变化；fake-omp 新 argv `--start-delay-ms` → R1–R5、F3；knip 零新增 |
| Legacy compatibility / examples | yes | 已开始回合的 abort、本地 `/compact` 取消、n=0 时 fake 帧序都不变 → 既有 stop/stop-intent/abort/slash/fake 测试全绿，F2 |
| Documentation / migration notes | yes | 父 design D2 修订与 Open Question (c) 回写 → 3.4；spec delta 三处 |
| Schema / columns / units / field names | no | 无 schema、事件或 REST 形状变化 |
| Config / project setup | no | 无新配置键；`OMP_ABORT_GRACE_MS` 不变 |
| File IO / path safety / overwrite | no | 不涉文件 |
| Auth / permissions / secrets | no | stop 路由与鉴权不变 |
| Resource limits / large input / discovery | no | 进程池准入与驱逐不变；grace 兜底不变（S3 守护） |
| Release / packaging / dependency compatibility | no | 无依赖变化；真二进制版本仍钉 v18.0.10 |

## 通用纪律

- [ ] 源码边界：只改 `server/src/sessions/omp/runtime.ts`、`server/src/sessions/omp/commands.ts`（`Turn` 新字段与推迟辅助函数）、`server/test/support/fake-omp.mjs`，新增 `fake-omp-argv.mjs`；`turn-control.ts` 只允许更新 `:3-5`、`:63-64` 两处过时注释；`supervisor.ts`、`omp/process.ts`、`local-command.ts`、web 零 diff。确需改动时先停下上报。
- [ ] 推迟的 Promise 在所有终局路径上恰好结算一次；runtime 不新增公开方法。
- [ ] 不提交、不推送、不开 PR；报告改动文件、验证命令与结果、偏离（逐条写「内容/原因/影响」，没有就写「无偏离」）。
