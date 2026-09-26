# Design: omp-runtime-commands-split（#452）

父设计：「模块拆分（size-guard）」。

- **Change surface**：`server/src/sessions/omp/runtime.ts`（797 行）→ 新 `omp/commands.ts`。`omp/process.ts` 不改（见「ui-requests.ts 判定」）。
- **Must preserve**：`SessionRuntime` 公开方法与签名、`SessionRuntimeOpts`/`SessionClock`/`SessionTokens`/`PromptDispatchReceipt`/`SessionBusyError` 的导出与 `runtime.js` 导入路径；`OmpProcess`/`spawnOmp` 签名；帧次序、await 次序、计时器创建/清理的归属与时机、错误类型与消息、日志。私有状态（`#` 字段）仍由所属类持有。`process.ts` 本刀不改（其 `#onFrame` 先 emit、后按 `#writesClosed` 守卫回 `extension_ui_response{cancelled:true}` 的次序由既有 `server/test/omp-rpc.test.ts:132-142`、`omp-rpc-lifecycle.test.ts:211-222` 继续守护）。
- **既有导入方（全部不改）**：`server/src/sessions/supervisor.ts:7,14`、`server/src/sessions/stream/sse.ts:7`（类型 `SessionClock` 须仍可从 `runtime.js` 解析）；测试 `server/test/support/omp-runtime.ts`、`server/test/support/omp-rpc.ts`、`server/test/session-supervisor-helpers.ts`、`session-tokens.test.ts`、`sudo-launcher.test.ts`、`session-supervisor-faults.test.ts`、`server/test/linux/uid-isolation.test.ts`（非 Linux/未设 `WORKBUDDY_UID_TEST` 时跳过、CI 未启用——验证缺口，仅由 `make typecheck` 覆盖其导入）。
- **Must add/change**（搬迁清单，函数/接口体逐字搬移，唯一改动是 `export` 关键字与 import 行）：
  - `omp/commands.ts` ← `runtime.ts` 的模块级内部辅助：`NativeWaiter`/`SpawnWaiter`/`ReceiptWaiter`（60-74）、`Generation`/`Turn`（76-99）、`liveChild`（含其上方注释，674-687）、`stdoutEnded`/`destroyStdio`（689-704）、`raceDelay`（706-726）、`deferredExit`/`deferredSpawn`/`deferredReceipt`（728-752）、`isTerminalEnd`/`isLocalComplete`/`isMatchingFailure`/`asRecord`（754-782）。留在 `runtime.ts`：`systemClock`、`SessionRuntime` 类、`nonempty`、`sanitizeError`（依赖 `SessionBusyError`）。
  - `commands.ts` 需要的 `PromptDispatchReceipt` 与 `SessionClock` 以 `import type … from "./runtime.js"` 取得（仅类型，编译期擦除，无运行时环）；`PromptDispatchReceipt` 仍定义并导出于 `runtime.ts`。
  - 行数（本 issue 一次性证据，含新增 import 行估算 ≈14 行：797 − 150 + 14 ≈ 661）：拆分后 `runtime.ts` ≤ 680 行，为 2.2a/2.2b 在 `runtime.ts` 的预计增量（约 90 行）留出 ≥120 行余量。新文件导出只被 `omp/runtime.ts` 引用（knip 零新增）。
- **Governing invariant**：拆分前后，对同一输入帧序列，`SessionRuntime`/`OmpProcess` 的可观测行为（产出帧、receipt、错误、退出上报、计时）完全一致。
- **Sibling surfaces**：`omp/frame.ts`、`omp/prompt-stream.ts`（不动）；既有测试 `server/test/omp-runtime.test.ts`、`omp-runtime-io.test.ts`、`omp-process.test.ts`、`omp-rpc-*.test.ts`、`omp-dispatch*.test.ts`、`fake-omp.test.ts`（真实 fake-omp 子进程）——全部零改动（测试只用公开导出）。
- **Seams under test**：既有测试原样；无新增测试。
- **Required evidence**：`git diff --stat -- server/test` 为空；`npm test --workspace server` 全绿且测试总数与 master 相同；`bash scripts/size-guard.sh` 退出 0，且 `wc -l server/src/sessions/omp/runtime.ts` ≤ 680；`make anti-drift`（knip 零新增、jscpd 不升高）；`git diff --color-moved` 审阅只见搬迁块（移动的函数/接口体逐字相同，仅增 `export`）与 import 行；`git diff --stat -- server/src/sessions/omp/process.ts` 为空。
- **ui-requests.ts 判定**：不建（明确非目标）。父 design「模块拆分」与父 tasks 2.0 的条件是「若超限」：`process.ts` 732 行 + 2.1a 预计约 40 行 ≈ 772 < 800，不满足条件；`process.ts` 本刀零改动。若 2.1a 实施时逼近上限，由 2.1a 在其切片内按同一纯搬迁纪律处理。
- **Non-goals**：任何新行为或测试；`sessions/*.ts` 拆分。
- **Review focus**：搬迁块逐字相同（`git diff --color-moved`）；无 await/计时时机变化；无新外部导出；私有字段未外泄；`process.ts` 未改；`commands.ts` 对 `runtime.js` 只有 type-only 导入。
