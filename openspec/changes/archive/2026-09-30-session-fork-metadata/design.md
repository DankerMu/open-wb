# Design: session-fork-metadata（#527）

父设计：D14（fork 继承）、D1（035 五列）、D4（绑定 → cwd）、D11（八键视图）。行号为 origin/master（dd2039a）。

- **Change surface**：`server/src/sessions/store-branch.ts:186-193`（`FORK_SESSION`、`FORK_MESSAGE`、`FORK_STEPS` 三条常量）；新建 `server/test/session-fork-metadata.test.ts`。
- **Must preserve**：
  - `copyForkHistory`（`store-branch.ts:215-252`）的事务、CAS 复查、拷贝次序、审批拷贝（`FORK_APPROVALS`）与状态规则逐字不变；新会话行仍由单条 `INSERT … SELECT … FROM chat_sessions WHERE id = ?` 从源行取值（不在 JS 侧读出再写回）。
  - `commitFork`（`store.ts:412-422`）以 `SESSION_COLUMNS`/`toSessionView` 投影 201 `session`——不改。
  - 未绑定、无场景的源会话 fork 结果与现状相同（`workspace_id`/`scene` 为 NULL）；既有 `session-fork*.test.ts` 全绿、零改动。
  - fork 不写任何审计（A 的 fork 路径本就不写）；`session.bind` 只由 `POST /api/sessions` 写。
- **Must add/change**：
  - `FORK_SESSION`：列清单增 `workspace_id, scene`，`SELECT` 同位增源行 `workspace_id, scene`；`pinned_at` 不出现（列缺省 NULL）。
  - `FORK_MESSAGE`：列清单与 `SELECT` 增 `thinking`。
  - `FORK_STEPS`：列清单与 `SELECT` 增 `changes`。
  - 直接拷贝列值（TEXT 原样），不经 JS 解码/重编码，NULL 保持 NULL。
- **数据流**：fork 会话继承 `workspace_id` 后，其首次 prompt 走 2.2 的 `runtimeState.workspaceId` → `sessionCwdResolver`（`supervisor.ts:427`）→ `--cwd` = W 根；未继承时为所有者根——这是本刀 cwd 证据的 RED 来源。fork 的 `workspace_id` 外键仍指向同一 owner 的工作空间（源行已受 4.1 owner 校验），不引入跨所有者绑定。
- **Sibling surfaces**：web 侧栏按 `workspaceId`/`scene`/`pinnedAt` 分组与排序（7.x）直接消费 fork 201 与列表；DELETE 源会话后 fork 会话的 `workspace_id` 不受影响（只 `parent_session_id` 置 NULL，已由 4.3b 证）。
- **残余**：源会话所绑工作空间被删除后（`workspace_id` 经外键置 NULL）再 fork → 新会话未绑定，按所有者根运行；与「绑定不可改」的外键语义一致，不在本刀处理。
- **Required evidence**（新建 `server/test/session-fork-metadata.test.ts`：production `createApp` → `registerSessions` + 真实 fake-omp（`branch` 场景，参照 `session-fork-rest-real.test.ts`/`session-fork-helpers.ts`）+ 真实 SQLite，`app.inject()`；工作空间经 `POST /api/workspaces` 创建（先建沙箱根，参照 `session-metadata-rest.test.ts`/`session-workspace-cwd.test.ts`），绑定经 `POST /api/sessions {workspaceId, scene}`，置顶经 `PATCH /api/sessions/:id {pinned:true}`；`thinking`/`changes` 以直接写列构造（本刀不依赖 3.3/3.4），`changes` 写入合法 JSON 数组文本 `[{path,added,removed,kind}]`；路径经 realpath 比较。**三轮源会话的构造**：fake `branch` 默认只有两个 entry（`fake-omp.mjs:55-58`），fork 按 user 序号对位（`branching.ts:226/299`），直接 fork 第三条 user 消息会 502（`session-fork.test.ts:297` 的 (b) 用例）——须 `openForkWorld({entries:[QUESTION]})`（等价追加 `--branch-entry "second question"`），源会话先经 `POST /api/sessions {workspaceId, scene}` 创建，再 `seedTwoTurns(world, {extraTurn:true}, <该 id>)`；`seedTwoTurns` 不产生 `chat_steps`，步骤按 `session-fork-faults.test.ts:208` 的写法以 SQL 直接插入，再直写 `thinking`/`changes` 列。RED：证据 1–4 在实现前红（新会话 `workspaceId`/`scene`/`thinking`/`changes` 为 null、probe `cwd=` 为所有者根），以实际运行记录）：
  1. 继承与不继承（拆为三个 `it`：会话行列 / 消息 `thinking` / 步骤 `changes`，使三条 SQL 各自的 RED 在实现前的运行记录中分别可见；「继承空间与场景、不继承置顶」「Fork inherits workspace and scene but not pin」）：绑定 W、`scene="code"`、已置顶、至少三轮历史的源会话；分叉点前被拷贝的消息中，一条助手消息 `thinking` 非 NULL（含多字节字符）、另一条助手消息 `thinking` 为 NULL；其步骤中一条 `changes` 非 NULL、一条为 NULL。fork 于最后一条 user 消息 → 201，`session` 恰八键、`workspaceId=W.id`、`scene="code"`、`pinnedAt=null`；SQL 新行 `workspace_id=W.id`、`scene='code'`、`pinned_at IS NULL`；源会话 `pinnedAt` 与 fork 前相同（列表与 SQL）；fork 会话快照中每条被拷贝消息的 `thinking` 与每个步骤的 `changes` 按次序与源会话对应部分逐值相等（非 NULL 逐字相等、NULL 读 null），且 SQL 列文本逐字相等；`GET /api/audit`（管理员）`session.bind` 条数与 fork 前相同、无任何新增审计行。
  2. cwd（同上两条 Scenario 的 prompt 部分）：对 fork 会话发 prompt 至 done → 该子进程 spawn argv `--cwd` 与 probe `cwd=` 均为 realpath(W 根)，且不等于所有者根。
  3. 视图与列表一致（「fork 响应的会话视图与列表一致」）：绑定 W、`scene="design"`、已置顶的源会话 fork → 201 `session` 键集恰为八键、`workspaceId=W.id`、`scene="design"`、`pinnedAt=null`，且与随后 `GET /api/sessions` 中同 id 条目 `toEqual`。
  4. 未绑定但有场景：未绑定、`scene="office"` 的源会话 fork → `workspaceId=null`、`scene="office"`、`pinnedAt=null`；fork 会话 prompt 的 probe `cwd=` 为所有者根（RED 来自 `scene`）。
  5. 既有：`session-fork.test.ts`、`session-fork-rest.test.ts`、`session-fork-rest-real.test.ts`、`session-fork-faults.test.ts` 全绿、零改动。
  6. 门禁：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`（knip 零新增）、`bash scripts/size-guard.sh` 退出 0。
