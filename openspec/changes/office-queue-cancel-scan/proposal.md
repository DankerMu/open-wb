# office-queue-cancel-scan — 假 sidecar 的 cancel 观察不依赖文件事件送达（#1574）

## Why

`server/test/office-queue.test.ts` › 「并发上限与排队：关停与参数」›「close()：排队的全部 aborted 且零启动…」在满负载下偶发红（PR #1573 phase 2，darwin，`npm test --workspace server` 5932 pass / 1 fail）：`:450` `await vi.waitFor(() => expect(job?.cancelAt).toBeDefined(), GONE_WITHIN)` 等满 6 s 仍为 `undefined`。进程内假 sidecar（`server/test/support/fake-sidecar.ts`）只有两条路记下 `cancelAt`：`scan()`（`:166`，要求扫描那一刻作业目录与 `cancel` 都在）与 `fs.watch` 回调 `onJobs`（`:196-201`，事件名恰为 `<id>/cancel`）。app 的 `close()`（`server/src/preview/office.ts:332-337`）对在途作业同步写 `cancel`（`:227`）后，`convert` 随即进 `finally` 删掉整个作业目录（`:296-308`）；该用例在 `close()` 之后没有任何触发 `scan()` 的读取，于是能否通过完全取决于 OS 文件事件是否送到（假 sidecar 头注释 `:15-17` 已记下 macOS FSEvents 偶发漏记）。`:198`（`abort.abort()` 之后）暴露面相同。同文件 `:388` 的用例在 abort 的同一拍里经 `on.launches` 同步 `scan()`，已是确定的样板。

## What

- 测试：`office-queue.test.ts:198` 与 `:450` 所在用例，在 `abort.abort()` / `cache.close()` 之后、`cancel` 已写且作业目录仍在的同一拍里同步读一次 `on.launches`（触发 `scan()`），随后把 `vi.waitFor(() => expect(…cancelAt).toBeDefined())` 改成直接 `expect(…cancelAt).toBeDefined()`；用例的其它断言（cancel 已写、作业目录已删、零额外启动、状态）不变。
- 其它五处按规格的三类处理：`office-converter.test.ts:528/544`（测试同步触发 abort / close）照同一样板改；`:513`（转换器计时器写 cancel、同一宏任务内删目录）改用同文件 `:487-492` 已有的 `fs.rmSync` spy，在删目录那一刻同步扫描；`server-startup-office.test.ts:192/200`（app 在子进程里，无法同拍扫描）保留等待并写明理由，它承载的「1.5 s 内中止、早于 2 s 关停预算」结论不动。
- 规格：verification-harness 新增 Requirement「假 sidecar 的 cancel 观察不依赖文件事件送达」。
- 不做：产品代码 `office.ts` 的 cancel / 删目录时序（符合 sidecar 协议）；`fake-sidecar.ts` 的监听实现；加大 `GONE_WITHIN`；假定时器。

`design.md` 省略：none 级，测试内一处同步读取的搬移 + 一条测试纪律要求。

## Triage

```text
Issue type: test flake (bug in the test, not the product)
Fixture level: none
Upstream suggested level: absent (issue-scribe filed; S)
Level rationale: none — an isolated test-expectation change with no runtime behavior (issue-risk-contract `none`); the expanded concurrency trigger is about product concurrency, which is untouched. Same artifact set as compact.
Blast radius: server tests only; a wrong change either still waits on events (mutation below stays red) or scans after the directory is gone (cancelAt undefined, red immediately)
Selected risk packs: Concurrency / shared state / ordering (the observation must happen in the same tick as the cancel write, before `convert`'s finally removes the job directory); not selected — Error handling, Public API / CLI, Config, File IO (no product IO change), Schema, Auth / secrets, Resource limits, Release / packaging
Evidence floor: `npx vitest run test/office-queue.test.ts` green ×3; a mutation run with fs.watch delivery suppressed for `cancel` (temporary, reverted) — old assertions red at the 6 s wait, new ones green; `npm test --workspace server` full green; the five other sites each classified with a reason; `make check`; no `server/src` change
```
