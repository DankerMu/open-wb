# Tasks: fake-omp-slash-scenario（#552）

## 10. omp-test-harness — fake-omp（父 tasks 10.1 原文）

- [ ] 10.1 `server/test/support/fake-omp.mjs` 新 scenario `slash`（design D15/D12）：prompt `message` 恰为 `/todo` → 先 `command_output{text:"No todos. Use /todo append <task> to start one."}` 再 `response{command:"prompt",success:true,data:{agentInvoked:false}}`（无 `agent_start`/`agent_end`）；恰为 `/compact` → 先回执 `agentInvoked:false`，再经 50 ms `setTimeout` 发 `command_output{text:"Compaction complete."}`；argv `--compact-silent` 时 `/compact` 只回执、永不输出（只压制输出）；任何时刻收到 `abort` 都回 `response{command:"abort"}`，定时器未到期时同时取消输出；其余 prompt（含首字符 U+0020 后接 `/` 的转义文本）走 `normal` 回合；`branch` 增可重复 argv `--branch-entry <text>`，每个值在固定列表之后按序追加一个 user 条目（文本原样、含前导空格），`branch{entryId}` 对其同已知条目；omp-test-harness「假 omp 进程契约」场景计数十 → 十一。验证：新建 `server/test/fake-omp-slash.test.ts`（真实子进程）断言四条帧序列（`/todo` 输出先于回执且无其他帧；`/compact` 回执先、输出后、无其他帧；` /session delete` 走 normal 且无 `command_output`；`--compact-silent` 只回执且进程存活到 stdin 关闭、其后 `abort` 仍得 `response{command:"abort"}` 且无输出）、`abort` 取消，以及 `branch --branch-entry " /help 这是什么" --branch-entry "继续"` 的列表尾部两条目与对其 `branch` 成功（omp-test-harness「slash 场景」）

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新场景名 `slash`、布尔旋钮 `--compact-silent`、可重复 `--branch-entry` → design 证据 1–4、7、8 |
| Concurrency / shared state / ordering | yes | `/compact` 50 ms 定时输出与 abort 取消、定时输出与串行 queue 的次序 → 证据 2、4、5、5b |
| Legacy compatibility / examples | yes | 既有场景与 argv 不变、旋钮对其它场景无效、`branch` 缺省列表不变 → 证据 7、9 + 既有测试（除下述一行）零改动全绿 + PR head CI `uid-isolation` 绿 |
| Error handling / rollback / partial outputs | yes | `--branch-entry` 缺值、非精确命令文本走 normal → 证据 3、8 |
| File IO / path safety / overwrite | no | `branch` 写新 `.jsonl` 沿用 #457 既有路径（`wx`、不 mkdir），追加条目只改列表；由证据 7 的真实写出覆盖 |
| Resource limits / large input / discovery | no | 无大输入 |
| Schema / columns / units / field names | no | 帧形状即 CLI 契约，归 Public API 包逐字段断言 |
| Config / project setup | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Release / packaging / dependency compatibility | no | 仅测试支撑文件 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 新测试只写进新建 `server/test/fake-omp-slash.test.ts`（≤800 行）；既有测试文件零改动，唯一例外：删除 `server/test/fake-omp-metadata-scenarios.test.ts` 中为本 issue 预留的 `fake-omp.mjs ≤ 720` 断言（#518 design 明写「为 #552 留 ≥80 行」；800 上限断言保留）。
- [ ] 改后 `fake-omp.mjs` ≤ 800 行；放不下即停止并回报，不擅自拆模块（拆模块须改「假 omp 夹具模块划分」spec）。
- [ ] 每条新断言先在 fixture 未改时跑红，再实现跑绿（记录命令与结果）。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-slash-scenario --strict --no-interactive` 通过；PR head CI `uid-isolation` 绿。
