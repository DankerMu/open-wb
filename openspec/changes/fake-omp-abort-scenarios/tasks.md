# Tasks: fake-omp-abort-scenarios（#456）

## 6. omp-test-harness — fake-omp

- [ ] 6.1 `server/test/support/fake-omp.mjs` 新 scenario `abort-ok`（收到 abort → 当前回合 `message_end{stopReason:"aborted"}` + `agent_end` + `response{command:"abort"}`，之后可继续 prompt；早于 `agent_start` 与两段 delta 之前读到的 abort 在它们发出后立即兑现，宿主总是看到 `agent_start`、两段 delta、`message_end aborted`、`agent_end` 的固定次序）与 `abort-ignored`（收到 abort 不回）。验证：新建 fake-omp 契约测试文件（真实子进程）断言两场景帧序列

## 实现要点与必需证据
- fake 的入站帧经 `queue = queue.then(onLine)` 串行处理（`fake-omp.mjs:42-44`）。`abort-*` 场景的 `handlePrompt` 在发完 ack、`agent_start` 与两段 delta 后必须**返回**，只把挂起回合记在模块状态里，不得 await 等待 abort 的 promise，否则 abort 行永远排不到。`dispatch` 新增 `abort` 处理器：
  - `abort-ok` 且有挂起回合时，依次发出以下帧，然后清除挂起状态：
    - `{type:"message_end",message:{role:"assistant",content:[],stopReason:"aborted"}}`：嵌套形状同 `failTurn`（`fake-omp.mjs:335-349`），只把 stopReason 换成 `"aborted"`；归约器读的是 `message.stopReason`（`server/src/sessions/events.ts:216,224`）；
    - `{type:"agent_end",messages:[],isTerminal:true}`：同 `:340`；
    - `{id:<abort id>,type:"response",command:"abort",success:true}`：不带 `data`，同 omp v18.0.10 rpc-mode。
  - 清除挂起状态后，下一条 prompt 走 `handlePrompt` 的缺省路径 `probeReport` → `completeTurn`（`:229-234`），不另写硬编码回合。6.5 `slow-ready` 与 turn-control「派发前停止」都会在 aborted 回合之后发 probe prompt。
  - `abort-ignored` 不发任何帧。其余场景（含缺省 `normal`）的 abort 仍落入既有 `unsupported` 兜底（`:114-119`）。
- 早到 abort：`startFake({scenario:"abort-ok"})` 之后，手动完成 `HANDSHAKE` 的两条请求和应答；在等待任何 prompt 应答之前，一次调用 `session.write([PROMPT, abortFrame])`。不得用 `startPromptedSession`，因为它会先等 prompt ack（`fake-omp-helpers.ts:172-173`）。固定次序由串行队列保证，与 stdin 分块无关。
- 必需证据：新建 `server/test/fake-omp-abort.test.ts`，使用 `fake-omp-helpers.ts` 的 `startFake`/`startPromptedSession`/`HANDSHAKE`/`PROMPT`/`closeSession`/`response`/`isTextDelta`/`asRecord`，helper 不改。
  1. `abort-ok` 正常时序（先红）
     - 输入：`startPromptedSession({scenario:"abort-ok"})`。
     - 期望：prompt ack 之后恰好是 `agent_start` 与两段 text delta，随后 300ms 观察窗内无新帧且进程存活（写法同用例 3：`session.wait(() => session.frames.length > n, 300)` 以 `/timed out/` 拒绝）。写入 `{type:"abort",id:"req_abort"}` 之后，新增帧恰为三帧：`message_end`（`asRecord(frame.message).stopReason === "aborted"`、`role === "assistant"`）→ `agent_end`（`isTerminal:true`）→ `{id:"req_abort",type:"response",command:"abort",success:true}`。之后发 `{id:"req_2",type:"prompt",message:"again"}`，得到 `response("req_2","prompt")` 与完整的缺省回合：≥3 段 delta、assistant `message_end` 的 `message.stopReason === "stop"`、终止 `agent_end`。
     - 为何先红：场景未实现时 `--scenario` 回落为 `normal`，回合立即完成，「观察窗内无帧」断言失败。
  2. `abort-ok` 早到 abort（先红）
     - 输入：按上面的早到构造方式。
     - 期望：prompt 应答之后的帧序为 `agent_start`、两段 delta、`message_end aborted`、`agent_end`、`response{id,command:"abort",success:true}`。
  3. `abort-ignored`（整体先红）
     - 输入：`startPromptedSession({scenario:"abort-ignored"})`，prompt ack 后同样只有 `agent_start` 与两段 delta；写入 abort。
     - 期望：观察窗写成一次 helper 调用：`await expect(session.wait(() => session.frames.length > n, 300)).rejects.toThrow(/timed out/)`。helper 的超时分支报 `timed out waiting for frame`（`fake-omp-helpers.ts:127-129`），进程退出分支报 `child exited before frame`（`:138-144`），所以这一条断言同时证明「无帧」和「存活」。之后再 `closeStdin()`，断言 `waitExit()` 返回 `0`，即 stdin 关闭后干净退出。
     - SIGTERM 实例：在新测试文件内直接 `spawn(process.execPath, [fakeOmpPath, "--scenario", "abort-ignored"])`，先例见 `fake-upstream.test.ts:265-267`；读到 `ready` 后发 `child.kill("SIGTERM")`，观察 `close` 事件，断言 `code !== null || signal === "SIGTERM"`（同先例）。该子进程不在 helper 的 `children` 列表里，用例内以 `try/finally` 执行 `child.kill("SIGKILL")` 兜底回收。
     - 为何先红：缺省 `normal` 会完成回合，并对 abort 回 `unsupported` 帧，所以「观察窗内无帧」失败。stdin 关闭与 SIGTERM 两条子断言在缺省下本来就是绿的。
  4. 守卫（恒绿）
     - 输入：缺省 `normal` 下，回合完成后写入 `{type:"abort",id:"req_abort"}`。
     - 期望：得到既有的 `{type:"response",command:"abort",success:false,error:"unsupported"}`（不带 id），证明缺省行为不变。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Concurrency / shared state / ordering | yes | abort 可早于 `agent_start` 到达 → 「早到 abort」用例断言固定帧序 `agent_start`、两段 delta、`message_end aborted`、`agent_end`、`response{id,command:"abort"}` |
| Legacy compatibility / examples | yes | 既有 scenario 与缺省行为不变 → 既有 `fake-omp.test.ts`、`omp-*.test.ts` 零改动全绿 |
| Error handling / rollback / partial outputs | yes | abort-ignored 时进程须仍可被 stdin 关闭或 SIGTERM 终止 → 两个退出用例 |
| Public API / CLI / script entry | no | 测试夹具 argv 仅供测试（`--scenario` 既有机制） |
| Config / project setup | no | 不涉 |
| Schema / columns / units / field names | no | 帧字段逐字取自父 spec |
| File IO / path safety / overwrite | no | 不涉 |
| Auth / permissions / secrets | no | 不涉 |
| Resource limits / large input / discovery | no | 观察窗为固定短时（如 300ms），不引入长等待 |
| Release / packaging / dependency compatibility | no | 零依赖脚本不变 |
| Documentation / migration notes | no | 不涉 |

## 通用纪律（继承父 tasks.md）
- [ ] 只改 `server/test/support/fake-omp.mjs` 与新建 `server/test/fake-omp-abort.test.ts`；既有测试与 helper 零改动。
- [ ] 正向断言先红后绿（scenario 未实现时，fake 以缺省 `normal` 运行、立即完成回合，断言「两段 delta 后无帧直到 abort」失败为红）。
- [ ] `npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0；`openspec validate fake-omp-abort-scenarios --strict --no-interactive` 通过。
