# Design: fake-omp-slow-ready（#461）

Change surface: `server/test/support/fake-omp.mjs`，新建 `server/test/support/fake-omp-proxy.mjs` 与 `server/test/fake-omp-slow-ready.test.ts`。父设计见父 design D2 停止意图与 D7。

行号约定：本文与 tasks.md 中 `fake-omp.mjs` 的 `:N` 一律指 origin/master `679c267` 的行号。提交 1 之后，原 `:13-594` 的行号减 1（删了两行导入、加了一行导入）。

## 拆分（提交 1：纯搬迁，行为不变）
- 缝：call-proxy 的上游客户端。它是 `fake-omp.mjs` 里唯一一段不读写模块状态、不调 `emit*` 的连续代码。
- 硬约束：`fake-omp.mjs` 有模块级副作用，包括 `:40` 的 argv 解析、`:57` 的 ready、`:69` 的 stdin readline。所以任何新模块都不得导入它。
- 搬迁清单（旧行号，origin/master `679c267`）：
  - `:596-605` `parseToolCall`；
  - `:607-619` `loadBaseUrl`；
  - `:621-637` `parseWorkbuddyBaseUrl`；
  - `:639-652` `collectWorkbuddyFields`；
  - `:654-662` `nextSection`；
  - `:664-678` `applyWorkbuddyLine`；
  - `:680-687` `unquote`；
  - `:689-717` `postChat`；
  - `:719-732` `readSseRound`；
  - `:734-747` `consumeSseText`；
  - `:749-763` `appendSseDelta`；
  - `:765-783` `appendToolFragment`；
  - `:785-793` `eventData`。
  - 以上共 198 行，其间空行原样保留。`:595` 是 `relayToolRound` 之后的空行，删掉它，文件以 `:594` 的 `}` 结尾。
- 留在主文件：`runProxy`（`:549-569`）与 `relayToolRound`（`:571-594`）。它们调用 `emit`、`emitDeltas`、`emitToolRound`、`completeTurn`、`finishTurn`、`failTurn`。
- 导入：
  - 主文件删去 `:9-10`（`node:http`/`node:https`）；
  - 在 `:12` `node:readline` 之后加一行 `import { loadBaseUrl, parseToolCall, postChat } from "./fake-omp-proxy.mjs";`，biome 接受这个位置；
  - `readFileSync`（`probeReport` `:354` 仍在用）与 `join`（`handleBranch` `:251` 仍在用）保留在主文件。
- 新模块依次为：4 行头注释（职责，并注明「只依赖 node: 内建，绝不导入 fake-omp.mjs」）、4 行导入（`node:fs` readFileSync、`node:http`、`node:https`、`node:path` join）、1 空行、198 行搬迁代码。三处 `function` 前加 `export `，不增加行数。新模块不带 shebang，模式为 100644。
- 行数（已在 scratchpad 实测，`node --check` 与 `biome check --write` 均无改动）：
  - 主文件 793 − 2（导入）+ 1（新导入）− 199（`:595-793`）= **593**；
  - 新模块 4 + 4 + 1 + 198 = **207**。
  - 提交 2 后主文件 ≤630（硬上限 740），#470 余量 ≥110。
- 依赖方向：`fake-omp.mjs → fake-omp-proxy.mjs → node:*`。单向，无环。新模块没有模块级可变状态，也不发帧。
- 不采用派单建议的审批 factory，理由见 proposal「偏离与决定」。

## slow-ready（提交 2）
Must preserve:
- `ready` 帧（`:59-65`）的字节形状；
- 串行 queue（`:55,69-72`）；
- `rl close` 的既有退出路径（`:73-81`），包括 hang 类 scenario 不退出；
- `no-ready`/`no-ready-hang` 不发 ready（`:57`），`no-ready-hang` 的 SIGTERM 忽略与 stderr 标记（`:86-91`）；
- abort-ok 的持有回合与 aborted 三帧（`:314-316,385-389,451-470`）；
- 缺省 `completeTurn`（`:478-485`）；
- probe 记录点（`:132-134`）。

Must add/change: 见 tasks.md「提交 2」（knob 解析与校验、计时器同步启动、延迟期 stdin 关闭立即 exit 0 零帧、`ABORT_SCENARIOS` 加成员、其它 scenario 忽略 knob）。

Governing invariant: `slow-ready` 进程的 stdout，对任意入站序列都等于「延迟 ≥ n ms 之后的 `abort-ok`」；唯一例外是延迟未满时 stdin 关闭，此时 stdout 为空、退出码 0。

## 共同面
Sibling surfaces:
- 必然变红的既有断言：无。**允许的既有测试改动：零。** 以下文件零 diff 全绿：直接消费者 `fake-omp{,-abort,-approval,-branch,-frames}.test.ts`、`omp-approval-requests`、`omp-dispatch-fake-omp`、`omp-rpc-lifecycle`、`omp-rpc`、`omp-runtime`、`session-supervisor`、`server-startup-order`，以及 helper `fake-omp-helpers.ts`、`session-supervisor-helpers.ts`、`server-startup-helpers.ts`、`support/omp-runtime.ts`、`support/omp-rpc.ts`。
- CI `uid-isolation`（`.github/scripts/ci-uid-isolation.sh:12,225`）：
  - sudoers 只放行 `fake-omp.mjs` 这一个路径作 setpriv 参数（`:41-45`），静态导入的兄弟模块不需要规则；
  - 但它必须能被 uid `omp` 读取：同目录，tracked 0644，并有 runner home 的 `--x` ACL（`:68`）。证据是该 job 在 PR head 上为绿；
  - `HANG_PATTERN`（`uid-isolation.test.ts:43`）只匹配 argv 末尾的 `scenario hang-term$`，knob 不影响它。
- `scripts/test-ci-harness.sh:729` 为自测而桩掉 `fake-omp.mjs`，不受影响。
- `server/test/server-startup-helpers.ts:199-222` 的 `writeFakeOmpLauncher` 从 scratch 目录 `await import(FAKE_OMP)`（`:218`）。它是仓库里唯一把 `fake-omp.mjs` 当模块导入的地方，新加的相对 import 正要经过这条解析路径，由 S4 中 `server-startup-order.test.ts` 的生产入口 call-proxy 用例守护。
- knip 的 project 文件里没有 `test/support/*.mjs`（`npx knip --debug` 只列出 `.ts`/`.d.mts`），所以新模块不进入 knip。jscpd 与 size-guard 也不扫 `.mjs`，所以用 `wc -l` 核对。biome 覆盖 `server/**`，新模块同样受格式与复杂度 ≤15 约束。
- `fake-omp.mjs` 的模式必须保持 100755（`ci-uid-isolation.sh:15` `test -x`）。
- 下游 #488/#490 依赖的契约见 tasks.md「后续消费者」。

Seams under test:
- 只看子进程的 stdout 帧、stdout/stderr 原文、退出码与 probe delta，不访问夹具内部。
- 全部经 `fake-omp-helpers.ts` 的 `startFake`（`extraArgs` 在 `OMP_FLAGS` 之后、`--scenario` 之前，`:65-68`）、`wait`、`closeStdin`、`waitExit`（4s 上限，`:33`）完成。
- 计时从 spawn 前的 `performance.now()` 起算。

Required evidence: tasks.md 的 S1–S4（拆分）、E1–E6（先红）、G1–G3（恒绿守卫）。

Non-goals: 见 proposal.md。

Review focus: 提交 1 纯搬迁（S2 三条 diff 为空、S3 逐字节相同、无反向导入）；提交 2 只多一个 `ABORT_SCENARIOS` 成员，E4 延迟期关闭立即退出零帧；计时断言只有下界；两提交后的 `wc -l` 与 PR head `uid-isolation` 链接。
