# Tasks: supervisor-split（#487）

## 4. supervisor 纯搬迁（父 tasks 4.0b 原文）

- [ ] 4.0b 纯搬迁、行为不变：`server/src/sessions/supervisor.ts`（770 行）拆出 `sessions/pool.ts`（准入/驱逐/名额）、`sessions/turn-control.ts`（stop/regenerate/fork 编排）、`sessions/approvals.ts`（审批登记/计时/结算）的落点，先搬既有 slot 登记与派发辅助。验证：`bash scripts/size-guard.sh` 退出 0、supervisor 既有测试不改动全绿、`knip` 零新增

> 本刀交付 `pool.ts` 与 `turn-control.ts`。`approvals.ts` 由 4.3（#464）新建，理由见 proposal 偏离 1。搬迁清单见 design「Must add/change」。

- [ ] S1 形状：
  - `git diff --stat ${BASE} -- server web` 恰好列出 `server/src/sessions/{supervisor,pool,turn-control}.ts` 三个文件；本 child change 目录随同一 PR 提交，不计入此项；
  - `wc -l` 依次为 658、60、68，偏差 ±3 行以内；偏差更大须在 PR body 说明。新文件的行数按顶部 3 行职责注释计；
  - `supervisor.ts` ≤ 661 行。
- [ ] S2 搬迁恒等：以下三条命令输出均为空。在仓库根目录用 bash 运行（`$F` 为相对路径）；zsh 下 `$BASE:s…` 会被当作修饰符，故写 `${BASE}`。`BASE=e23febbe4c889c8d515496e51b51efd3bd207b69`。
  ```sh
  F=server/src/sessions
  diff <(git show ${BASE}:$F/supervisor.ts | sed -n '70,89p;695,728p' | sed -E 's/^export //') \
       <(tail -n 54 $F/pool.ts | sed -E 's/^export //')
  diff <(git show ${BASE}:$F/supervisor.ts | sed -n '643,694p;763,772p' | sed -E 's/^export //') \
       <(tail -n 62 $F/turn-control.ts | sed -E 's/^export //')
  diff <(git show ${BASE}:$F/supervisor.ts | sed -e '70,90d' -e '643,729d' -e '763,772d') \
       <(grep -vxF -e 'import { type Generation, releaseClaim, releasePumpExit, type Slot } from "./pool.js";' \
                    -e 'import { drain, persistEvent } from "./turn-control.js";' \
                    -e 'export { releasePumpExit } from "./pool.js";' $F/supervisor.ts | cat -s)
  ```
  第三条中的 `cat -s` 只用来吸收 biome 在再导出行前补的空行。base 文件本身没有连续空行（`cat -s` 前后行数相同）。
- [ ] S3 模块边界：以下三项全部满足。
  - `grep -c 'supervisor.js' server/src/sessions/pool.ts server/src/sessions/turn-control.ts` 两个文件都为 0；
  - `grep -n '^import' server/src/sessions/{pool,turn-control}.ts` 恰为 design 所列的 4 行，均为 `import type`；
  - `grep -n '^export' server/src/sessions/pool.ts` 恰为 `Generation`、`Slot`、`releasePumpExit`、`releaseClaim` 四个，`turn-control.ts` 恰为 `persistEvent`、`drain` 两个。
- [ ] S4 回归：
  - `git diff --stat ${BASE} -- server/test` 为空；
  - `npm test --workspace server` 全绿，且为 97 文件 / 1638 例（1636 passed + 2 skipped），与 base 相同。须在 Node 24.13.1（`.tool-versions`）下运行；默认 shell 的 Node 22 缺 `db.setAuthorizer`，在 base 上也会红；
  - 覆盖率门禁是全局 80%，不按文件计。草稿镜像实测：`pool.ts` 100%，`turn-control.ts` 行 93.75% / 分支 87.5%（未覆盖 `persistEvent` 的 `step.end` 未知 stepId 分支，base 上同样未覆盖）；
  - supervisor 相关的 9 个既有测试文件共 58 例，零 diff 全绿：`server/test/session-supervisor.test.ts`、`session-supervisor-admission.test.ts`、`session-supervisor-claims.test.ts`、`session-supervisor-faults.test.ts`、`session-supervisor-sinks.test.ts`、`session-supervisor-stream.test.ts`、`session-supervisor-subscribe.test.ts`、`session-approval-events.test.ts`、`server-assembly.test.ts`；
  - 辅助文件 `session-supervisor-helpers.ts` 零 diff。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | 认领表释放与泵退出的身份门控随搬迁跨文件 → S2 逐字 + `session-supervisor-claims.test.ts`（含 `releasePumpExit` 直接单测）与 admission/stream 套件零 diff 全绿 |
| Legacy compatibility / examples | yes | `supervisor.ts` 导出集合与 5 个源码导入方、4 个测试导入方不变 → S3 + S4 + `make typecheck` |
| Error handling / rollback / partial outputs | yes | 预进度失败时 `drain` 与 retire 的次序、落库失败的 infraFault 路径不变 → S2 + `session-supervisor-faults.test.ts`/`-sinks.test.ts` 零 diff 全绿 |
| Public API / CLI / script entry | no | 无 HTTP/CLI 变化；TS 导出面归 Legacy 包 |
| Config / project setup | no | runtime 字段拷贝（#451）原地不动 |
| File IO / path safety / overwrite | no | 不涉 |
| Schema / columns / units / field names | no | `persistEvent` 对 store 的调用逐字不变；不涉 SQL |
| Auth / permissions / secrets | no | token 签发/吊销适配器（`#adapter`）原地不动 |
| Resource limits / large input / discovery | no | 进程上限归 4.1；行数上限由 size-guard 覆盖 |
| Release / packaging / dependency compatibility | no | 无依赖变化（`npm run build --workspace server` 作回归命令） |
| Documentation / migration notes | no | 源码结构说明归 9.1 |

## 通用纪律（继承父 tasks.md）
- [ ] 纯搬迁 = `bash scripts/size-guard.sh` 退出 0 + 既有测试**不改动**全绿 + knip 零新增；搬迁清单按 design「Must add/change」，不改写任何类方法。
- [ ] 不新增测试。不触碰 `server/test/**`、`store*.ts`、`omp/`、`rest.ts`、`events.ts`、`sessions/index.ts`、web。允许的既有测试编辑：无。
- [ ] 不新建 `approvals.ts`，不留空文件或占位导出。
- [ ] `npm test --workspace server`、`npm run build --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd 不升高）退出 0；`openspec validate supervisor-split --strict --no-interactive` 通过。
- [ ] PR body 标注「Critical Path：请求白盒审查」（omp 子进程治理面）。
