# Proposal: fake-omp-slash-scenario（#552）

## Why
父 change `s1c-session-metadata-presentation` tasks 10.1（epic #509，design D15/D12）。组 10 的宿主侧等待规则（10.2 #553）、`command_output` 归约（10.3 #554）与白名单转义/分支对位（10.4b #555）需要真实 fake-omp 子进程发出 omp v18.0.10 内建 slash 命令的两种本地完成次序：`/todo` 先 `command_output` 后回执、`/compact` 先回执后输出（`resource/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1019-1054`，`abort` 回执 :1086-1088），以及 `branch` 列表中可由测试放置的转义/普通条目。现行 fake-omp 对任何 prompt 都先回 `agentInvoked:true`，不存在 `command_output` 帧。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: 同 #458/#461/#518 先例——fake-omp 被 19 个测试文件与 CI `uid-isolation` 直接或间接消费；`/compact` 的 50 ms 定时输出与 abort 取消、与串行 queue 的次序是 Concurrency 面；`parseArgs` 新增布尔与可重复两类旋钮；`fake-omp.mjs` 720 行只剩 80 行预算，需 design.md 承载边界)
Blast radius: 10.2 #553、10.3 #554、10.4b #555、10.6 #557 的宿主用例——次序错（如 `/todo` 回执先于输出、`/compact` 输出未被 abort 取消）会让它们证明假命题；若改动既有场景、argv 解析或 `branch` 缺省列表，#457/#465/#466/#488 的 `branch` 用例与全部使用 fake-omp 的测试回归。
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建 `server/test/fake-omp-slash.test.ts`（真实子进程）覆盖 design「Required evidence」；既有测试除预留的 720 行断言外零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`wc -l server/test/support/fake-omp.mjs` ≤ 800；PR head CI `uid-isolation` 绿。

## What Changes
- `server/test/support/fake-omp.mjs`：新 scenario `slash`（`/todo`、`/compact` 精确匹配；其余 prompt 走 `normal`）；布尔旋钮 `--compact-silent`；`slash` 下 `abort` 一律回执并取消未到期输出；`branch` 可重复 `--branch-entry <text>` 在固定列表后追加条目。
- 新建 `server/test/fake-omp-slash.test.ts`。
- `server/test/fake-omp-metadata-scenarios.test.ts`：删除 #518 为本 issue 预留的 `fake-omp.mjs ≤ 720` 一行断言（800 上限断言保留）。偏离 issue「既有测试零 diff」，理由：该断言的唯一目的就是给本 issue 留预算，本 issue 消费它；PR 偏离记录写明。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：父 delta 该 Requirement 全文逐字（#518 归档后主 spec 与父 delta 只差 `slash` 枚举、`slash` 段、`--branch-entry` 段与 Scenario「slash 场景」，已逐句比对）。场景计数十 → 十一。

## Impact
- 仅测试支撑脚本与测试文件；无生产代码改动。

## Non-goals
- 宿主 runtime 等待规则（10.2）、reducer 映射（10.3）、白名单与 REST（10.4a/b）、web（10.5）、harness（10.6）；`/todo`、`/compact` 以外的命令；`command_output` 以外的 omp 本地命令帧（`session_info_update` 等）。
