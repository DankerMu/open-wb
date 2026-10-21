# omp-stop-early-official — 官方二进制套件补「派发后极早停止」用例，abort 推迟逻辑的注释与三份测试头按 v18.12.3 实测重述（#1594）

## Why

宿主「`agent_start` 之前推迟 abort」（`server/src/sessions/omp/runtime.ts:246-256`、`:516-521`，`commands.ts:264-269` `isTurnStart`）是 #650 时按 omp v18.0.10 设计的：回执立即返回，预处理期间收到 `abort` 就静默丢弃整轮。v18.12.3 的 `docs/rpc.md` 把 `prompt` 回执推迟到消息被接纳之后（`:119`「acknowledges after the message is admitted」、`:315`「an idle turn has started for it」），被 abort 丢弃的 prompt 也回执并补 `prompt_result`（`status: "aborted"`，`:336-337`）。这条路径现在只有 fake-omp（`--start-delay-ms`）与单测覆盖，三份测试头（`fake-omp-early-abort.test.ts:2-5`、`omp-runtime-abort-start.test.ts:2-4`、`session-stop-early.test.ts:4-5`）与 `commands.ts:264-265` 的注释都还是 v18.0.10 实测；官方二进制套件 11 个文件里没有 abort 落在 `agent_start` 之前的用例（`grep abort` 只命中 rpc-ui 的 `ask` 取消与 upstream-failure 的退避中停止）。下次升级 omp 没有可执行的重验点。附带：`server/src/sessions/session-todo.ts:3` 的 todo 形状注释已标 v18.12.3，但没按 18.12.3 的 `TodoItem` 类型（多了可选 `details?` / `notes?`，`tui/src/tools/todo.ts:32-39`；工具结果按 `coding-agent/src/tools/todo.ts:93-97` `cloneTask` 读码不输出）核对。

## What

- 新官方文件 `server/test/omp-official-stop-early.test.ts`（`WORKBUDDY_OMP_TEST=1` 门下），用 `support/omp-official-proxied.ts` 的 `openProxiedApp`（生产装配 + SQLite + stop 路由 + stdout 帧 tee，同 `omp-official-upstream-failure.test.ts:427-498` 的写法）：一条用例——prompt 文本带 `WORKBUDDY_HOLD_AT:thinking`（假上游在思考段挂起，回合不会自己结束），`POST /prompt` 得 202 后**立即** `POST /stop`，断言恰一个 `turn.end(stopped)`、无 `error` 事件、从 stop 到 `turn.end` 用时 < 8000 ms（未走 `OMP_ABORT_GRACE_MS` 兜底）、`GET /messages` 的 `session.status === "stopped"`、`messages[0]` 为落盘的用户消息且 `messages[1].status === "stopped"`；并把本轮 stdout 帧里 prompt 的 `response` 回执、`agent_start`、abort 的 `response`、`prompt_result`（含 `status`）的**先后次序**作为 `[stop-early]` 读数打印，连跑 3 次记录是否稳定。回执与 `agent_start` 谁先到不在断言里钉死（这是本 issue 要回答的问题，答案进注释），但 SHALL 断言 abort 的 `response` 帧 `success === true` 且出现在 `agent_start` 之后（宿主要么推迟到 start 再写、要么 start 已先到——两种情况下都成立；若实测出现 abort 回应先于 `agent_start`，说明宿主写早了，用例红）。
- 三处 CI 写死清单追加该文件（`.github/scripts/ci-uid-isolation.sh:292`、`scripts/test-ci-harness.sh:92`、`:849`，与 #1588 同法，`make test-guardrails` 证明三处一致）。
- 按实测改注释（仅注释，不改逻辑）：`commands.ts:264-267` `isTurnStart` 的文档注释与 `runtime.ts:246-249` `abort()` 的文档注释写明 v18.12.3 的回执语义与实测次序（若 `agent_start` 先于回执，写明 `deferAbort` 分支在 18.12.3 上不可达、只为 fake-omp 与旧行为保留）；三份测试头把「omp v18.0.10 实测」改为「v18.0.10 实测的窗口；v18.12.3 实测见 `omp-official-stop-early.test.ts`」；`session-todo.ts:3` 补「18.12.3 `TodoItem` 类型声明了可选 `details?` / `notes?`，工具结果按读码不输出，宿主只读 `content` / `status`」。
- 不改宿主 abort 推迟逻辑本身（实测发现行为不一致时另开 issue）；不碰 `server.ts:28` 与 ADR-0012 第四部分列的其他注释。

`design.md` 省略：compact 级，一条官方用例 + 注释，无运行时行为改动。

## Triage

```text
Issue type: test
Fixture level: compact
Upstream suggested level: absent (issue-scribe filed; one official case + comment updates, no runtime behavior)
Blast radius: none at runtime (comments only in server/src); a wrong case would be flaky on the stop timing — the assertions are outcome-shaped (stopped, no grace, persisted) and the ordering is a recorded reading, not a pinned literal
Selected risk packs: Concurrency / shared state / ordering (receipt vs agent_start vs abort ordering is the subject; the stop lands as early as the HTTP surface allows); Release / packaging (new official file → three hard-coded CI lists); Documentation / migration notes (five comment sites re-versioned from the measurement; ADR-0012 part four gains the re-verify pointer)
Evidence floor: WORKBUDDY_OMP_TEST=1 OMP_BIN=$PWD/var/omp/omp npx vitest run --root server --no-file-parallelism test/omp-official- (12 files green; new file ×3 with the [stop-early] ordering readings recorded in the PR); npm test --workspace server (default: new file skipped); typecheck; make check; make test-guardrails; git diff -- server/src is comments only (verified by reading the diff)
```
