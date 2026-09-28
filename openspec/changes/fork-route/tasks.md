# Tasks: fork-route（#469）

## 5. chat-sessions — REST 与跨端快照（父 tasks 5.2b 原文）

- [ ] 5.2b `POST /api/sessions/:id/fork`（body 恰 `{messageId:number}`；201 `{session, draft}`；非用户消息/外部消息 400；running 或控制占用中 409；502/503；malformed 400）。验证：新建 inject 测试文件覆盖状态码与 `session.status` 取值；真实 socket（`withListeningApp`, `server/test/raw-http-helpers.ts`）下 parser-owner 用例（真实 owner cookie 下 malformed/空/不支持的媒体类型/超限 body → 400 `bad_request` 且带 no-store，早于任何 supervisor 调用、omp 帧与写库；未认证 401、外部/未知会话同一 404，均早于 parser）
  - 本 fixture 的裁定（见 proposal「偏离与决定」）：
    - `messageId` 在路由层按正安全整数校验，归属与角色仍由 supervisor 预检判定，路由不做状态预检（决定 1）；
    - 路由本地 `bodyLimit` 1 KiB，使真实 socket 的超限用例确定可复现（决定 2）；
    - 端口 `fork` 以 `Awaited<ReturnType<SessionSupervisor["fork"]>>` 类型化，`rest.ts` 不 import `./branching.js`（决定 3）。
  - 验证：design A1–A6、R3（状态码）、W1、W2。
- [ ] （本 fixture 追加，见 proposal 决定 4/5/6/8）并入的 Scenario 在 REST 面的证据：
  - 真实 fake：「正常分叉」/「Fork copies history…」/「Fork temporary runtime is not a generation」、「新会话状态随拷贝历史」、「非法目标与运行中」、「对齐失败回滚」、「源会话存活进程先退出」/omp-pool「fork 先退回源会话进程」、「池满与临时进程释放」、「fork 各 RPC 间隙的并发请求」（五个间隙注入 REST prompt/regenerate/fork，原 fork 照常 201）。
  - 守卫：会话视图不暴露 `parent_session_id`/`omp_session_file`（201、列表、快照）。
  - 验证：design R1–R6。

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新公共 REST 路由与加宽的 `SessionSupervisorPort`；201 `{session,draft}` 是 web `forkSession` 的对端契约 → A1、R1；路由模板与归属集一致 → W1（CTP 输入得 400 而非 500，`hasRoute`） |
| Auth / permissions / secrets | yes | 401/404 先于 parser 与任何 supervisor 调用；他人与未知会话的 404 逐字节相同；`fork` 以 principal id 调用，owner-scoped 预检 → A3、A4、W2、A1（spy 参数） |
| Schema / columns / units / field names | yes | 201 键集恰为 `session,draft`，`session` 恰五键，不暴露 `parent_session_id`/`omp_session_file`；`session.status` 取 idle/done/failed/stopped → A1、R1、R2 |
| Resource limits / large input / discovery | yes | 1 KiB `bodyLimit`（空白填充的合法 body 与 1.1 MB 输入均 400）；池满 503、临时进程计入上限并在 201 前释放 → A5、W1、R4、R6 |
| Error handling / rollback / partial outputs | yes | 失败映射 409/400/404/502/503 与 generic 500，不回显、无 unhandledRejection；对齐失败与预检失败不留新会话行 → A2、R3、R6 |
| Concurrency / shared state / ordering | yes | fork 持有源会话占用的五个间隙内，REST prompt/regenerate/fork 受理前 409（`acceptPrompt` 0 次、序号不前进），原 fork 照常 201；201 等 fork resolve → R5、A1b |
| Legacy compatibility / examples | yes | 既有六条路由行为不变；stub 只加一个 `fork` 成员；#466 的 supervisor 层测试零 diff 全绿 → G |
| Config / project setup | no | 无新配置键；`FORK_BODY_LIMIT` 是路由本地常量 |
| File IO / path safety / overwrite | no | 路由不触文件；源会话文件不被改写属 #466，经 R1/R5 的 `unchanged()` 观察 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；架构文档 API 表归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/rest.ts`。以下零 diff：`supervisor.ts`、`branching.ts`、`turn-control.ts`、`approvals.ts`、`pool.ts`、`store*.ts`、`http/errors.ts`、`core/`、`sessions/index.ts`、`sessions/stream/`、`omp/`、`app.ts`、`auth/`、web、`server/test/support/fake-omp*.mjs`。
- [ ] 新测试只写进新建文件：`server/test/session-fork-rest.test.ts`（stub）与 `server/test/session-fork-rest-real.test.ts`（真实 fake、受控 FakeChild 与真实 socket）。约束：
  - 每个文件 ≤800 行；
  - 只 import 既有 helper 与信封常量，不复制（jscpd ≤3%）；
  - 不值导入 `supervisor.ts`/`branching.ts`/`turn-control.ts`，不访问私有字段；
  - 真实世界里 `fork`/`acceptPrompt` 只做 call-through spy；
  - 本地 helper 不得与 `session-fork-helpers.ts` 的导出同名（`forkAt`/`expectForkDone`/`expectSourceClaimed`/`heldRegenerate`）。
- [ ] 既有测试允许的改动只有一处：`server/test/session-rest-helpers.ts` 的 `createSupervisor()` 加 `fork` 成员（调用即以 `Error("unexpected fork call")` 拒绝），这是类型强制的（proposal 决定 7）。其它既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：先只加 `session-rest-helpers.ts` 的 `fork` stub 成员（否则 `vi.spyOn(supervisor, "fork")` 因成员不存在而抛错），再以 master 源码跑 A1–A6、R1–R6、W1–W2，确认为红，且红因与 design「红/绿」所述一致；然后实现，跑绿。G 恒绿。design 变异表逐一临时施加，确认对应用例变红，失败输出记入 PR body。
- [ ] 真实 socket 用例的行、帧与 spy 断言全部在 `withListeningApp` 回调内、`app.close()` 之前完成；不经 socket 发送 1.1 MB body（超限一支用约 1.1 KB 的空白填充 body）。
- [ ] 实测 `wc -l server/src/sessions/rest.ts` 与各新测试文件，记入 PR body。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate fork-route --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：
  - 父 turn-control「从此处分叉 REST」「会话级控制占用」、http-service-skeleton「统一错误信封」、omp-pool「串行化准入与最久空闲驱逐」本刀整块交付，父块须与推进后的主 spec 逐字一致；
  - 父 chat-sessions「会话 REST」「Supervisor dispatch and generation binding」保留完整目标文本，仍为 MODIFIED：剩余差异只有 `stopped` 联合句（→ #486）与 Scenario 的 `**WHEN**` 加粗格式；
  - 勾选父 tasks 5.2b。
