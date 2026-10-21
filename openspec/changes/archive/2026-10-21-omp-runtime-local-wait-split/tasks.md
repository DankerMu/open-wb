# Tasks — omp-runtime-local-wait-split (#1600)

Fixture level: expanded. Risk packs: selected — Concurrency / state machine（计时器归属与过期回合 / 过期等待守卫随代码搬迁，complete / fail / abandon / retire 的清除次序不变）、Resource limits（clear 后不留计时器；只用注入时钟）；not selected — Auth / secrets、File IO、Schema、Config、Public API、Error handling、Release / packaging（见 proposal Triage）。

Must preserve: `SessionRuntime` 公开签名与导入路径；每个帧序列与时钟调度下的帧、回执、错误、计时器与子进程动作；`local-command.ts` 与 `process.ts` 不改；现有测试文件一行不改。

- [x] 1.1 开工核对：`runtime.ts` 的 `LocalWait`（`:96-101`）、`#onLocalFrame` / `#awaitOutput` / `#localState` / `#clearLocalWait`（`:524-570`）及其调用点（`:515`、`:629`、`:639`、`:657`、`:690-692`）；回执三函数（`:666-688`）与调用点（`:197`、`:214`、`:314`、`:324`、`:641`、`:659`）；`commands.ts` 的 `Turn`（`:56`）；`wc -l runtime.ts`。出入先改本 fixture 再继续。
- [x] 1.2 基线：搬迁前跑 `npm test --workspace server` 记下文件与用例计数。
- [x] 1.3 搬迁本地完成等待到 `local-wait.ts`（design D2–D4），`runtime.ts` 的四个清除点与 `#onFrame` 改为调用它。
- [x] 1.4 搬迁回执结算到 `commands.ts`（design D5），调用点改写。
- [x] 1.5 验证：`npm test --workspace server` ×3，计数与基线相同；`grep -n 'runtime.js' server/src/sessions/omp/local-wait.ts` 每行都是 `import type`；`npm test --workspace server`；typecheck；`bash scripts/size-guard.sh`；`wc -l server/src/sessions/omp/{runtime,local-wait,commands}.ts`（本次目标 runtime ≤740，design D1；超了按 D1 的备选）；`make anti-drift`；`make check`；`git diff --stat` 只含 change 目录、`runtime.ts`、`commands.ts`、`local-wait.ts`，无测试文件。
