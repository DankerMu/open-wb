# Proposal: approval-snapshot（#476）

## Why
父 change `s1c-turn-control-governance` tasks 5.3（epic #448，issue #476）。

审批行已由 #464 落库、作答 REST 已由 #468 上线，但 `GET /api/sessions/:id/messages` 的消息没有 `approvals`（`rest.ts:48-55`、`:231-255`）。web 消息严格键集只有六键（`session-contract.ts:138`），事件联合也没有 `approval.*`（`stream.ts:37-43`、`:68-75`），收到时按未知事件忽略。所以刷新后审批状态无法恢复，7.4 审批条和 8.1a smoke 作答都没有数据源。`hasExactlyKeys` 严格键集使 server 与 web 任一侧单独先合入都会让整个会话页判非法，因此两侧同刀、同一 PR 合入（issue Width exception、父 design D6）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree：公共 REST 快照形状、跨端严格解析与 SSE 事件解码均为 public API / parser 硬触发项)
Blast radius: 键集或元素形状不一致 → web 把整个快照判非法，会话页整体失效；投影顺序或过滤错 → 并行审批遮蔽、错会话审批泄露或 user 消息非空（web 整体拒绝）；归约覆盖/补建错 → 回放后先到的 pending 丢失、无法作答；解码放宽 → 非法事件静默进入视图而不重新同步
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Auth / permissions / secrets；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建 `server/test/session-approval-snapshot.test.ts` 与 `web/test/chat-stream-approvals.test.ts`（各 ≤800 行）；design「Required evidence」S1–S10、W1–W12 全绿，标注先红者在 master 上为红；design「Sibling surfaces」所列既有测试仅按允许清单改期望值后全绿；`npm test --workspace server`、`npm test --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0

## What Changes
- server：
  - `store-approvals.ts` 新增快照投影：按会话一次查出其 assistant 消息的全部审批行，`id` 升序，六键，`decision` 可为 null。
  - `store.ts`：`getMessages` 调用该投影，给每条 `MessageView` 挂 `approvals`；在 `store.ts` 定义并导出可空 decision 的审批元素类型，`ApprovalView` 与其同形（#454 规则）。
  - `store-branch.ts:36`：`toMessageView` 返回类型的 `Omit` 加 `"approvals"`，只改类型一行。
  - `rest.ts`：`PublicMessage`/`toPublicHistory` 加 `approvals`，元素经 #468 已有的 `toPublicApproval` 六键投影。审批路由的注册与 handler 零 diff。
- web：
  - `session-contract.ts`：消息键集加 `approvals`；复用 #472 的 `parseApproval`；数组须按 `id` 严格升序、不重复，user 消息须为 `[]`。
  - 新建 `features/chat/stream-approvals.ts`：两类审批事件的 payload 解码、快照 → 视图映射（去掉 `requestedAt`）、`approval.request`/`approval.resolved` 纯归约。
  - `stream.ts` 只增接线：事件联合与 `DATA_EVENTS` 各加两类、`applyChatEvent`/`decodeEvent` 各加两个 case、视图 `approvals` 字段（快照映射、`turn.start` 与补建 assistant 置 `[]`）。
- 测试：新建上述两个测试文件；既有测试只按 design「Sibling surfaces」允许清单给消息字面量补 `approvals: []`。

## Capabilities
- ADDED tool-approval「审批快照」：父 delta 同名块的 requirement 正文逐字，三个 Scenario 保留父标题。「页面渲染审批条」「web 显示 `已拒绝执行`」两处 → 7.4 #480。
- MODIFIED chat-sessions「会话 REST」：以主 spec 为底，GET messages 形状加 `approvals`，并入父 `approvals` 两句（逐字）。Scenario「Stable public history and recent order」「Approval answer, snapshot and settled conflict」换父文全文，补回 #468 裁掉的快照面与超时 WHEN/THEN。
- MODIFIED chat-web「API 客户端扩展」「纯会话视图归约」「事件流消费与续流」：三块均由本刀交付完毕，父 delta 逐字整段替换。其中换回 #472 裁剪的「`stopped` 枚举不在同刀之列」父句，关闭 #472 注记的前向引用（主 spec 早已提到快照 `approvals` 元素形状，本刀才定义它）。

## Impact
- 行数（实测记入 PR body）：
  - `store.ts` 667 → 约 685；`store-approvals.ts` 229 → 约 265；`rest.ts` 319 → 约 325；
  - `stream.ts` 722 → ≤770（硬上限，超出则把更多逻辑移入 `stream-approvals.ts`）；`session-contract.ts` 259 → 约 285；`stream-approvals.ts` 新建约 110。
- `requireOwnedSession`（`rest.ts:83-93`）经 `getMessages` 被 stop/approvals 路由与 SSE（`stream/sse.ts`）共用，它们都会多一次审批查询。响应与行为不变。
- 零 diff：
  - `supervisor.ts`、`approvals.ts`、`turn-control.ts`、`pool.ts`、`events.ts`、`stream/sse.ts`、`http/errors.ts`、`core/`、`omp/`、fake-omp；
  - web 组件层（`conversation-view.tsx`、`page.tsx`、`turn-actions.ts`）、`api-sessions.ts`、`api.ts`；
  - `rest.ts` 除 `PublicMessage`、`toPublicHistory` 与 `toPublicApproval` 签名以外的全部代码。
- 生产 argv 仍为 `yolo`（#481 之前），生产快照的 `approvals` 恒为 `[]`；非空只出现在测试侧 `--approval-mode write` 与夹具直写行。

## 偏离与决定
1. **越出 PR Boundary：改 `store.ts` 与 `store-branch.ts`**。issue 只列 server 的 `store-approvals.ts` 与 `rest.ts`，但：
   - `getMessages` 与 `MessageView` 都在 `store.ts`（`:55-62`、`:229-269`），投影只能从这里挂进 tree；
   - #454 carry-forward 与主 spec「会话 store 源码模块划分」要求 `store-approvals.ts` 之外被 `rest.ts` 消费的类型定义在 `store.ts`；
   - `MessageView` 加字段后，`store-branch.ts:36` 的 `Omit<MessageView, "steps">` 返回类型不再成立，只能改这一行类型。
   投影本体仍在 `store-approvals.ts`（主 spec 该 requirement 已写明它承载「快照投影」）。
2. **`rest.ts` 复用 #468 的 `toPublicApproval`，只放宽签名**。issue 把 `rest.ts` 限在 GET messages，但快照元素须与作答 200 body 同形（父 D5「作答 REST 200 body 为快照同形的单条 `Approval`」）。复用同一个显式六键投影能让两处在构造上保持一致；复制一份会引入 jscpd 重复，两份也可能各自漂移。所以把 `toPublicApproval` 的参数与返回类型放宽到可空 decision 的元素类型，函数体不动。审批路由的注册与 handler（`rest.ts:194-204`）零 diff。
3. **审批 payload 解码放在 `stream-approvals.ts`**。issue 写「`stream-approvals.ts` 承载归约」「`stream.ts` 只增接线」。两类 payload 解码逐字段严格校验，放进 `stream.ts` 会占掉 78 行余量的一半，所以与归约一起放进新文件。`stream.ts` 的 `decodeEvent` 只增两个 case 调用它们。
4. **投影只取 assistant 消息的行**。登记只向 running assistant 插入（`store-approvals.ts:50-53`），所以 user 消息在正常路径上天然没有行。但表上没有约束保证这一点，而 web 遇到 user 消息非空会拒绝整个快照。投影 SQL 按 `role = 'assistant'` 过滤，让 spec 的「user 消息为 `[]`」由构造保证（design S5）。
5. **`approval.request` 不改会话状态**。父文「会话保持 running」读作「不改变会话状态」：接线不向 `replaceAssistant` 传 `sessionStatus`。这样同 id 重复到达时，不论会话处于何种状态，都返回同一引用（design W7）。这里有意与 `error` 事件不同：`stream.ts:131-139` 按同一父文措辞「会话保持 running」显式传入 `"running"`，因为 `error` 本身就是回合中的状态信号。`approval.request` 只是对某一审批项的增改，按 cursor 次序它的 seq 恒小于 `turn.end`，不会遇到 `done` 状态，传入状态只会破坏重复到达时的同一引用语义。

## Open questions（上报编排者）
- 父 chat-sessions「会话 REST」GET messages 句中的「Session, message and step `status` unions SHALL include `stopped`」：行为早已由 #455/#473/#475 交付并受 `session-store-stopped.test.ts:149` 守护，但没有切片把它并入主 spec。它不是本 issue 交付的行为，本 delta 不并入，请指定归属。建议在 #476 归档或父 change 最终对账时补入。
- 可选、非本刀：审批路由的 `approvalId` 行归属现在可以借快照 tree 前移到 body 解析前。父 tool-approval「审批作答 REST」已采纳 #468 的「解析后、写入前」措辞，本刀后没有待补的 spec 文本；前移会改变 #468 E10/E10b 的证据面，也越出本 issue 的 PR Boundary。是否另开 issue 由编排者定。
- 本刀后生产 argv 仍为 `yolo`，`approvals` 在生产上恒为 `[]`，直到 #481。8.1a/8.2a 依赖本刀与 #481 同时就绪。

## Non-goals
- 审批登记、计时、结算、事件发布（4.3 #464）；作答 REST（5.2a #468）；停止/崩溃/关停/对账的 deny 结算（#473/#474）。
- web 审批条组件、作答交互、倒计时与 `已允许执行`/`已拒绝执行` 文案（7.4 #480）；`page.tsx`/`turn-actions.ts`/`conversation-view.tsx` 任何改动。
- `stream.ts` 拆分；`api.ts`/`api-sessions.ts` 改动（`getMessages` 经 `parseMessageSnapshot` 自动获得新解析）。
- 审批路由 `approvalId` 归属检查前移到 body 解析前（见 Open questions）。
- fork 的审批行拷贝（5.2b #469）；argv 切 `write`（#481）；smoke/ui-walk 作答（8.1a/8.2a）。
