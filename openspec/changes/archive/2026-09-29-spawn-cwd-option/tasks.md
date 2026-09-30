# Tasks: spawn-cwd-option（#513）

## 2. omp-runtime — spawn cwd（父 tasks 2.1 原文）

- [ ] 2.1 `server/src/sessions/omp/process.ts` + `omp/runtime.ts`：`SpawnOmpOpts`/`SessionRuntimeOpts` 增**可选** `cwd`（缺省 `join(sandboxRoot, ownerId)`，行为不变），`process.ts:52` 改用解析后的 cwd 且子进程 `cwd` 选项与 `--cwd` 参数取同一值；`mkdir -p` 只保留给 session-dir/home/agent 与「等于所有者根的 cwd」，其它 cwd 不创建；本刀不改任何调用方与测试夹具。验证：新建 `server/test/omp-spawn-cwd.test.ts` 断言缺省与显式 `cwd` 两种下 argv `--cwd` 与 spawn 选项相等、所有者根缺失时被建出、非所有者根 cwd 缺失时不 mkdir；既有 spawn 契约测试（`omp-process.test.ts`、`sudo-launcher.test.ts`、`omp-runtime*.test.ts`、`omp-rpc*.test.ts`）不改动全绿

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | spawn argv 与两个 opts 接口 → design 证据 1、2、5、6 |
| File IO / path safety / overwrite | yes | mkdir 只限所有者根 → 证据 3、4 |
| Legacy compatibility / examples | yes | 缺省行为逐字不变 → 证据 1、7 + CI `uid-isolation` |
| Auth / permissions / secrets | yes | sudo 模式参数段与 env 白名单不变 → 证据 5 |
| Concurrency / shared state / ordering | no | 无并发面改动 |
| Error handling / rollback / partial outputs | no | 目录准备失败语义不变（既有测试覆盖）；非所有者根缺失的失败呈现属 2.2 |
| Schema / columns / units / field names | no | 不涉 |
| Resource limits / large input / discovery | no | 不涉 |
| Config / project setup | no | 不涉 |
| Release / packaging / dependency compatibility | no | 不涉 |
| Documentation / migration notes | no | spec delta 即文档 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/omp-spawn-cwd.test.ts`（≤800 行）；既有测试与 `server/test/support/**` 零改动。
- [ ] `runtime.ts`、`process.ts` 改后 ≤ 800 行（按 design 只搬 `nonempty` 到 `commands.ts`；不搬 `sanitizeError`）。
- [ ] 每条新断言先在实现前跑红，再实现跑绿（记录命令与结果）；守卫项按 characterization 记录。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate spawn-cwd-option --strict --no-interactive` 通过；PR head CI（含 `uid-isolation`）绿。
