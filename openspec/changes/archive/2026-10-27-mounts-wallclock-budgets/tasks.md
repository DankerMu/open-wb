## 1. 预检用例的超时预算

- [x] 1.1 `server/test/mounts-config.test.ts`：新增 `const ID_CASE_MS = 30_000;`，注释说明它高于两次 `spawnSync` 假 `id` 各自产品期限 `ID_TIMEOUT_MS`（10 s）之和（20 s），只为负载留余量（#1804）。会走到 `idOutput` 的用例（`RCLONE_BIN`、`OMP_USER` 都给出且过了 fuse.conf 检查，`config.ts:110-130`）恰为两处：`:447` 预检 `it.each`（timeout 写第三个参数，照同文件 `:536` 起那个 `it.each` 的写法）与 `:462` 前提齐全那一例（第二个参数 `{ timeout: ID_CASE_MS }`）。`:167 :476 :492 :501` 不走 `idOutput`，不改。不改任何断言。

## 2. 取消界值

- [x] 2.1 `server/test/mounts-manager-lifecycle.test.ts`：`CANCEL_BOUND_MS` 改为 `15_000`，新增 `STOP_GRACE_BEYOND_BOUND_MS = 20_000`。注释写明：界值严格低于 20 s 就绪窗口，用来区分「等满窗口」；这些用例的 manager 把宽限期注入到界值以上，用来区分「误走 SIGTERM 宽限」；计时区间含真实进程创建，所以留足余量（#1804）。断言 `CANCEL_BOUND_MS` 的 7 个用例（`:279 :354 :402 :428 :467 :485 :525`）的 `world.manager(...)` 都加上 `stopTimeoutMs: STOP_GRACE_BEYOND_BOUND_MS`，原有选项（如 `probeExec`）保留。
- [x] 2.2 `server/test/mounts-rest-lifecycle.test.ts`：同值副本做同样的修改，`:119` 那个用例通过 `openMounts({ overrides: { stopTimeoutMs: ... } })` 注入。
- [x] 2.3 两个文件里其它断言都不改。`mounts-rclone-conf.test.ts:323` 不在范围内（被测期限 1.5 s，余量充足，未红过）。

## 3. 反向验证（证据，不入库）

- [x] 3.1 回归 A，等满窗口：临时 (a) 删除 `attempt.ts:261-262` `mountOnce` 的 abort 监听（`child?.signal("SIGKILL")`），连同 `finally` 里对应的 `removeEventListener` 一起删；(b) 删除 `rclone-process.ts` `awaitReady` 里的两处 `wait.signal.aborted`（`:128`、`:142`）。跑 `npm run test:focus --workspace server -- mounts-manager-lifecycle mounts-rest-lifecycle`，预期 hang 类用例 `:279 :402 :467`（以及 rest `:119`）等到 20 s deadline 才 discard，在 15 s 界值断言上变红。随后还原。（若再把 `:141` 传给 `probeExec` 的 signal 换成 `undefined`，`:354 :428 :485` 会在 `CASE_MS` 上挂死变红，这可以记录，但不能替代上一条。）
- [x] 3.2 回归 B，误走宽限：临时修改 `attempt.ts`：(a) `mountOnce` 的 abort 监听改成发 `SIGTERM`；(b) `discard` 的 `await killChild(child)` 改成 `await stopChild(child, context.stopTimeoutMs ?? 5_000)`，并给 `AttemptContext` 临时加 `stopTimeoutMs?: number`（`manager.ts` 用 `...options` 传给 `createAttempts`，值已经在里面）。**不要动 `rclone-process.ts` 的 `killChild`**（`stopChild` 超时后回调它，改了会递归）。跑同一命令，预期 `:279 :354 :402 :428 :467 :485`（及 rest `:119`，若它有子进程）约 20 s，在 `CANCEL_BOUND_MS` 断言上变红；`:525` 没有子进程，不变红属正常。对照：同一临时改动下去掉用例里的 `stopTimeoutMs` 注入，应全绿（约 5 s < 15 s），证明注入是必要的。随后全部还原。
- [x] 3.3 两次的红输出摘要写进实现报告，并确认 `git diff --stat` 里没有 `server/src/**`。

验证：
- `npm run test:focus --workspace server -- mounts-config mounts-manager-lifecycle mounts-rest-lifecycle` → 退出码 0。
- `make check` → 退出码 0。
