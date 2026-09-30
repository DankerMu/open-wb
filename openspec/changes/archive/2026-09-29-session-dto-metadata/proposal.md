# Proposal: session-dto-metadata（#517）

## Why
父 change `s1c-session-metadata-presentation` tasks 5.1（epic #509，design D11「跨端落刀次序、既有夹具迁移同刀例外」、D2「web API 客户端」段）。1.1（#510，迁移 035）已加 `chat_sessions.workspace_id/scene/pinned_at`、`chat_messages.thinking`、`chat_steps.changes` 五列但未投影；后续 4.1/4.2/4.3/4.4、3.3/3.4 与 7.x 都以跨端 DTO 已含这些键为前提。web `hasExactlyKeys` 严格键集使 server 投影与 web 解析任一侧先合入都会让会话页整体失效，故同刀（Width exception：multi-path）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded
Blast radius: 公共 REST 快照形状（列表、创建、快照、fork 201）与 web 严格解析同刀；任一键错位即整页「无效响应」；既有 server/web 测试夹具大面积补键。
Selected risk packs: Public API / CLI / script entry（REST DTO 与 `ApiClient` 方法签名）；Schema / columns / units / field names（五列 → 键名、null 语义、`pinnedAt` 毫秒、`workspaceId` 32 hex）；Legacy compatibility / examples（五键旧形状拒绝、`createSession` 调用形状迁移、既有夹具只经共享常量补键）；Error handling / rollback / partial outputs（malformed success 整体拒绝不部分采用、204/200 分支、空 patch `TypeError`）
Evidence floor: design「Required evidence」全部命中；server 新建 `server/test/session-snapshot-metadata.test.ts`，web 新建 `web/test/session-contract-metadata.test.ts`、`web/test/api-sessions-metadata.test.ts`；既有测试仅限 design「共享夹具常量（同刀迁移例外）」的 (a)–(c) 三种改动；`make typecheck`、`make test`（server + web）、`make lint`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- server `store.ts`：`SESSION_COLUMNS` 增 `workspace_id, scene, pinned_at`，`SessionView`/`toSessionView` 八键；`StepView`/`MessageView` 类型增 `changes`/`thinking`。
- server `store-branch.ts`（A 拆出的消息/步骤投影所在）：`MESSAGE_COLUMNS` 增 `thinking`、`STEP_COLUMNS` 增 `changes`；`toMessageView` 投影 `thinking`（列 NULL → null）、`toStepView` 投影 `changes`（列 NULL → null，非 NULL → `JSON.parse` 的数组）。
- server `rest.ts`：`PublicSession`/`PublicMessage`/`PublicStep` 与 `toPublicSession`/`toPublicHistory` 逐键扩展（列表、创建、快照、fork 201 同一 `toPublicSession`）。
- web `session-contract.ts`：`ChatSession` 八键、`ChatMessage.thinking`、`ChatStep.changes` 类型与严格解析。
- web `api.ts`：`ApiClient` 类型 `createSession(input?, options?)`、`patchSession`、`deleteSession` 声明（只加类型接线）；web `api-sessions.ts`：三方法实现；`web/src/features/chat/page.tsx:466` 调用改 `createSession(undefined, { signal })`。
- 共享夹具常量：新建 `server/test/session-meta-fixtures.ts`、`web/test/session-meta-fixtures.ts`；既有测试仅限 design (a)–(c) 三种改动（单行展开补键、键数组原地换新键集、`createSession` 调用形状；`session-rest.test.ts:58-64` 五键 `toEqual` 迁出至新文件改八键）。

## Capabilities
- MODIFIED `chat-sessions`「会话 REST」：以主 spec 为底，只并入父 delta 中 5.1 的部分——POST 无 body 的八键 201（null 三键）、GET messages 的 `thinking`/`changes` 形状与两句存在性规则、会话视图八键（列表、创建、快照、fork 201）、fork 201「eight-key public view」与 Scenario「Create list and empty history」「Stable public history and recent order」「Fork at a user message」的形状部分。父 delta 同 Requirement 的 POST body 绑定（4.1）、PATCH/DELETE 路由与十路由计数（4.2/4.3）、`GET /api/commands`/`agentDir`/命令 400/`draft` 取所存正文（组 10）、fork 先建行与继承与 cwd（4.4/2.2）、Scenario「Fork inherits workspace and scene but not pin」（4.4）留给各自切片；父 delta 的「status unions SHALL include `stopped`」句为 A 的既有行为、不在本刀；父 delta 对 `approvalId` 两段式拒绝句的删改是父相对 main 的漂移，本刀保留 main 原文。
- MODIFIED `chat-web`「API 客户端扩展」：并入 `patchSession`/`deleteSession`/`createSession(input?, options?)` 合同、八键会话/消息 `thinking`/步骤 `changes` 严格键集与同刀句（去掉 `thinking.delta`/`files.changed` 事件——7.4/7.5a）、错误信封括注、Scenario「会话元数据方法请求与响应」「八键会话与思考、变更字段严格解析」；不含 `listWorkspaces` 复用句（7.x）与 `listCommands` 合同及 Scenario「命令目录方法」（组 10）。MODIFIED「步骤 args 与输出分栏」：父 delta 全文（`changes` 键、`step.end` 不含 `changes`、Scenario「步骤变更字段贯穿」），唯独去掉该 Scenario 中「变更只出现在文件变更卡」一小句（文件变更卡归 7.5a）；「API 客户端扩展」中 `deleteSession` 括注去掉「服务端对 running 会话先停止再删除」（服务端删除行为归 4.3），保留「客户端不另行等待或轮询」。
- ADDED `session-sidebar`（新能力）「会话 DTO 八键严格解析」：父 delta 全文（含 Purpose）。其余 session-sidebar Requirement 归 7.1–7.3。
- 不建：session-metadata「fork 继承会话元数据」（4.4，形状部分已由 chat-sessions fork 201 八键覆盖）；thinking-fold「无 reasoning 的模型」（3.3，快照部分已由 chat-sessions `thinking` 规则覆盖）。

## Impact
- server：`store.ts`、`store-branch.ts`、`rest.ts` 与测试；web：`session-contract.ts`、`api.ts`（类型）、`api-sessions.ts`、`page.tsx`（一处调用）与测试。真正的跨端一致性由 CI `smoke`/`ui-walk`（真实 server + web）兜底，两侧单测各用手写夹具。与 issue PR Boundary 的偏差：issue 只列 `store.ts`，但消息/步骤投影已被 A 搬到 `store-branch.ts`、公开形状在 `rest.ts` 显式逐键映射、`ApiClient` 类型在 `api.ts`——四处都是同一 DTO 的必经点，缺一则键不出现或不 typecheck。
- web `features/chat/stream.ts`（773 行）视图模型不变：快照→视图映射逐字段拷贝，新键不进入视图；`thinking`/`changes` 进入视图归 7.4/7.5a。

## Non-goals
- POST body 解析/绑定/审计（4.1）、PATCH 路由（4.2）、DELETE 路由（4.3b/c）——本刀只有投影与 web 客户端方法；`thinking`/`changes` 写入（3.3/3.4）；fork 继承取值（4.4）；web 事件解码与呈现（7.x）；`changes` 元素的服务端校验（写入端 3.4 负责）。
