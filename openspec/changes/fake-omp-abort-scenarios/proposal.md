## Why
父 change `s1c-turn-control-governance` tasks 6.1（epic #448）。停止生成（2.2b runtime `abort()`、4.2a supervisor stop 与有界退回）必须以真实子进程证明两条路径：abort 被 omp 兑现为 aborted 收尾，与 abort 被忽略时宿主有界退回。现有 fake-omp 没有任何 scenario 响应入站 `abort`。

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: compact (agree: 测试支撑脚本 + 自带契约测试，无生产代码、无共享入口)
Compact despite Concurrency/Legacy packs: 只有单进程内一条 promise 串行队列，次序确定、无跨进程共享状态；改动只新增分支，不改任何既有路径；13 个消费 fake-omp 的既有测试文件由「零改动全绿」保护。
Blast radius: 后续停止相关测试的可信度——帧序若与真实 omp 不符，2.2b/4.2a 的测试会证明想象中的行为。
Selected risk packs: Concurrency / shared state / ordering（abort 到达时机与固定帧序）；Legacy compatibility / examples（既有 scenario 与缺省行为不变）
Evidence floor: 新建 fake-omp 契约测试文件（真实子进程）覆盖 issue 验收三条（abort-ok 正常位置、abort-ok 早到 abort、abort-ignored 观察窗/stdin 关闭/SIGTERM）；正向断言先红（scenario 未实现时以缺省行为运行）后绿；既有 fake-omp 测试零改动全绿；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift` 退出 0。design.md 省略（compact：无共享入口、无格式/schema 变化）。

## What Changes
- `server/test/support/fake-omp.mjs`：新增 `--scenario abort-ok` 与 `--scenario abort-ignored` 分支（入站 `{type:"abort",id}` 的应答与不应答两态）。既有 scenario、缺省行为、argv 解析的既有键不变。
- 新建 `server/test/fake-omp-abort.test.ts`（真实子进程，复用 `server/test/fake-omp-helpers.ts` 既有 spawn/帧读取辅助，不改该 helper）。

## Capabilities
- MODIFIED `omp-test-harness`「假 omp 进程契约」：以主 spec 为底，并入父 delta 中 `abort-ok`/`abort-ignored` 两段与 Scenario「abort 收尾与忽略」（逐字）；其余 S1c scenario 与 `--session-dir`/`--approval-mode` argv 由 6.2–6.6 对应 issue 并入。

## Impact
- 仅测试支撑脚本与一个新测试文件；不触碰 `server/src/**` 与既有测试文件。

## Non-goals
- 其它 S1c scenario（6.2/6.3/6.5/6.6）、probe `frames=`（6.4）、runtime `abort()`（2.2b）、supervisor stop（4.2a）。
