# Tasks — office-queue-cancel-scan (#1574)

Fixture level: none（只改测试，无运行时行为）. Risk packs: selected — Concurrency / shared state / ordering（观察须在 cancel 写下、作业目录删除之前的同一拍里同步发生）；not selected — Error handling、Public API / CLI、Config、File IO、Schema、Auth / secrets、Resource limits、Release / packaging（只改测试）。

Must preserve: `server/src/**` 零改动；`server/test/support/fake-sidecar.ts` 不改；被改用例的意图断言（`cancel` 已写、作业目录已删、零额外启动、各调用的落定状态）全部保留；`GONE_WITHIN` 不变；不引入假定时器；`office-queue.test.ts` 其余用例不改。

- [ ] 1.1 开工核对：`office-queue.test.ts:180-200`（`:189` abort、`:191-193` 同步断言、`:196` `launched(on)`、`:198` 等 `cancelAt`）、`:380-396`（样板：`:388` `on.launches`、`:390` `watch()` 同拍 `scan()`）、`:428-452`（`:438` `close()`、`:441` `existsSync`、`:450`）；`fake-sidecar.ts:15-17`（头注释）、`:160-168`（`scan`）、`:196-201`（`onJobs`）、`on.launches`（`office-cache-helpers.ts:128` getter，每次读取先同步扫 `jobs/`）与 `launched()`；`server/src/preview/office.ts:227,296-308,332-337`。出入先改本 fixture 再继续。
- [ ] 1.2 修改：`:189` 之后与 `:438` 之后的同一拍里（`cancel` 已写、目录仍在——各自紧随已有的 `existsSync(…/cancel)` 断言）同步读一次 `on.launches`（或该文件里等价的同步扫描入口），把 `:198` 与 `:450` 的 `vi.waitFor(…cancelAt…)` 改为直接 `expect(…cancelAt).toBeDefined()`。
- [ ] 1.3 变异证明（临时，跑完还原）：让假 sidecar 不经事件记下 `cancel`（例如临时让 `onJobs` 对 `cancel` 不记 `cancelAt`），旧写法的这两处在 `GONE_WITHIN` 处红、新写法绿；还原后 `git diff -- server/test/support` 为空。输出记到 `.workplans/1574/evidence/`。
- [ ] 1.4 核查其它五处：`office-converter.test.ts:513/528/544`、`server-startup-office.test.ts:192/200`——逐个写明 `cancel` 写下后到断言之间是否有确定的 `scan()`、作业目录是否随即被删；暴露的照 1.2 改，不暴露的写理由（报告里一行一处）。
- [ ] 1.5 验证：`npx vitest run test/office-queue.test.ts` ×3（`server/` 下）；改到的其它文件各跑一次；`npm test --workspace server` 全量；`make check`；`git diff --stat origin/master` 只含 `openspec/changes/office-queue-cancel-scan/**` 与 `server/test/**`（不含 `server/test/support/**`）。
