# Proposal: local-command-wait（#553）

## Why
父 change `s1c-session-metadata-presentation` tasks 10.2（epic #509，design D15「本地完成的等待」）。`SessionRuntime.#onFrame`（`server/src/sessions/omp/runtime.ts:381-398`）在匹配的 `agentInvoked:false` 结果（`commands.ts:134-145` `isLocalComplete`）到达时立即结束回合，之后到达的帧被丢弃（:386-389）。真实 omp 的 `/compact` 经 `runCommandInBackground` 先回执后输出（`resource/oh-my-pi/packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:176-187`），输出因此永远丢失。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 每个会话的回合完成规则——错误的等待或未取消的定时器会让回合永不结束（会话卡 running）、提前结束（丢 `/compact` 输出），或让旧定时器结束后续回合（截断下一回合正文）；`session-supervisor`、`omp-dispatch`、`omp-runtime-io` 的既有 local-only 用例与 CI 全体 server 测试间接依赖该规则。
Selected risk packs: Concurrency / shared state / ordering（等待状态、宽限定时器、与 idle/retire/shutdown 的交互）；Legacy compatibility / examples（非 `/` 文本 local-only 行为不变，既有用例零 diff）；Error handling / rollback / partial outputs（等待中终态 `agent_end`、匹配失败、子进程退出、放弃迭代）；Resource limits / large input / discovery（定时器泄漏：每条结束路径释放，`clock.pending()` 可核）；Public API / CLI / script entry（新模块导出、`SessionRuntime` 签名不变）
Evidence floor: 新建 `server/test/omp-runtime-local-command.test.ts`（纯判定表驱动 + wired 手写帧 + 真实 fake `slash`）覆盖 design「Required evidence」；`omp-runtime.test.ts`、`omp-runtime-io.test.ts`、`omp-dispatch.test.ts`、`session-supervisor*.test.ts` 零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；PR head CI 绿。

## What Changes
- 新建 `server/src/sessions/omp/local-command.ts`：常量 `LOCAL_COMMAND_GRACE_MS = 120_000` 与纯判定 `decideLocalCompletion`。
- `server/src/sessions/omp/commands.ts`：`Turn` 增 `slashText`、`commandOutputSeen` 两字段（`Turn` 定义所在文件；issue 写「runtime.ts 的 Turn 两字段」，`Turn` 实际定义在此）。
- `server/src/sessions/omp/runtime.ts`：`prompt()` 初始化两字段；`#onFrame` 以判定替换 `isLocalComplete` 分支；宽限定时器起停（`#localWait`），每条回合结束路径与 generation retire 取消。
- 新建 `server/test/omp-runtime-local-command.test.ts`。

## Capabilities
- MODIFIED `omp-runtime`「每会话生命周期」：父 delta 该 Requirement 全文逐字（主 spec 与父 delta 只差 Local-only completion 段、Scenario「Prompt lifecycle signals」两句限定与新 Scenario「Local-only outcome waits for late command output」，已逐句比对）。

## Impact
- 生产代码：`server/src/sessions/omp/` 三个文件；无 REST/前端/迁移改动。
- 与 A #488（`runtime.ts`/`commands.ts` 的 `command(frame)` 与 `abort()`）同文件，不依赖；后合者 rebase。

## Non-goals
- 白名单与 `toWireText` 转义（10.4a/b，决定哪些文本以 `/` 到达 runtime）；reducer 对 `command_output` 的映射（10.3）；A 的 stop/abort 路径（等待期 stop 由 A 的有界兜底结束）；到期后迟到输出的过滤（spec 写明为接受的残余）。
