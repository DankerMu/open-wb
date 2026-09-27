# Proposal: fake-omp-thinking-scenarios（#518）

## Why
父 change `s1c-session-metadata-presentation` tasks 6.1（epic #509）。深度思考（3.3 #519 合并缓冲与 32768 上限）与文件变更（3.4 #522、4.3b 等）的宿主侧取证需要真实 fake-omp 子进程发出 omp v18.0.10 形状的 `thinking_start/delta/end` 帧，以及带 `details` 的 `edit`/`write` 工具帧并真实落盘（父 design D12）。现行 fake-omp 没有任何此类场景。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: compact (override: 同 #458/#461 先例——fake-omp 被十余个测试文件与 CI `uid-isolation` 直接消费；`--hold-after-thinking` 复用 `abort-ok` 的回合状态机（abort 早到/晚到的次序，Concurrency）；`edit-write` 真实写文件（File IO）；且本 PR 须按 800 行规则处理 `fake-omp.mjs` 的行数预算（653 行，#552 还要加 slash 与 `--branch-entry`），需要 design.md 承载边界)
Blast radius: 3.3 #519、3.4 #522、4.3b #525、10.1 #552 的宿主用例——帧形状/次序错会让它们证明假命题（例如 thinking 块不在 message_end content 首位、end 帧早于文件落盘）；若改动既有场景或 argv 解析，全部直接/间接使用 fake-omp 的测试与 CI `uid-isolation` 回归。
Selected risk packs: Public API / CLI / script entry（新 argv 与场景名）；Concurrency / shared state / ordering（hold 与 abort 次序、串行 queue）；File IO / path safety / overwrite（`<cwd>` 下真实写 `notes.md` 与 `out/report.html`）；Legacy compatibility / examples（既有场景与 argv 逐字节不变）；Resource limits / large input（`--thinking-repeat 2185` 共 6555 帧、输出不累积）；Error handling / rollback / partial outputs（非法 repeat 在任何帧前失败）
Evidence floor: 新建 `server/test/fake-omp-metadata-scenarios.test.ts`（真实子进程）覆盖 design「Required evidence」；`fake-omp.test.ts` 与其它既有测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`wc -l server/test/support/fake-omp.mjs` ≤ 720；PR head CI `uid-isolation` 绿。

## What Changes
- `server/test/support/fake-omp.mjs`：`parseArgs` 增 `--thinking-repeat <n>` 与 `--hold-after-thinking`（只在 `thinking` 下校验/生效）；`turns` 分派增 `thinking` 与 `edit-write`；`--hold-after-thinking` 复用 `abortTurn`/`emitAbortedEnd` 的 `abort-ok` 状态机（`thinking` 在该旋钮下加入可 abort 集合）。
- 新纯构建模块 `server/test/support/fake-omp-thinking.mjs`（必建）：思考文本常量、thinking 事件构建、`edit-write` 的固定 hashline input/post-edit 内容/html 与 details 构建、repeat 校验；只导入 `node:` 内建模块、无模块级可变状态、不 emit、不写文件。主文件 653 行，两场景、两旋钮与真实写文件放不进 ≤720 的预算（给 #552 留 ≥80 行），先例 #461 拆出 `fake-omp-proxy.mjs`。
- 新建 `server/test/fake-omp-metadata-scenarios.test.ts`。

偏离 issue PR Boundary（只允许 `fake-omp.mjs` + 新测试文件）：新增一个纯构建支撑模块；理由为 AGENTS.md:107 的 800 行规则与 #552 的后续增长（父 tasks 通用纪律「若后续将超限，同刀拆出」），PR 偏离记录写明。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 夹具模块划分」：以主 spec（#461 自写）为底扩为三个模块；父 delta 无此块，归档时原样推进。
- MODIFIED `omp-test-harness`「假 omp 进程契约」：以当前主 spec 为底，只并入父 delta 中 6.1 的部分（逐字），场景枚举为十个；父 delta 的 `slash`/`--branch-entry`/「slash 场景」留给 #552。父 delta 缺少主 spec 中 A 后加的「审批三场景只门控首个回合」句——本 delta 保留该句；归档 PR 同步把该句补回父 delta，避免 #552 以父 delta 为底时丢失。

## Impact
- 仅测试支撑脚本、新纯构建模块和新测试文件；无生产代码改动；既有测试零改动。

## Non-goals
- probe `cwd=`（6.2，已交付）、fake-upstream 标记（6.3，已交付）、宿主侧消费（3.3/3.4/4.3b 等）、fake-omp 代理中继（不改）、`slash` 场景与 `--branch-entry`（10.1 #552）、A 的八个场景本身。
