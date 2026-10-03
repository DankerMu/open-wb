# Tasks: managed-writer-shared-listener（#787）

Fixture level: compact
Risk packs: stream-lifecycle

## 1. 实现
- [ ] 1.1 `server/src/startup-writer.ts`：共享监听 + 在途集合；文件头注释同步。导出签名 `writeManagedLine(stream, line): Promise<void>` 不变。
- [ ] 1.2 `server/test/startup-writer.test.ts`（或同目录新文件）：规格三个场景；真实 `process.stderr` 场景用子进程（`node` 运行一个临时脚本或 `--input-type=module -e`，导入编译前源码需经 tsx/vitest 可用的方式——以仓库现有测试的子进程做法为准）。

允许改动的文件：上列两个（及一个新测试文件）。不得改 `server/src/server.ts`、`openspec/**`、`docs/**`。

## 2. Must preserve
- 三条失败路径（同步 throw、write callback error、stream `error` 事件）各自恰 settle 一次；成功路径 resolve。
- 晚到的 EPIPE `error` 不成为未处理异常。
- 既有 `startup-writer.test.ts` 用例与全部调用方行为（`server_started`、`server_start_failed`、`omp_handshake_timeout`、`session_fault`、`listener_force_close`）。
- 不同 stream（stdout / stderr）互不影响。

## 3. 必需证据
- E1 新场景三条 + 既有用例全绿；RED：新场景在基线上失败（16 次调用出现警告 / 监听数断言）。
- E2 `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（≤179）、`bash scripts/size-guard.sh`、`openspec validate managed-writer-shared-listener --strict --no-interactive`。

## 4. 负向对照
- N1 恢复逐条挂监听 → 16 次调用场景失败。
- N2 最后一条 settle 后同步摘除监听（不等 `setImmediate`）→ 晚到 `error` 场景失败（未处理 error）。
- N3 stream error 只 reject 第一条在途记录 → 三条在途场景失败。
- N4 用 `setMaxListeners` 掩盖 → 监听数断言失败。
