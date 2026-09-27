# Tasks: approval-decide-route（#468）

## 5. chat-sessions — REST 与跨端快照（父 tasks 5.2a 原文）

- [ ] 5.2a `POST /api/sessions/:id/approvals/:approvalId`（body 恰 `{decision:"allow"|"deny"}`；200 body 为快照同形的单条 approval 对象；非 pending 409 `approval_settled`；非 owner/未知 id 404；malformed/多余键 400）。验证：新建 inject 测试文件覆盖状态码与 body 形状；真实 socket（`withListeningApp`, `server/test/raw-http-helpers.ts`）下 parser-owner 用例（真实 owner cookie 下 malformed/空/不支持的媒体类型/超限 body → 400 `bad_request` 且带 no-store，早于任何 supervisor 调用、omp 帧与写库；未认证 401、外部/未知会话同一 404，均早于 parser）
- [ ] （本 fixture 追加，见 proposal 偏离 1）`supervisor.decide` 在关停开始后以 `agent_unavailable` 拒绝（与 `prompt()` 同形的 `#closed` 守卫），REST 返回 502 + no-store，不写库不发帧。验证：design E14
- [ ] （本 fixture 追加，见 proposal 偏离 2、5）canonical `approvalId` 与会话 owner 校验在 preParsing；`approvalId` 行归属由 `decide` 的 `not_found` 判定，404 与未知会话逐字节相同。验证：design E9–E11、E10b

## Risk packs

| Pack | Selected | 理由 → 证据 |
|---|---|---|
| Public API / CLI / script entry | yes | 新公共 REST 路由；`SessionSupervisorPort.decide` → E1–E5、E12；路由模板与归属集一致 → E15（`hasRoute` + 真实 socket 400）|
| Schema / columns / units / field names | yes | 200 body 恰六键、`decision` 只取 `allow|deny`；409/404/502 的 code 逐字 → E1、E3、E6、E10、E14（`toStrictEqual`） |
| Auth / permissions / secrets | yes | 401 与会话 404 先于 parser；他人会话、外会话 `approvalId` 与未知 id 的 404 不可区分；畸形 body 的 400 不泄露 id 存在性 → E8–E11、E10b、E16 |
| Resource limits / large input / discovery | yes | 超限 body（全局 1 MiB）→ 400 或（未认证/非 owner 时）401/404 → E8、E9、E15 |
| Error handling / rollback / partial outputs | yes | 结算事务失败 → generic 500、行不变可重试；关停后 502 不写库 → E13、E14 |
| Concurrency / shared state / ordering | yes | 并发作答恰一个 200；并行两条审批独立作答 → E5、E12 |
| Legacy compatibility / examples | yes | 既有四条会话路由与 SSE 的 `requireOwnedSession` 行为不变；stub supervisor 只加一个成员 → E17 |
| Config / project setup | no | 无新配置键；不设路由级 `bodyLimit`（proposal 偏离 4） |
| File IO / path safety / overwrite | no | 不涉文件 |
| Release / packaging / dependency compatibility | no | 无依赖变化 |
| Documentation / migration notes | no | 无迁移；架构文档 API 表归 9.1 #486 |

## 通用纪律（继承父 tasks.md）

- [ ] 源码边界：只改 `server/src/sessions/rest.ts` 与 `server/src/sessions/supervisor.ts`（仅 `decide` 的 `#closed` 守卫，proposal 偏离 1）。`approvals.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`stream/sse.ts`、`omp/`、web、fake-omp 零 diff。
- [ ] 新测试只写进新建的 `server/test/session-approval-rest.test.ts`（inject 与 `withListeningApp` 真实 socket 同一 vitest 文件；≤800 行，超出再拆新文件）。不 import `approvals.ts`/`store-approvals.ts`，不访问私有字段；`PARSER_INPUTS`/信封常量 import 既有 helper，不复制。
- [ ] 既有测试允许的改动：只有 `server/test/session-rest-helpers.ts` 的 `createSupervisor()` 加一个 `decide` 成员（调用即以 `Error("unexpected decide call")` 拒绝），这是类型强制的（proposal 偏离 3）。其它既有测试与 helper 零 diff 全绿。
- [ ] 红/绿：E1–E16（含 E10b）先对 master 跑红，再实现跑绿；design「红/绿」所列变异逐一临时施加，确认对应用例变红，失败输出记入 PR body；E17 恒绿。
- [ ] 实测 `wc -l server/src/sessions/{rest,supervisor}.ts` 与新测试文件记入 PR body；`supervisor.ts` ≤760。
- [ ] `npm test --workspace server`（覆盖率 ≥80%）、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增、jscpd ≤3%）、`bash scripts/size-guard.sh` 全部退出 0；`openspec validate approval-decide-route --strict --no-interactive` 通过。
- [ ] PR body 列出 proposal「偏离与决定」各条与 Open questions。
