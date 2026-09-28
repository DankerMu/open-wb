# Proposal: regenerate-route（#467）

## Why
父 change `s1c-turn-control-governance` tasks 5.1b（epic #448，issue #467）。

已就位的部分：
- `supervisor.regenerate(sessionId, ownerId)` 与同步的 `controlHeld(sessionId)` 由 #465 交付（`server/src/sessions/supervisor.ts:180-192`）；
- `POST /api/sessions/:id/regenerate` 由 #450 列入 content-parser 归属集（`server/src/http/errors.ts:55`）；
- web 的 `regenerateSession` 已按「无 body、无 content-type 的 POST → 202 `{assistantMessageId}`」严格解析（`web/src/lib/api-sessions.ts:152-165`，`web/src/lib/session-contract.ts:237-243`）。

缺的部分：
- `rest.ts` 里没有这条路由，现在该路径落进 `/api/*` catch-all（`server/src/app.ts:172`），返回不带 no-store 的 404；
- REST prompt 在控制占用期间走的是「`acceptPrompt` → supervisor 拒绝（`supervisor.ts:302-305`）→ `rollbackPrompt`」（`rest.ts:161-168`）。结束后的行与注入前相同，但过程中有瞬时写入，并消耗 AUTOINCREMENT 序号（#465 偏离 3）。

本刀补上路由，并把占用拒绝前移到受理之前。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：公共 REST 路由、content-parser 归属集与 web 严格解析的 202 形状是 public API / parser 硬触发项；受理前拒绝涉及并发与持久化写入次序)
Blast radius: 路由模板与归属集不一致 → parser 错误成 generic 500；owner 校验晚于 parser/supervisor → 泄露他人会话存在性；body 被接受 → 多余 `branch` 帧或写库；202 body 键集不是恰 `{assistantMessageId}` → web `regenerateSession` 抛错；prompt 占用检查落在受理之后或中间有 await → 瞬时行写入/序号消耗，或占用出现在检查与受理之间；stub `controlHeld` 默认非 false → 既有 prompt 测试全体 409
Selected risk packs: Public API / CLI / script entry；Auth / permissions / secrets；Schema / columns / units / field names；Resource limits / large input / discovery；Error handling / rollback / partial outputs；Concurrency / shared state / ordering；Legacy compatibility / examples
Evidence floor: 新建 `server/test/session-regenerate-rest.test.ts`（stub 矩阵）与 `server/test/session-regenerate-rest-real.test.ts`（真实 fake-omp 与真实 socket），加一个新建 helper；design「Required evidence」A1–A5、P1–P5、R1–R6、W1–W2 全绿，红/绿按 design 标注；`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- `server/src/sessions/rest.ts`（321 行 → 约 345 行）：
  - `SessionSupervisorPort`（`:15-20`）加两个成员：`regenerate(sessionId: string, ownerId: string): Promise<{ assistantMessageId: number }>` 与 `controlHeld(sessionId: string): boolean`；
  - `STOP_BODY_LIMIT`（`:75`）改名为 bodyless 通用名，stop 与 regenerate 共用，值与注释不变；
  - 新增 `POST /api/sessions/:id/regenerate`。选项与 stop 同形：`bodyLimit` 取上述常量，`onRequest: noStoreSessionResponse`，`preParsing: authorizeSessionBeforeParse`（`:125-133`）。handler 依次执行：
    1. `request.body !== undefined` 时返回 400；
    2. 取 `currentPrincipal`；
    3. `await supervisor.regenerate(id, principal.id)`；
    4. 返回 `reply.code(202).send({ assistantMessageId })`，body 由路由显式构造。
  - prompt handler：在 `parsePromptMessage`（`:161`）与 `acceptPrompt`（`:162`）之间加 `if (dependencies.supervisor.controlHeld(id)) throw new HttpError("session_busy")`。
- `server/test/session-rest-helpers.ts`：`createSupervisor()`（`:77-111`）加 `regenerate` 与 `controlHeld` 两个成员（偏离 2）。
- 测试：新建两个测试文件与一个 helper（见 design）。

## Capabilities
- turn-control：
  - MODIFIED「重新生成 REST」：取父 delta 全文，本刀之后整块交付；
  - MODIFIED「会话级控制占用」：正文取父文，补回 prompt；regenerate 间隙 Scenario 取父文。fork 间隙 Scenario 的「照常 201」→ #469。
- chat-sessions：
  - MODIFIED「会话 REST」：路由清单只加 regenerate；恢复父文的 stop+regenerate 合写段；并入 regenerate 段与 Scenario「Regenerate replaces only the last assistant message」；fork → #469；
  - MODIFIED「REST prompt 受理与补偿」：取父 delta 全文；
  - MODIFIED「Supervisor dispatch and generation binding」：只改一个 Scenario 的 WHEN 为 REST 面，引注 → #469。
- http-service-skeleton：MODIFIED「统一错误信封」，并入 bodyless 句（stop 与 regenerate）、parser-owner 真实边界的第二个 WHEN、bodyless Scenario（偏离 4）。
- 各块的裁剪与去向见各 spec 顶部引注。

## Impact
- 行数：`rest.ts` 约 345 行；每个新测试文件 ≤800 行。
- 零 diff：
  - `supervisor.ts`、`branching.ts`、`turn-control.ts`、`approvals.ts`、`pool.ts`、`store*.ts`、`http/errors.ts`、`core/`、`index.ts`、`sessions/stream/`、`omp/`、`app.ts`、`auth/`、web、`server/test/support/fake-omp*.mjs`；
  - 除 `session-rest-helpers.ts` 那两个成员外的全部既有测试与 helper。
- `index.ts:51` 传入的真实 `SessionSupervisor` 已有 `regenerate`（`supervisor.ts:180`）与 `controlHeld`（`:190`），满足加宽后的端口。knip：`regenerate` 与 `controlHeld` 因此有了 src 调用方。
- 行为变化只有两处：
  - 新路由；
  - 占用中的 REST prompt 仍返回 409 `session_busy`，但不再有瞬时行写入，也不再调用 `supervisor.prompt`。

## 偏离与决定
1. **受理前检查落在 `rest.ts`，不进 store 的受理路径**。理由：
   - store 在 supervisor 之下，看不到控制占用（`ControlClaims` 是 supervisor 私有，`turn-control.ts:165-203`）；
   - PR Boundary 禁止改 `store*.ts`；
   - `rest.ts:162-164` 本就没有 await，所以「`controlHeld` → `acceptPrompt` → `supervisor.prompt` 的同步前缀」处在同一同步段，检查与受理之间不可能插入新的占用。

   supervisor 自己的检查（`supervisor.ts:302-305`）保留不动，作为纵深防御。它从 REST 已不可达，但 #465 的测试仍直接调用 `supervisor.prompt`。
2. **`session-rest-helpers.ts` 加两个成员，而不是 carry-forward :58 说的「一个」**。端口一次加宽两个方法，类型强制 stub 同时实现两者：
   - `regenerate()` 调用即以 `Error("unexpected regenerate call")` 拒绝，与 `decide`/`stop`（`:103-108`）同形；
   - `controlHeld()` 返回 `false`，不抛错。它在每个 prompt 请求上都会被调用，抛错会让全部既有 prompt 测试失败。这里有意不沿用「意外调用即拒绝」的模式，理由即此。
3. **真实 supervisor 用例超出 issue 所列的 stub 用例**，先例是 #475 偏离 2。本刀并入的 Scenario 写明 backed by the real fake（`branch`），或要求 `branch` 帧、epoch、SSE、CAS 复核作为证据，stub 证明不了，所以另加 R1–R6 与 W1–W2。状态码映射矩阵仍用 stub。
4. **http-service-skeleton「bodyless 归属路由拒绝任何 body」THEN 偏离父文一处**：「keeps its normal 202/204 behaviour」改为「keeps its normal behaviour」。原因是 running 会话上无 body 的 regenerate 按规范返回 409，逐字推进会把一句不成立的话写进主 spec，而 W1 的对照断言正是 running → 409。归档时父块须采纳这一措辞。先例是 #465 偏离 5 的场景措辞改写。
5. **chat-sessions「会话 REST」stop 段整段取父文**，其中含「which holds the session's control claim for the call」：
   - carry-forward :73/:96 要求替换 #475 的单数段，而不是在后面追加；
   - 该子句的行为已由 #465 交付（`supervisor.ts:251-262` 在 `#controls.during` 内执行），并有 #465 R8a 覆盖（`server/test/session-regenerate.test.ts:338`）；
   - chat-sessions 这段此前没有 owner，不收会成为又一个孤儿片段。
6. **chat-sessions「REST prompt 受理与补偿」整块取父文**，含 `agent_capacity` → 503、`stopped` 可发与补偿失败不伪装为 503。#463 已在 omp-pool-admission 偏离 10 把这些指派给本刀，#475 没有收。这些行为在 master 上已成立：mapper 按 code 映射任意 `HttpError`，`acceptPrompt` 只拒绝 running（`store.ts:318-320`）。design 把它们标为守卫（恒绿）。
7. **Supervisor dispatch 首段的「(Requirement「会话 REST」)」引注留给 #469**。它同时指 regenerate 与 fork，而 fork 路由在 #469 之前不在「会话 REST」里。
8. **regenerate 路由不做路由层状态预检**。409/400 的预检由 `Regenerations.#precheck`（`branching.ts:65-82`）承担，它以 `ownerId` 读 owner-scoped 视图，所以 404 也由它给出。路由不读 `runtimeState`，也不重复判定 status，否则会形成两份不同步的规则。

## Open questions（上报编排者，本刀不处理）
- #465 Open question：提交后派发失败时，supervisor 返回 502，但不发布 `turn.end`/`error`。本刀只能经 502 响应体现，在线订阅者要靠快照刷新才能看到 `failed`。是否合成 `turn.end(failed)` 需要改 supervisor，不在本刀 PR Boundary 内，建议归 #477 或新 issue。
- carry-forward :101：在 regenerate 提交前的 RPC 窗口里调用 stop，stop 按非 running 返回 204、不生效，regenerate 照常完成。本刀之后，这条路径经 REST 可达（先 regenerate 再 stop）。web 侧（#477/#478）须知道，在这个窗口内无法中止 regenerate。
- 父「REST prompt 受理与补偿」与「会话级控制占用」fork 间隙 Scenario 的对账：本刀归档后，前者父块整块交付，须与推进后的主 spec 逐字一致；后者仍为 MODIFIED，由 #469 补上「照常 201」。
- 父 http-service-skeleton bodyless Scenario 的 THEN 须在归档时采纳偏离 4 的措辞。
- 父 chat-sessions「会话 REST」regenerate 段（本刀逐字并入）写的是 `supervisor.regenerate(sessionId)`，而端口与实现是 `(sessionId, ownerId)`（`supervisor.ts:180`），A1 断言的也是后者。这是父文的简写，行为不矛盾：ownerId 用于 owner-scoped 预检。本刀按规则逐字保留，是否在归档对账时补全参数由编排者决定。

## Non-goals
- `supervisor.regenerate` 的语义，即占用、对齐、CAS、派发与失败映射（4.4 #465 已交付，本刀只经 REST 观察）。
- 控制占用的登记与同步判定本身（#465）；错误码与归属集定义（1.2 #450，本刀只消费）。
- stop/fork/approvals 路由（#475/#469/#468）；web「重新生成」（7.3a）；smoke/ui-walk regenerate 条目（8.1b/8.1c）；架构文档 API 表（9.1 #486）。
- 提交后派发失败的事件发布（见 Open questions）。
