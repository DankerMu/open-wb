# Proposal: fork-route（#469）

## Why
父 change `s1c-turn-control-governance` tasks 5.2b（epic #448，issue #469）。

已就位的部分：
- `supervisor.fork(sessionId, ownerId, messageId): Promise<ForkResult>` 由 #466 交付（`server/src/sessions/supervisor.ts:185-187` → `branching.ts:198-205`），`ForkResult` 从 `branching.ts:182` 导出；
- `POST /api/sessions/:id/fork` 由 #450 列入 content-parser 归属集（`server/src/http/errors.ts:56`）；
- REST prompt 的受理前占用拒绝由 #467 交付，且对 fork 已生效：`rest.ts:165` 调 `controlHeld` → `ControlClaims.held`（`turn-control.ts:168`），而 `Forks.run` 在首个 await 之前就经 `controls.during(sourceId)` 登记了源会话占用（`branching.ts:200-204`，`#fork` 的首个 await 在 `:246`；`#control` 同步调用 `run()`，`supervisor.ts:328-336`）；
- web 的 `forkSession` 已按「`application/json` 的 `{messageId}` → 201 `{session, draft}`」严格解析（`web/src/lib/api-sessions.ts:167-185`，`web/src/lib/session-contract.ts:245-252`；`session` 走 `parseSession` 的恰五键、32 位小写 hex id、含 `stopped` 的状态联合，`:98-116`）。

缺的部分：`rest.ts` 没有这条路由，该路径落进 `/api/*` catch-all，返回不带 no-store 的 404；`SessionSupervisorPort`（`rest.ts:15-22`）也没有 `fork`。本刀补上路由。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：公共 REST 路由、content-parser 归属集与 web 严格解析的 201 形状是 public API / parser 硬触发项)
Blast radius: 路由模板与归属集不一致 → parser 错误成 generic 500；owner 校验晚于 parser/supervisor → 泄露他人会话存在性；body 放宽 → 垃圾 id 进 supervisor 预检或多余键被接受；201 body 键集不是恰 `{session,draft}`、`session` 不是恰五键（如透传 `parent_session_id`）→ web `forkSession` 抛错；bodyLimit 过大 → 真实 socket 超限用例在负载下 ECONNRESET（carry-forward :62）
Selected risk packs: Public API / CLI / script entry；Auth / permissions / secrets；Schema / columns / units / field names；Resource limits / large input / discovery；Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-fork-rest.test.ts`（stub 矩阵）与 `server/test/session-fork-rest-real.test.ts`（真实 fake-omp、受控 FakeChild 与真实 socket）；design「Required evidence」A1–A6、R1–R6、W1–W2 全绿，红/绿按 design 标注；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `server/src/sessions/rest.ts`（346 行 → 约 380 行）：
  - `SessionSupervisorPort`（`:15-22`）加 `fork(sessionId: string, ownerId: string, messageId: number): Promise<ForkResult>`，`type ForkResult = Awaited<ReturnType<SessionSupervisor["fork"]>>`，`SessionSupervisor` 走已有的 `./supervisor.js` 类型导入（`:13`），不新增 import 边（决定 3）；
  - 新增路由本地常量 `FORK_BODY_LIMIT = 1_024`（决定 2）；
  - 新增 `parseForkMessageId(body)`：`requirePlainRecord`（`:307-317`）+ 键集恰为 `messageId` + `Number.isSafeInteger(v) && v > 0`，否则 `HttpError("bad_request")`（决定 1）；
  - 新增 `POST /api/sessions/:id/fork`：`bodyLimit: FORK_BODY_LIMIT`，`onRequest: noStoreSessionResponse`，`preParsing: authorizeSessionBeforeParse`（`:127-135`）。handler 依次：解析 `messageId` → 取 `currentPrincipal` → `await supervisor.fork(id, principal.id, messageId)` → `reply.code(201).send({ session: toPublicSession(result.session), draft: result.draft })`。
- `server/test/session-rest-helpers.ts`：`createSupervisor()`（`:77-117`）加一个 `fork` 成员，调用即以 `Error("unexpected fork call")` 拒绝（类型强制，carry-forward :58/:106）。
- 测试：新建两个测试文件（见 design）。prompt 路由零改动。

## Capabilities
- turn-control：
  - MODIFIED「从此处分叉 REST」：取父 delta 全文，本刀之后整块交付；
  - MODIFIED「会话级控制占用」：取父 delta 全文，即 fork 间隙 Scenario 的「照常 201」（#467 延后），本刀之后整块交付。
- chat-sessions：
  - MODIFIED「会话 REST」：以主 spec 为底，路由清单加 fork，并入父文 fork 段（已是事务内插入措辞）、会话视图不暴露 `parent_session_id`/`omp_session_file` 的括注（决定 5）、Owner isolation 的 fork 与「eight routes」（#467 延后），新增 Scenario「Fork copies history before the chosen user message」；`stopped` 联合句 → #486；
  - MODIFIED「Supervisor dispatch and generation binding」：补回「(Requirement「会话 REST」)」引注（#467 延后）与 Scenario「Fork temporary runtime is not a generation」的 REST 面 WHEN。
- http-service-skeleton：MODIFIED「统一错误信封」，取父 delta 全文（parser-owner 真实边界的 fork WHEN 与「four routes」，#467 延后），本刀之后整块交付。
- omp-pool：MODIFIED「串行化准入与最久空闲驱逐」，取父 delta 全文（「fork 201」，#466 延后；决定 6）。
- 各块的取舍见各 spec 顶部引注。

## Impact
- 行数：`rest.ts` 约 380 行；每个新测试文件 ≤800 行。
- 零 diff：`supervisor.ts`、`branching.ts`、`turn-control.ts`、`approvals.ts`、`pool.ts`、`store*.ts`、`http/errors.ts`、`core/`、`sessions/index.ts`、`sessions/stream/`、`omp/`、`app.ts`、`auth/`、web、`server/test/support/fake-omp*.mjs`；除 `session-rest-helpers.ts` 那一个成员外的全部既有测试与 helper。
- `sessions/index.ts:51` 传入的真实 `SessionSupervisor` 已有 `fork`（`supervisor.ts:185`），满足加宽后的端口；knip：`fork` 由此有了 src 调用方，`ForkResult` 已被 `supervisor.ts:7` 引用，不新增未引用导出。
- 行为变化只有新路由一处。

## 偏离与决定
1. **`messageId` 在路由层按正安全整数校验**。父文与 issue 只写 `{messageId:number}`；spec 按规则逐字保留。理由：
   - `chat_messages.id` 是 AUTOINCREMENT 正整数，`1.5`/`0`/`-1`/`2^53`/`1e400`（→ `Infinity`）在形态上就不是消息 id，属于 body 形态，不是语义判定；
   - 结局与交给 supervisor 相同（`Forks#precheck` 找不到该 id → 400，`branching.ts:219-224`），但路由拒绝时没有 supervisor 调用、没有占用登记，stub 用例可以断言「形态不符 → 400 且 `fork` spy 0 次」；
   - 消息归属、角色、running/占用、文件 NULL 仍由 `Forks#precheck` 判定（`branching.ts:212-242`），路由不读 `runtimeState`、不做状态预检，理由同 #467 偏离 8（两份规则不同步）。
2. **路由本地 `bodyLimit` = 1 KiB，不沿用全局 1 MiB**（#468 偏离 4 的反向选择；编排者已确认）。
   - 父文只要求「超限 → 400」，不定上限值；合法 body 最长约 30 字节（`{"messageId":9007199254740991}`）。
   - 真实 socket 下 owner cookie 的超限用例是 issue 验收项。沿用 1 MiB 就得经 socket 发 1.1 MB，#468 的 E15 正是这一项在全量负载下偶发 ECONNRESET（carry-forward :62）。
   - Fastify 在 `content-length > limit` 时不读 body 直接报 `FST_ERR_CTP_BODY_TOO_LARGE`（`node_modules/fastify/lib/content-type-parser.js:244-245`）。约 1.1 KB 的超限 body 在服务端应答前已由客户端写完，socket 用例因此是确定的。
   - 可观察：一个用空白填充到 1 KiB 以上的合法 JSON（`{"messageId":<u2>}` 加 1100 个空格）→ 400；去掉该 limit 时 → 201（真实）或 500（stub 默认拒绝）。
   - 若编排者坚持 #468 的无 limit 选择：W1 的超限一支改用 `OVERSIZED_PARSER_INPUT`，并继承 E15 的偶发失败。
3. **端口类型取自 supervisor 签名，不取自 `branching.ts`**（编排者裁定，覆盖 carry-forward :106）：`type ForkResult = Awaited<ReturnType<SessionSupervisor["fork"]>>`。`rest.ts:13` 已经从 `./supervisor.js` 做类型导入，不新增 import 边，也不与主 spec chat-sessions「会话 supervisor 源码模块划分」的「`branching.ts` 的导出 SHALL 只供 `sessions/` 内的 supervisor 模块使用」冲突；`rest.ts` 不 import `./branching.js`（值或类型）。
4. **两个新测试文件，而不是 issue「Minimal mergeable slice」写的「单一测试文件」**。stub 装配（`withSessionRest`）与生产 `createApp` + 真实 fake-omp 是两套装配，合在一个文件里超过 800 行；先例是 #467。另外，真实 supervisor 用例超出 issue 所列的 inject 状态码矩阵，先例是 #467 偏离 3 与 #475 偏离 2。并入的 Scenario 写明 backed by the real fake（`branch`），或要求源进程先退出、`parent_session_id`、审批拷贝、间隙注入与「照常 201」作为证据，这些 stub 证明不了。
5. **chat-sessions「会话 REST」收下会话视图括注**「`parent_session_id` and `omp_session_file` SHALL NOT be exposed」。#467 引注把它与 `stopped` 联合句并列为「不归本刀」，但 carry-forward :78 只给 `stopped` 句指派了 #486。fork 是第一条让 `parent_session_id` 非 NULL 的 REST 路径，issue Review priority 也点名「不暴露 `parent_session_id`」。该括注在 master 上已成立（视图恰五键，`rest.ts:241-255`），由 A1/R1 断言，是守卫性质的证据。
6. **越出 issue Desired behavior 的 capability：omp-pool**。#466 归档时 omp-pool「串行化准入与最久空闲驱逐」的 Scenario「fork 先退回源会话进程」把「fork 201」改为「fork 兑现」，并注明「REST 201 → #469」（`openspec/changes/archive/2026-09-28-fork-session/specs/omp-pool/spec.md` 引注）。不收的话，该父块会成为无 owner 的孤儿片段。证据是 R4。
7. **`session-rest-helpers.ts` 加一个成员**。端口加宽后 stub 缺成员会让 `make typecheck` 失败（`server/tsconfig.json` 的 include 含 `test`）。按「意外调用即拒绝」的模式加，与 `decide`/`stop`/`regenerate`（`:103-111`）同形。这一次确实只有一个成员（carry-forward :58）。
8. **prompt 路由零改动**。受理前占用拒绝已是通用的（见 Why），本刀只补证据：REST fork 持有占用期间，REST prompt 得 409，`acceptPrompt` 0 次，`chat_messages` 序号不前进（R5）。

## Open questions（上报编排者，本刀不处理）
- carry-forward :107：`draft` 是 omp 回显的 `branched.text`（`branching.ts:323`），在 fake 下等于存储内容。真实二进制下 slash prompt 的文本不一致会让 fork 永远 502，归 #494/#495，不在本刀。
- 状态码优先级来自 `Forks#precheck` 的判定顺序（`branching.ts:216-230`）：running 源会话上用 assistant `messageId` 调用得 400，不是 409。父 Scenario「非法目标与运行中」把两者写成分开的 WHEN，不矛盾。web 7.3b 只从用户消息发起，不可达。
- chat-sessions「会话 REST」的 `stopped` 联合句仍无 owner（carry-forward :78 → #486）。
- 归档对账：父 turn-control「从此处分叉 REST」「会话级控制占用」、http-service-skeleton「统一错误信封」、omp-pool「串行化准入与最久空闲驱逐」整块交付，须与推进后的主 spec 逐字一致；父 chat-sessions「会话 REST」「Supervisor dispatch and generation binding」仍为 MODIFIED，剩余差异只有 `stopped` 联合句（→ #486）与 Scenario 的 `**WHEN**` 加粗格式。

## Non-goals
- `supervisor.fork` 的语义，即源进程 retire、临时进程、对齐、CAS、行拷贝（4.5 #466 已交付，本刀只经 REST 观察）。
- 错误码与归属集定义（1.2 #450，本刀只消费）；prompt 受理前占用检查（#467）。
- stop/regenerate/approvals 路由（#475/#467/#468）；web「从此处分叉」（7.3b）；smoke/ui-walk fork 条目（8.1d/8.2d）；架构文档 API 表（9.1 #486）；真实二进制验证（9.3）。
