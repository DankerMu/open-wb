## Why
父 change `s1c-turn-control-governance` tasks 6.2（epic #448）。重新生成（4.4 #465）与 fork（4.5 #466）都依赖 omp 的 `get_branch_messages` → `branch{entryId}` → `get_state` 三步：先对齐 entry，再让 omp 写出新会话文件并切过去，最后取新路径落库。2.2b #488 的 runtime `command(frame)` 也要靠这三帧的 id 回显来证明请求与应答的相关性。现有 fake-omp 不解析 `--session-dir`，对这两个命令只回无 id 的 `unsupported`，`get_state.sessionFile` 全程不变，所以服务端无法用真实子进程证明新文件落库。

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: compact (agree: 测试支撑脚本 + 自带契约测试，无生产代码、无共享入口)
Compact despite File IO/Concurrency/Schema/Legacy packs: 真实写文件只发生在测试自建的 mkdtemp 目录（生产 `process.ts:57` 预建 session-dir），不碰任何生产路径；单进程串行队列、次序确定；帧形状逐字钉在 omp v18.0.10 源码行号上；改动只新增 `branch` 场景分支，既有消费 fake-omp 的测试文件以「零改动全绿」守护。
Blast radius: 4.4/4.5/2.2b 测试的可信度。帧形状或文件切换语义若与真实 omp 不符，这些测试证明的就是想象中的对齐与落库。
Selected risk packs: File IO / path safety / overwrite；Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Schema / columns / units / field names；Legacy compatibility / examples
Evidence floor: 新建 `server/test/fake-omp-branch.test.ts`（真实子进程）。它覆盖 issue 验收三条（固定列表、末条 branch 后新文件与 `get_state` 切换、未知 entryId 无新文件且 `sessionFile` 不变），外加持久/二次 branch 和缺省守卫；正向断言先红后绿。既有 fake-omp 测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。省略 design.md（compact：无共享入口、无生产格式/schema 变化）。

## What Changes
- `server/test/support/fake-omp.mjs`：`parseArgs` 增加 `--session-dir <dir>`，与既有 `--scenario`/`--resume` 一样后出现者覆盖先出现者。新增 `--scenario branch` 分支：在夹具内以常量文档化固定的两条用户 entry；`get_branch_messages` 返回这份列表；`branch{entryId}` 对已知 entry 在 session-dir 下真实写出新 `.jsonl` 并把进程切到该文件，未知 entry 回错误；`get_state.sessionFile` 返回当前文件。其它 scenario、缺省行为与 argv 既有键都不变。
- 新建 `server/test/fake-omp-branch.test.ts`（真实子进程，复用 `server/test/fake-omp-helpers.ts` 的 `startFake({scenario, extraArgs})` 等既有辅助，不改该 helper）。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：以当前主 spec 为底（已含 `abort-ok`/`abort-ignored`），并入父 delta 的 `--session-dir <dir>` argv 部分、`branch` 段与 Scenario「branch 产生真实新会话文件」，均逐字。`--approval-mode` 与审批类 scenario（6.3 #458、6.6 #470）、`slow-ready`（6.5 #461）、probe `frames=`（6.4 #459）不在本 delta，由对应 issue 归档时并入。

## Impact
- 只涉及测试支撑脚本与一个新测试文件；不触碰 `server/src/**`、既有测试文件与 `fake-omp-helpers.ts`。

## 偏离 issue 文本（依据 omp v18.0.10 源码）
- issue「Key interfaces」写 `get_branch_messages` 的 `response.data` 为 `[{entryId,text}]`。真实 omp 把列表包在 `data.messages` 里：`resource/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts:1347-1349` 为 `success(id, "get_branch_messages", { messages })`，`rpc-client.ts:847-849` 读 `.messages`。夹具按真实形状回 `data:{messages:[{entryId,text}]}`。父 spec 原句「a fixed deterministic list … `[{entryId,text}]`」没有说列表是否被包裹，逐字保留不冲突。父 design Context（`design.md:12`）同样的简写不在本 PR 边界内，只报告，不修改。
- issue 写 `branch` 响应为 `{text}`。真实 omp 为 `data:{text, cancelled}`（`rpc-mode.ts:488-491,1101-1105`）。夹具回 `{text, cancelled:false}`，`{text}` 的要求仍然满足；夹具不模拟扩展取消。
- 未知 `entryId` 的错误帧按真实 omp 回显 id：`agent-session.ts:8628-8629` 抛出 `Invalid entry ID for branching`，`rpc-mode.ts:401,754-755` 把它转成 `{id, type:"response", command:"branch", success:false, error}`。缺省 `unsupported` 兜底（`fake-omp.mjs:118-123`）不带 id，#488 的 `command()` 无法据此相关。

## Non-goals
- 其它 S1c scenario（6.3/6.5/6.6）、probe `frames=`（6.4）、runtime `command(frame)`（2.2b #488）、supervisor regenerate/fork（4.4 #465 / 4.5 #466）。
- 以下行为不模拟：列表随 `--resume` 文件内容或后续 prompt 变化；branch 后列表截短；扩展取消（`cancelled:true`）；夹具读取 `--resume` 文件；新文件真实内容；branch 前的 `available_commands_update` 帧。
- 写失败路径（session-dir 不存在等）不作契约。
