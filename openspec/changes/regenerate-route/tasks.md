# Tasks: regenerate-route（#467）

## 5. chat-sessions — REST 与跨端快照（父 tasks 5.1b 原文）

- [ ] 5.1b `POST /api/sessions/:id/regenerate`（202 `{assistantMessageId}`；running 或控制占用中 409 `session_busy`；形态不符 400；对齐失败 502；容量 503；content-parser 归属同 5.1a）；prompt 路由在 `acceptPrompt` 之前同步检查控制占用（无 await）→ 409 `session_busy`，不加行、不派发（chat-sessions Scenario「Accepted prompt and concurrent busy」）。验证：新建 inject 测试文件覆盖全部状态码与 malformed JSON → 400；regenerate 持有控制占用期间 prompt → 409 `session_busy`、消息行数不变、无派发；真实 socket（`withListeningApp`, `server/test/raw-http-helpers.ts`）下 bodyless parser-owner 用例（运行中/已完成会话上任何 parsed body 含 `{}`、空或 malformed JSON、不支持的媒体类型、超出最小合法 body 上限 → 400 `bad_request` 且带 no-store，早于任何 supervisor 调用、`branch` 帧与写库；未认证 401、外部/未知会话同一 404，均早于 parser；同请求无 body 保持原行为）
  - 本 fixture 的裁定（见 proposal「偏离与决定」）：
    - 受理前检查落在 `rest.ts`，位于 `parsePromptMessage` 与 `acceptPrompt` 之间（偏离 1）；
    - 「不加行」以 `chat_messages` 的 `sqlite_sequence` 不前进、`acceptPrompt` 0 次调用来证明；
    - regenerate 路由不做路由层状态预检（偏离 8）。
  - 验证：design A1–A5、P1–P3、P5、W1、W2。
- [ ] （本 fixture 追加，见 proposal 偏离 3/6）并入的 Scenario 在 REST 面的证据：
  - 真实 fake：「正常重新生成」/「Regenerate replaces…」、「已回收会话…」与 Supervisor dispatch「Regenerate on a reclaimed session」、「运行中与形态不满足」/「分支文本不一致」、「最终事务复核失败」、「regenerate 各 RPC 间隙的并发请求」（prompt 与 regenerate 注入）、「池满」。
  - 守卫：「REST prompt 受理与补偿」父文增量（stopped 可发、503、补偿失败不伪装为 503）。
  - 验证：design R1–R6、P4。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新公共 REST 路由与加宽的 `SessionSupervisorPort`；202 `{assistantMessageId}` 是 web `regenerateSession` 的对端契约 → A1、R1；路由模板与归属集一致 → W1（CTP 输入得 400 而非 500，`hasRoute`） |
| Auth / permissions / secrets | yes | 401/404 先于 parser 与任何 supervisor 调用；他人与未知会话的 404 逐字节相同；`regenerate` 以 principal id 调用，owner-scoped 预检 → A3、A4、W2、A1（spy 参数） |
| Schema / columns / units / field names | yes | 202 键集恰为 `assistantMessageId`，supervisor 的多余键不外泄；信封 code 逐字 → A1、A2 |
| Resource limits / large input / discovery | yes | bodyless `bodyLimit` 1 与 1.1 MB 超限输入 → 400；池满 503 → A5、W1、R6、A2 |
| Error handling / rollback / partial outputs | yes | 失败映射 409/400/404/502/503 与 generic 500，不回显、无 unhandledRejection；失败时行不变（CAS 复核、mismatch）；prompt 补偿失败不伪装为 503 → A2、R3、R4、P4 |
| Concurrency / shared state / ordering | yes | 占用检查与受理处在同一同步段（微任务探针），无瞬时写入、不消耗序号；四个 RPC 间隙注入 → 409；202 等 regenerate resolve → P1、P2、P5、R5、A1b |
| Legacy compatibility / examples | yes | 既有五条路由行为不变；stub 只加两个成员且 `controlHeld` 恒 false；#465/#466 的占用注入测试仍绿 → G、P3 |
| Config / project setup | no | 无新配置键；bodyless limit 是路由本地常量（只改名） |
| File IO / path safety / overwrite | no | 路由不触文件；`omp_session_file` 的切换语义属 #465，经 R1 观察 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；架构文档 API 表归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/rest.ts`。以下零 diff：`supervisor.ts`、`branching.ts`、`turn-control.ts`、`approvals.ts`、`pool.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`sessions/stream/`、`omp/`、`app.ts`、`auth/`、web、`server/test/support/fake-omp*.mjs`。
- [ ] 新测试只写进新建文件：`server/test/session-regenerate-rest.test.ts`（stub）、`server/test/session-regenerate-rest-real.test.ts`（真实 fake 与真实 socket），以及新建 helper `server/test/session-bodyless-rest-helpers.ts`（按路由参数化的 body 目录与请求 helper）。约束：
  - 每个文件 ≤800 行；
  - 只 import 既有 helper 与信封常量，不复制（jscpd ≤3%）；
  - 不 import `supervisor.ts`/`branching.ts`/`turn-control.ts`，不访问私有字段；
  - 真实世界里 `regenerate`/`acceptPrompt` 只做 call-through spy。
- [ ] 既有测试允许的改动只有一处：`server/test/session-rest-helpers.ts` 的 `createSupervisor()` 加 `regenerate`（调用即以 `Error("unexpected regenerate call")` 拒绝）与 `controlHeld`（返回 `false`）两个成员，这是类型强制的（proposal 偏离 2）。其它既有测试与 helper 零 diff 全绿，包括 `session-stop-rest.test.ts`。
- [ ] 红/绿：先只加 `session-rest-helpers.ts` 的两个 stub 成员（否则 `vi.spyOn(supervisor, "controlHeld" | "regenerate")` 因成员不存在而抛错），再以 master 源码跑 A1–A5、P1、P2、P5、R1–R6、W1–W2，确认为红，且红因与 design「红/绿」所述一致；然后实现，跑绿。P3、P4、G 恒绿。design 变异表逐一临时施加，确认对应用例变红（其中「插入 await」由 P5 抓），失败输出记入 PR body。
- [ ] 真实 socket 用例的行、帧与 spy 断言全部在 `withListeningApp` 回调内、`app.close()` 之前完成；不经 socket 发送 1.1 MB body。
- [ ] 实测 `wc -l server/src/sessions/rest.ts` 与各新测试文件，记入 PR body。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate regenerate-route --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：
  - 父 turn-control「重新生成 REST」与 chat-sessions「REST prompt 受理与补偿」本刀整块交付，父块须与推进后的主 spec 逐字一致；
  - 父 http-service-skeleton bodyless Scenario 的 THEN 采纳偏离 4 的措辞；
  - 父「会话级控制占用」「会话 REST」「统一错误信封」「Supervisor dispatch and generation binding」保留完整目标文本，仍为 MODIFIED：fork 片段、「照常 201」、eight routes、「(Requirement「会话 REST」)」引注由 #469 补回，`stopped` 联合句归 #476/#486；
  - 勾选父 tasks 5.1b。
