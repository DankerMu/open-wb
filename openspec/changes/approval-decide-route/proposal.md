# Proposal: approval-decide-route（#468）

## Why
父 change `s1c-turn-control-governance` tasks 5.2a（epic #448，issue #468）。

`supervisor.decide(sessionId, approvalId, decision)` 已由 #464 交付（`server/src/sessions/supervisor.ts:192-195` → `approvals.ts:110-124`），`POST /api/sessions/:id/approvals/:approvalId` 也已在 #450 进入 content-parser 归属集（`server/src/http/errors.ts:57`），但 `rest.ts` 没有这条路由。今天审批只能等 60s 超时结算：该路径 POST 落进 `/api/*` catch-all，返回 404。本刀加上这条路由：它是 web 审批条（#480）与 smoke 作答（8.1a）的对端合同。严格的 body、`approvalId` 归属 404 和 200 对象形状，都由 web 严格解析来消费。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：公共 REST 路由、content-parser 归属集、跨端严格解析的 200 对象形状)
Blast radius: body 校验放宽 → 客户端可铸造 `timeout` 或多余键进入 CAS；路由模板与归属集不一致 → parser 错误变 generic 500；404 形态不一致 → 泄露 approvalId 或他人会话存在性；409 码错 → web 按 code 分支失效（#472 已按 code 区分）；关停后作答 → 在已撤销登记的 store 上写入决定与审计却不发帧
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Auth / permissions / secrets；Resource limits / large input / discovery；Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-approval-rest.test.ts`（inject 与 `withListeningApp` 真实 socket 用例同一 vitest 文件，≤800 行）；design「Required evidence」E1–E17 全绿，标注先红者在 master 上为红；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `server/src/sessions/rest.ts`：新增 `POST /api/sessions/:id/approvals/:approvalId`：
  - route-owned no-store；
  - 专用 `preParsing` 做会话 owner 校验和 canonical `approvalId` 解析，两者都在 body 解析前完成；
  - 手写 exact body validator（plain-object 检查抽成 `requirePlainRecord`，与 `parsePromptMessage` 共用，行为不变）；
  - handler 在请求时调用 `dependencies.supervisor.decide(...)`，200 body 显式投影六键；
  - `SessionSupervisorPort` 加 `decide`。
- `server/src/sessions/supervisor.ts`：`decide()` 加与 `prompt()`（`:133-136`）同形的 `#closed` 守卫，拒绝码为 `agent_unavailable`（偏离 1）。
- `server/test/session-rest-helpers.ts`：stub supervisor 补一个 `decide` 成员（偏离 3，类型强制）。
- 测试：新建 `server/test/session-approval-rest.test.ts`。

## Capabilities
- MODIFIED tool-approval「审批作答 REST」：以主 spec 为底，并入父 delta 的路由/body/鉴权/200/no-store 句与四个 Scenario 的 HTTP 原文；`approvalId` 行归属时机按偏离 2 改写；自写关停句与 Scenario「关停后作答」（偏离 1）。
- MODIFIED chat-sessions「会话 REST」：以主 spec 为底，路由清单加 approvals，并入父 approvals 段（逐字）；Scenario「Owner and authentication isolation」只加 approvals；Scenario「Approval answer, snapshot and settled conflict」只收作答面（快照 → #476）。
- MODIFIED http-service-skeleton「统一错误信封」：主 spec 原文 + Scenario「回合控制 parser owner 的真实 HTTP 边界」的 approvals 部分（fork 与 bodyless → #469/#475/#467）。

## Impact
- 行数：`rest.ts` 217 → 约 290；`supervisor.ts` 746 → 749（硬上限 760，#464 约定）。
- 零 diff：
  - `approvals.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`stream/sse.ts`、`omp/`、web、fake-omp；
  - 除 `session-rest-helpers.ts` 那一处成员外的全部既有测试与 helper。
- 生产 argv 仍为 `yolo`，审批在生产上不可达（#481 之前），所以路由上线后只在测试侧的 `--approval-mode write` 下有 200/409。

## 偏离与决定
1. **越出 PR Boundary 改 `supervisor.ts` 三行**（carry-forward #597：「REST decide should reject after supervisor shutdown」）。
   - 现状：`shutdown()`（`supervisor.ts:197-199`）先置 `#closed`、`#approvals.close()` 清空登记，再 await retire。之后才由 `index.ts` 的 `closeSessions` 关 store。
   - 窗口：Fastify 在 `close()` 后对新请求直接回 503，但 route 入口早于 close、body 晚到的在途请求会在这个窗口里进入 handler。此时 `decide` → `settleApproval` 在仍开着的 store 上 CAS 命中，写入决定与审计，却因登记已清空而不发帧、不发布，返回 200。窗口更晚（store 已关）时则抛普通 `Error("session store is closed")`，被映射成 generic 500。
   - `rest.ts` 经 `SessionSupervisorPort` 看不到关停态。要在路由侧映射，只能按非 `HttpError` 的消息嗅探，而那会把 #464 R16 那类结算事务失败也伪装成 502。所以应改在 supervisor：`decide` 在 `#closed` 时 `Promise.reject(new HttpError("agent_unavailable"))`，与 `prompt()` 同码同形，不新增错误码。
   - #474 之后关停会先把 pending 审批 deny 结算。即便如此，这个守卫仍是「关停后不写库」的唯一保证，E14 按「关停后读到的行值不变」断言，不依赖 #474 之前或之后的具体值。
2. **`approvalId` 行归属不在 body 解析前判定**（父 tool-approval 句「……均在 body 解析前」的部分未交付）。
   - `SessionStore`（`store.ts:123-148`）在本刀没有审批读取面。唯一的归属判定是 `settleApproval` 事务内的 `not_found`（`store-approvals.ts:94`），而 store 不在边界内。
   - 本刀的顺序：body 解析前做未认证 401、会话 404 与非 canonical `approvalId` 404；body 通过后由 `decide` 判行归属，时机先于任何写入与发帧。
   - 不构成存在性探测面：body 畸形时，无论 `approvalId` 是否存在都返回同一个 400；body 合法时，未知与外会话 `approvalId` 返回的 404 与未知会话逐字节相同（E10）。E10b 对存在、未知、外会话三种 id 各发 CTP 畸形与 validator 畸形 body，断言六个 400 两两逐字节相同且不调 `decide`。
   - 归档：父块采用本 delta 措辞；若 #476 把 `approvals` 放上 `getMessages` 树，可再把检查前移并恢复父文。
3. **`server/test/session-rest-helpers.ts` 一处必要改动**。`RecordingSupervisor extends SessionSupervisorPort`（`:27`），`server/tsconfig.json` 的 include 含 `test`，端口加 `decide` 后 `createSupervisor()`（`:80-101`）不再满足类型。允许改动：只加一个 `decide` 成员，调用即以 `Error("unexpected decide call")` 拒绝，其余不动。#475/#467/#469 各自加端口方法时会遇到同样的一处改动。
4. **不设路由级 `bodyLimit`**：沿用全局 1 MiB（与 prompt 路由一致），超限用例用 `PARSER_INPUTS` 的 1.1 MB 输入（`http-guard-helpers.ts:66-79`）。
5. **canonical `approvalId`** = 匹配 `/^[1-9][0-9]*$/` 且 `Number.isSafeInteger`；不满足即在 preParsing 抛 `HttpError("not_found")`，与未知会话同一信封。

## Open questions（上报编排者）
- 归档 #468 时，父 tool-approval「审批作答 REST」要吸收偏离 1 的关停句与 Scenario「关停后作答」，并把偏离 2 的措辞写进父块（否则 #473/#474 从父 delta 逐字推进时会重新引入「均在 body 解析前」）。
- `s1c-session-metadata-presentation`（change B）的 chat-sessions「会话 REST」与 http-service-skeleton「统一错误信封」以 change A 的父文整段重述。这是既有的 A/B 次序约束，与本刀无新冲突。
- #475/#467/#469 同样 MODIFIED「会话 REST」与「统一错误信封」，后归档者须以推进后的主 spec 为底。

## Non-goals
- `decide` 的 CAS、审计、发帧、发布语义（4.3 #464 已交付，本刀只经 REST 观察）。
- 快照 `approvals` 投影与 web 解析（5.3 #476）；web 审批条（7.4 #480）；smoke 作答（8.1a）；argv `write`（#481）。
- stop/regenerate/fork 路由（#475/#467/#469）；错误码与归属集定义（#450 已交付）。
- 崩溃、停止、对账对 pending 审批的 deny 结算（#473/#474）。
