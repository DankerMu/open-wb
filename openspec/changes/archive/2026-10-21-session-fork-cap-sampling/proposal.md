# session-fork-cap-sampling — 进程上限用例在准入时刻采样，不在拒绝送达后采样（#1580）

## Why

`server/test/session-fork.test.ts` › fork over real fake-omp branch children (#466) ›「G1 cap 2 holds across concurrent prompts, a regenerate and a fork」（`:468`）在满负载全量跑时偶发红（PR #1579 phase 2，darwin，236 ms，非超时）：`:507` `expect(seen.every((count) => count === 2)).toBe(true)` 失败。`seen` 由 `capacity()`（`:478-481`）在 503 / `agent_capacity` 拒绝**传回测试之后**的回调里读 `supervisor.liveProcessCount()` 得到。产品侧只在准入那一刻池满且无可驱逐项时拒绝（`server/src/sessions/pool.ts:168-173`，准入串行 `:142-149`），所以拒绝发生时池一定满；读到非 2 只能是拒绝与采样之间有条目被释放（`pool.ts:156-160`）。G1 的名额在拒绝之后会变：带 `--resume` 的进程走 `branch`（`session-fork-helpers.ts:252-260`）——fork 临时进程（`branch-temp.ts:105`）做完即退出并释放名额（`:114-118`），regenerate 进程回合结束后仍存活但变为可驱逐，下一次准入时被 `retire()` 驱逐（`pool.ts:174-179`）。这是测试神谕的采样时机错误，不是产品越限；`:508` `expectWithinCap(world.liveAtSpawn, 2)`（spawn 时同步采样）才是不超限的直接证据。

## What

- 测试：删掉 `:479` 的 `seen.push(supervisor.liveProcessCount())` 与 `:507` 的断言（`seen` 与 `capacity()` 的计数职责一并去掉，`capacity()` 只返回 `"capacity"`）。保留的不变量断言：`:506`（被拒的只有 `agent_capacity`）、`:508` `expectWithinCap(world.liveAtSpawn, 2)`、`:509`（会话行数随 fork 结果）。
- 兄弟用例 `session-supervisor-pool.test.ts:61-91`（A2，`:71` 事后采样、`:81` `[2, 2]`）全是 `hang-prompt`、准入后不释放，采样稳定，不改；在 PR 里写明理由。
- 规格：verification-harness 新增 Requirement「进程上限断言在准入时刻采样」。
- 不做：`pool.ts` 的准入 / 驱逐逻辑；用 stdout gate 挡住 `branch` 回包以保住「拒绝时池满」那层（issue 的备选：改编排、对到达次序更敏感）；放宽为 `<= 2` 或加重试。

`design.md` 省略：none 级，删一个时机错误的断言 + 一条测试纪律要求。

## Triage

```text
Issue type: test
Fixture level: none
Upstream suggested level: absent (issue-scribe filed; S)
Level rationale: none — an isolated test-expectation change with no runtime behavior (issue-risk-contract `none`); the expanded concurrency trigger is about product concurrency, which is untouched. Same artifact set as compact.
Blast radius: one server test; if the cap invariant were weakened, `expectWithinCap(world.liveAtSpawn, 2)` (spawn-time) still fails on any third live process
Selected risk packs: Concurrency / shared state / ordering (the deleted sample raced with releases of short-lived branch children; the kept oracle samples synchronously at spawn); not selected — Error handling, Public API / CLI, Config, File IO, Schema, Auth / secrets, Resource limits (the cap itself is unchanged and still asserted), Release / packaging
Evidence floor: `npx vitest run --root server test/session-fork` green ×3; a mutation run with `openCappedWorld(3, true)` (temporary, reverted) turns G1 red at `expectWithinCap(world.liveAtSpawn, 2)` (some spawn sees 2 already live) while the earlier rejection-kind assertion (`:506`) still passes — proving the remaining oracle still guards the cap; `npm test --workspace server` full green; `make check`; no `server/src` change
```
