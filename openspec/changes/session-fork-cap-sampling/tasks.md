# Tasks — session-fork-cap-sampling (#1580)

Fixture level: none（只改测试，无运行时行为）. Risk packs: selected — Concurrency / shared state / ordering（删掉的采样与短命 branch 进程的释放竞争；保留的神谕在 spawn 时同步采样）；not selected — Error handling、Public API / CLI、Config、File IO、Schema、Auth / secrets、Resource limits（上限本身不变且仍被断言）、Release / packaging。

Must preserve: `server/src/**` 零改动；G1 的其余断言（`:506` 只有 `ok` / `capacity`、`:508` `expectWithinCap(world.liveAtSpawn, 2)`、`:509` 会话行数）与编排（两路 `hold` prompt、一个 regenerate、一个 fork 并发）不变；`session-supervisor-pool.test.ts` A2 不改；`session-fork-helpers.ts` 不改。

- [ ] 1.1 开工核对：`session-fork.test.ts:468-510`；`session-fork-helpers.ts`（`sampleSpawns`、`expectWithinCap`、`openCappedWorld`、`mixedScenarios` `:252-260`）；`server/src/sessions/pool.ts:142-173`；`session-supervisor-pool.test.ts:61-91`；`grep -rn "liveProcessCount()" server/test` 确认在拒绝回调里采样的只有 G1 与 A2。出入先改本 fixture 再继续。
- [ ] 1.2 修改：去掉 `seen` 数组、`capacity()` 里的 `seen.push(...)` 与 `:507` 断言；`capacity()` 只返回 `"capacity"`（或内联为字面量）。G1 内加一行注释说明为什么不在拒绝回调里采样（拒绝送达前短命 branch 进程可能已释放名额，issue 1580——写 `issue 1580`）。
- [ ] 1.3 变异证明（临时，跑完还原）：只把 G1 的 `openCappedWorld(2, true)` 改成 `openCappedWorld(3, true)`，`expectWithinCap(world.liveAtSpawn, 2)` 不动；跑 5 次，期望每次都在该断言红（某次 spawn 时已有 2 个存活，样本只计新 spawn 之前已存活的，如 `[[],[0],[0,1]]`），且 `:506`（只有 `ok` / `capacity`）与 `:509`（会话行数）仍通过。证据写明失败行、采到的 `liveAtSpawn` 数组与 5 次结果；若出现绿（拒绝加 fork 快速退出的窄路），记下并改用 cap 4 再跑 5 次。还原后复跑绿。输出记到 `.workplans/1580/evidence/`。
- [ ] 1.4 验证：`npx vitest run --root server test/session-fork` ×3；`npm test --workspace server` 全量；`make check`；`git diff --stat origin/master` 只含 `openspec/changes/session-fork-cap-sampling/**` 与 `server/test/session-fork.test.ts`。
