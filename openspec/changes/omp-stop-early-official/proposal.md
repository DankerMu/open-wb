# omp-stop-early-official — 官方二进制套件补「派发后极早停止」用例，abort 推迟逻辑的注释与三份测试头按 v18.12.3 实测重述（#1594）

## Why

宿主「`agent_start` 之前推迟 abort」（`server/src/sessions/omp/runtime.ts:246-256`、`:516-521`，`commands.ts:264-269` `isTurnStart`）是 #650 时按 omp v18.0.10 设计的：回执立即返回，预处理期间收到 `abort` 就静默丢弃整轮。v18.12.3 的 `docs/rpc.md` 把 `prompt` 回执推迟到消息被接纳之后（`:119`「acknowledges after the message is admitted」、`:315`「an idle turn has started for it」），被 abort 丢弃的 prompt 也回执并补 `prompt_result`（`status: "aborted"`，`:336-337`）。这条路径现在只有 fake-omp（`--start-delay-ms`）与单测覆盖，三份测试头（`fake-omp-early-abort.test.ts:2-5`、`omp-runtime-abort-start.test.ts:2-4`、`session-stop-early.test.ts:4-5`）与 `commands.ts:264-265` 的注释都还是 v18.0.10 实测；官方二进制套件 11 个文件里没有 abort 落在 `agent_start` 之前的用例（`grep abort` 只命中 rpc-ui 的 `ask` 取消与 upstream-failure 的退避中停止）。下次升级 omp 没有可执行的重验点。附带：`server/src/sessions/session-todo.ts:3` 的 todo 形状注释已标 v18.12.3，但没按 18.12.3 的 `TodoItem` 类型（多了可选 `details?` / `notes?`，`tui/src/tools/todo.ts:32-39`；工具结果按 `coding-agent/src/tools/todo.ts:93-97` `cloneTask` 读码不输出）核对。

## What

- 新官方文件 `server/test/omp-official-stop-early.test.ts`（`WORKBUDDY_OMP_TEST=1` 门下），用 `support/omp-official-proxied.ts` 的 `openProxiedApp`（生产装配 + SQLite + stop 路由 + stdout 帧 tee，同 `omp-official-upstream-failure.test.ts:427-498` 的写法）：一条用例——prompt 文本为 `你好 WORKBUDDY_FAKE_HANG`（假上游对**首个**模型请求不写头不写体地挂住，`fake-upstream.mjs:198` 的 `failures.serve` 先于工具轮分支；代理首字节期限缺省 120 s，远大于用例上限；teardown 的 `closeAllConnections()` 收尾），`POST /prompt` 得 202 后**立即** `POST /stop`（supervisor 在回 202 前已 `await stream.dispatched`，所以停止意图支不可达，只会走直接写或 `deferAbort`），断言恰一个 `turn.end(stopped)`、无 `error` 事件、从 stop 到 `turn.end` 用时 < 8000 ms（未走 `OMP_ABORT_GRACE_MS` 兜底）、`GET /messages` 的 `session.status === "stopped"`、`messages[0]` 为落盘的用户消息且 `messages[1].status === "stopped"`；`turn.end` 之后再等到 `prompt_result` 帧（omp 18.12.3 在 `agent_end` 后隔一个 macrotask 才写它，`rpc-prompt-results.ts:128,152`），断言其 `status === "aborted"`（`rpc.md:336-337`）且 `id` 等于 prompt 回执的 `id`。帧按字面识别：prompt 回执 = `type === "response" && command === "prompt"`，abort 回执 = `type === "response" && command === "abort"`。读数 `[stop-early] {order, agentStartBeforeStop, promptResultStatus, closedMs, requests}`：`order` 是 prompt 回执 / `agent_start` / abort 回执 / `prompt_result` 的首次出现次序，`agentStartBeforeStop` 在调用 stop 之前与返回之后各取一次（`frames` 里是否已有 `agent_start`），两值相同才能判定宿主走的是 `runtime.ts:255` 直接写还是 `:519` `deferAbort`（路径由 stop 路由内部调用 `abort()` 的瞬间决定，介于两次取值之间），不同则记「边界不定」。连跑 3 次：若 `order` 与 `agentStartBeforeStop` 三次一致，就冻结成字面量断言（v18.12.3 的回归钉，仓库「首跑冻结值」惯例）；若翻转，保留为读数并在 PR 与注释里写明「不稳定，未钉」。无论如何 SHALL 断言 abort 回执 `success === true` 且出现在 `agent_start` 之后（宿主所有路径都在读到起始帧之后才写 `abort`：`runtime.ts:255`、`:519`）。
- 三处 CI 写死清单追加该文件（`.github/scripts/ci-uid-isolation.sh:292`、`scripts/test-ci-harness.sh:92`、`:849`，与 #1588 同法，`make test-guardrails` 证明三处一致）。
- 按实测改注释（仅注释，不改逻辑）：`commands.ts:264-267` `isTurnStart` 的文档注释与 `runtime.ts:246-249` `abort()` 的文档注释写明：宿主的「派发回执」是 stdin 写完（`runtime.ts:313-314` 在 `send` 后立即 `#resolveReceipt`，`process.ts:259-261` 的 `send` 只是写），与 omp 的 `response` 帧无关，所以 `deferAbort` 的窗口「写出 prompt → 读到 `agent_start`」在 18.12.3 上按构造仍可达；再写 v18.12.3 的 omp 回执语义（接纳后才回）与本机实测的 `agentStartBeforeStop` / `order` 读数（引用新文件）；三份测试头把「omp v18.0.10 实测」改为「v18.0.10 实测的窗口；v18.12.3 实测见 `omp-official-stop-early.test.ts`」；`session-todo.ts:3` 补「18.12.3 `TodoItem` 类型声明了可选 `details?` / `notes?`，工具结果按读码不输出，宿主只读 `content` / `status`」。issue 里「`agent_start` 可能先于回执、`deferAbort` 可能不可达」的推断是把 omp 的 `response` 帧误当成了宿主回执，fixture 不再沿用。
- 不改宿主 abort 推迟逻辑本身（实测发现行为不一致时另开 issue）；不碰 `server.ts:28` 与 ADR-0012 第四部分列的其他注释。

`design.md` 省略：compact 级，一条官方用例 + 注释，无运行时行为改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; one official case + comment updates, no runtime behavior)
Blast radius: none at runtime (comments only in server/src); a wrong case would be vacuous (model answers before the stop lands — ruled out by WORKBUDDY_FAKE_HANG, which never answers the first request) or flaky on ordering — the outcome assertions are stable, the ordering is pinned only after three identical runs
Selected risk packs: Concurrency / shared state / ordering (receipt vs agent_start vs abort ordering is the subject; the stop lands as early as the HTTP surface allows); Release / packaging (new official file → three hard-coded CI lists); Documentation / migration notes (five comment sites re-versioned from the measurement; ADR-0012 part four gains the re-verify pointer)
Evidence floor: WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official- (12 files green; new file ×3 with the [stop-early] readings — order, agentStartBeforeStop, promptResultStatus, closedMs — recorded in the PR, pinned as literals only when all three agree); npm test --workspace server (default: new file skipped); typecheck; make check; make test-guardrails; git diff -- server/src is comments only (verified by reading the diff)
```
