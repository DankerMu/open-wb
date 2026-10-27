## Why

满负载跑全量（`make check`）时，mounts 有两组用例会偶发失败（#1804）：

1. `server/test/mounts-config.test.ts:447`「预检」`it.each`（issue 写的 `:412` 是 #1789 之前的行号） 是同步回调，里面通过 `idOutput` 两次 `spawnSync` 假 `id`，却没有显式 timeout，用的是 vitest 默认的 5000 ms。vitest 的 `withTimeout` 在同步回调返回后会补查墙钟，所以整段工作一旦超过 5 s 就判超时。产品侧单次 `id` 的期限是 `ID_TIMEOUT_MS = 10_000`（`config.ts:16`），用例预算本来就应该比它大。
2. `server/test/mounts-manager-lifecycle.test.ts:40` 的 `CANCEL_BOUND_MS = 5000` 是真实墙钟界值，计时区间里包含 SIGKILL 假 rclone、真实 spawn 假 `fusermount3`、排空各条链。本机实测超限值有 5071、5905、5510；单独跑时只要约 550 ms。`mounts-rest-lifecycle.test.ts:37` 有一份同值副本。

这个界值同时承担两件事：
- 证明被取消的 attempt 不会等满 20 s 就绪窗口（`READY_WINDOW_MS`，`attempt.ts:43`）；
- 顺带证明取消直接 SIGKILL，而不是走 `stopChild` 的「SIGTERM 加 `STOP_GRACE_MS = 5_000` 宽限」（`manager.ts:75`）。这些用例的 `hang` / `stubborn` 假 rclone 不理 SIGTERM，走宽限路径至少要 5 s。

只把界值放宽到 15 s 会丢掉第二件事，所以要同时把这些用例的宽限期注入到界值以上。

## What Changes

- `mounts-config.test.ts`：凡会 spawn 假 `id`（经 `resolveMountSettings` 的 `OMP_USER` 路径）的用例，都给显式 timeout `ID_CASE_MS = 30_000`，不再依赖默认 5000 ms。`it.each(cases)(name, fn, timeout)` 的 timeout 写在第三个参数，普通 `it` 写成 `{ timeout }`。
- `mounts-manager-lifecycle.test.ts` 与 `mounts-rest-lifecycle.test.ts`：
  - `CANCEL_BOUND_MS` 改为 `15_000`，严格低于 20 s 就绪窗口。
  - 凡断言 `CANCEL_BOUND_MS` 的用例，manager 都以 `stopTimeoutMs: STOP_GRACE_BEYOND_BOUND_MS`（`20_000`，大于界值、小于 `CASE_MS` 30 s）构造，于是「取消误走 SIGTERM 宽限」这类回归仍然会在界值断言上变红。
  - 注释写明界值区分的两类回归。
- 产品代码、全局 `testTimeout` 都不改，不加 retry。
- ADDED verification-harness「墙钟界值留足进程冷启动余量且不丢回归区分度」。

## Triage

```text
Issue type: test
Fixture level: none
Upstream suggested level: absent
Blast radius: 只影响测试稳定性；改错则 7+1 处取消界值失去对「等满就绪窗口」或「误走 SIGTERM 宽限」的覆盖，或预检用例被掩盖真实挂起
Selected risk packs: none
Evidence floor: 两类回归各做一次反向验证（临时改产品代码，跑后还原，结果写进 PR body）；test:focus 三个文件通过；make check
```

`design.md` 省略：none 级，取舍已写在上文。
