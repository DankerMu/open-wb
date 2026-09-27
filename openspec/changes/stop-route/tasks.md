# Tasks: stop-route（#475）

## 5. chat-sessions — REST 与跨端快照（父 tasks 5.1a 原文）

- [ ] 5.1a `server/src/sessions/rest.ts` `POST /api/sessions/:id/stop`（running → 202 body `{}`；非 running → 204 无 body；非 owner 404；content-parser 归属：任何 parsed body/malformed JSON → 400 `bad_request`）。验证：新建 inject 测试文件覆盖全部状态码与 no-store；真实 socket（`withListeningApp`, `server/test/raw-http-helpers.ts`）下 bodyless parser-owner 用例（运行中/已完成会话上任何 parsed body 含 `{}`、空或 malformed JSON、不支持的媒体类型、超出最小合法 body 上限 → 400 `bad_request` 且带 no-store，早于任何 supervisor 调用、`abort` 帧与写库；未认证 401、外部/未知会话同一 404，均早于 parser；同请求无 body 保持 202/204）；「派发前 stop 后获取失败」用例（真实 supervisor + fake-omp `no-ready-hang` 装配，不用 stub supervisor：prompt 在途、runtime 仍在获取时 stop → 202，随后获取失败 → 受理对经 `rollbackPrompt` 删除、prompt 请求返回既有错误响应、无 `turn.end`）
  - 本 fixture 的裁定（见 proposal「偏离与决定」）：202/204 以 owner-scoped 视图 `status` 判定，在 handler 内与 `stop()` 同一同步段重读（偏离 1）；`bodyLimit` 为本地常量 1（偏离 4）；真实 socket 上的「超限」输入用 `{}`（偏离 5）。验证：design A1–A6、R4、W1、W2
- [ ] （本 fixture 追加，见 proposal 偏离 2）并入的 Scenario 在 REST 面的真实 fake 证据：「运行中停止」/「Stop is accepted…」（`abort-ok`）、「同一回合二次停止」（`abort-ignored`）、「派发前停止」/「abort 返回 false 走停止意图」（`slow-ready`）。验证：design R1–R3

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新公共 REST 路由与 `SessionSupervisorPort.stop`；202 `{}`/204 形状是 web `stopSession` 的对端契约 → A1、A2、R1；路由模板与归属集一致 → W1（CTP 输入 400 而非 500，`hasRoute`） |
| Auth / permissions / secrets | yes | 401/404 先于 parser 与任何 supervisor 调用；他人与未知会话 404 逐字节相同；stop 以 `row.owner_id` 写 `session.approval` 审计，所以 owner 校验不可省 → A3、A4、W2 |
| Schema / columns / units / field names | yes | 202 body 恰 `{}`（`isStopAccepted` 严格键集），204 无 body，信封 code 逐字 → A1、A2、A6、R1 |
| Resource limits / large input / discovery | yes | `bodyLimit` 1：`{}` 超限，1.1 MB 超限 → 400；未认证/非 owner 时为 401/404 → A3–A5、W1 |
| Error handling / rollback / partial outputs | yes | stop 的同步抛出、非 `HttpError` 拒绝 → generic 500，关停后 → 502，都带 no-store、无 unhandledRejection；获取失败时受理对补偿、prompt 返回既有 502、无 `turn.end` → A6、R4 |
| Concurrency / shared state / ordering | yes | 状态判定与 `stop()` 同一同步段；202 只在 stop resolve 之后发出且不等回合结束；派发前窗口的 stop 先于获取失败落地；二次 stop 只一帧 `abort` → A1b、R2、R3、R4 |
| Legacy compatibility / examples | yes | 既有五条会话路由与 SSE 的 `requireOwnedSession` 行为不变；stub supervisor 只加一个成员 → G |
| Config / project setup | no | 无新配置键；`bodyLimit` 为路由本地常量 |
| File IO / path safety / overwrite | no | 不涉文件（probe 写入是 fake 既有能力） |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；架构文档 API 表归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/rest.ts`。`supervisor.ts`、`turn-control.ts`、`approvals.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`sessions/stream/sse.ts`、`omp/`、`app.ts`、`auth/`、web、`server/test/support/fake-omp*.mjs` 零 diff。
- [ ] 新测试只写进新建的 `server/test/session-stop-rest.test.ts`：inject 与 `withListeningApp` 真实 socket 同一 vitest 文件，≤800 行；超出时拆到另一个新建文件，不改既有 helper。只 import 既有 helper 与信封常量，不复制（jscpd ≤3%）；不 import `supervisor.ts`/`turn-control.ts`，不访问私有字段；`stop` 只用 spy 观察（stub 可 mock，真实世界只做 call-through）。
- [ ] 既有测试允许的改动：只有 `server/test/session-rest-helpers.ts` 的 `createSupervisor()` 加一个 `stop` 成员（调用即以 `Error("unexpected stop call")` 拒绝），这是类型强制的（proposal 偏离 3）。其它既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：A1–A6、R1–R4、W1–W2 先对 master 跑红，再实现跑绿。design 变异表逐一临时施加，确认对应用例变红，失败输出记入 PR body。G 恒绿。
- [ ] 真实 socket 用例的行、帧与 spy 断言全部在 `withListeningApp` 回调内、`app.close()` 之前完成；不经 socket 发送 1.1 MB body。R4 若追加任何再派发，先 `handshakeBound(world, undefined)` 并 `setScenario`。
- [ ] 实测 `wc -l server/src/sessions/rest.ts` 与新测试文件，记入 PR body。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate stop-route --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions。
- [ ] 归档 PR：父 turn-control「停止生成 REST」、chat-sessions「会话 REST」、http-service-skeleton「统一错误信封」保留完整目标文本（regenerate/fork、控制占用、审批 WHEN 仍由 #467/#469/#465/#474 交付，仍为 MODIFIED）；对父块跑 bdiff，确认本刀推进的措辞与父文一致（chat-sessions stop 段与 bodyless 句为单数改写，父块保持 stop+regenerate 合写原文）。
