# Proposal: web-turn-control-client（#472）

## Why
父 change `s1c-turn-control-governance` tasks 7.1（epic #448）。web 需要回合控制四个 API 方法（stop/regenerate/fork/approvals）供 7.2–7.4 的呈现层调用，并须**先于** server 真正发出 `stopped`（4.2a #473 / 2.2b #488 / 5.1a #475，以及 omp 内部 silent-abort 经 #455 归约产生的 `stopped` 行）接受 `stopped` 枚举——web `hasExactlyKeys`/枚举严格解析会把含 `stopped` 的整个会话列表或快照判为非法（父 design D6「web-parse-before-server-emit」）。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 改跨端严格解析契约与 `ApiClient` 公开面；呈现收口不在本刀)
Blast radius: 全部会话页——枚举/键集判错则会话列表或快照整体 request_failed、会话页失效；stop 的 202/204 判错则 7.2 停止提示错乱；信封被改写为 request_failed 则 503/409/400 文案丢失。
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Auth / permissions / secrets（stop 自有 401 路径）；Concurrency / shared state / ordering（游标过滤 + 落刀次序）；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建 `web/test/api-turn-control.test.ts` 与 `web/test/chat-stream-stopped.test.ts`；既有 53 文件 / 1017 例零 diff 全绿；`npm test --workspace web`、`npm run build --workspace web`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh` 退出 0。

## What Changes
- `web/src/lib/session-contract.ts`：会话 status 联合 `idle|running|done|failed|stopped`、消息/步骤 `running|done|failed|stopped` 及守卫；新增严格解析 `isStopAccepted`（`{}`）、`parseRegenerateAccepted`（`{assistantMessageId}`）、`parseSessionFork`（`{session,draft}`，`session` 复用 `parseSession`）、`parseSettledApproval`（内部单条审批元素解析 `parseApproval` + `decision` 非 null）及对应类型。消息 DTO 键集不变。
- `web/src/lib/api-sessions.ts`：`stopSession`/`regenerateSession`/`forkSession`/`decideApproval`；`SessionTransport` 增 `fetchResponse`/`isSuccessfulStatus`/`parseJsonResponse`。
- `web/src/features/chat/stream.ts`：`turn.end.status` 联合与解码加 `stopped`，`endTurn` 归约 `stopped`；`step.end.status` 保持 `done|failed`。
- `web/src/features/chat/status-label.ts`：穷举 Record 补 `stopped: "已停止"`（注释随之改为四态可复用）。
- 新建两个 web 测试文件（见 design「Required evidence」）。

偏离/澄清（相对 issue 正文）：
1. **`web/src/lib/api.ts` 越出 issue 列出的四个文件**（PR Boundary 偏离）：`ApiClient` 类型声明在 `api.ts:111-138`，四方法签名只能加在那里；stop 的 202/204 需要的 `fetchResponse`/`isSuccessfulStatus`/`parseJsonResponse` 是 `api.ts` 私有辅助，按 chat-web「API 客户端源码模块划分」（传输由 `api.ts` 注入、`api-sessions.ts` 对 `api.js` 只允许类型导入、`api.ts` 不新增 export）只能扩展注入展开。`api.ts` 改动仅限：`import type` 加三名、`ApiClient` 加四成员、注入展开加三项；零新增 `export`。行数 681 → 703。
2. **类型命名**：issue 写 `decideApproval(): Promise<Approval>`（「此处 `decision` 非 null」）。本刀按 `session-contract.ts` 既有 `Chat*` 命名，导出 `ChatSettledApproval`（`decision: "allow"|"deny"|"timeout"`），而单条元素类型 `ChatApproval`（`decision` 含 `null`，快照 `approvals` 元素同形）保持模块内私有——它当前唯一使用方在本文件内，导出会被 knip 判为未引用；5.3 #476 在同文件的消息解析中复用它。返回形状与 issue 六键逐字一致。
3. **`turn.end stopped` 与 error**：父文本「`stopped` 不设置 error 文案」两读皆可；本刀取「置 null（同 done）」，理由与证据见 design「Must add/change」。
4. **「API 客户端扩展」一句裁剪**：父句「`stopped` 枚举不在同刀之列，而是先解析后发出」的「同刀」指归 #476 的 `approvals`/`approval.*` 同 PR 落地；本刀未并入那一前句，逐字保留会让主 spec 自相矛盾（前句刚写 status「SHALL 同刀扩为含 `stopped`」），故裁为「`stopped` 枚举先解析后发出」，#476 归档时换回父句原文。
5. **stopped 的圆点/徽章样式**：`chat-session-dot-stopped`/`chat-step-status-stopped` 类在 7.2 #477 前无样式（文字「已停止」正确、圆点/徽章为基础样式）；呈现收口归 #477 与组 8 ui-walk。

## Capabilities
- MODIFIED `chat-web`「API 客户端扩展」（部分交付）：主 spec 原文 + 父 delta 的四方法段、`stopped` 枚举、先解析后发出、会话 DTO 键集不变与 400/409/502/503 信封句逐字；保留主 spec 全部四个 Scenario，并入父 Scenario「回合控制四方法请求与响应」「新错误码信封」全文与「stopped 与 approval 字段严格解析」的 `stopped` 部分（标题不变）。消息 DTO `approvals` 键集句与「服务端快照 `approvals` 键与 `approval.*` 事件同刀」句归 5.3 #476。
- MODIFIED `chat-web`「纯会话视图归约」（部分交付）：主 spec 原文，turn.end 子句替换为父 delta 的 `done/failed/stopped`（`stopped` 不设置 error 文案）句；保留主 spec 两个 Scenario，并入父 Scenario「停止终态归约」全文。`approvals` 视图、八类事件与审批归约及其两个 Scenario 归 5.3 #476。
- MODIFIED `chat-web`「事件流消费与续流」（部分交付）：requirement 正文同主 spec（「六类数据事件」→「八类」归 5.3 #476）；保留主 spec 四个 Scenario，并入父 Scenario「审批事件经同一游标过滤」的 `turn.end stopped` 部分（标题不变）。
- ADDED `turn-control`「回合控制 web 呈现」（部分交付；turn-control 尚无主 spec，本 delta 归档时新生该 capability）：只含父 delta 首句（联合类型、严格解析形状同步与 `已停止` 文案）与 Scenario「停止按钮与文案」的文案部分（标题不变）。停止按钮/助手消息已停止呈现/容量文案归 7.2 #477，重新生成归 7.3a #478，分叉归 7.3b #479。

## Impact
- web：上述四个源文件 + `api.ts`（偏离 1）+ 两个新测试文件；既有测试零 diff；server、Makefile、CI、`page.tsx`/`composer.tsx`/`conversation-view.tsx`/`session-nav.tsx` 零改动。
- 呈现副作用（无源码改动）：`session-nav.tsx:32` 与 `conversation-view.tsx:30` 经 `SESSION_STATUS_LABEL` 查表，会话/步骤为 `stopped` 时显示 `已停止`；对应 `chat-session-dot-stopped`/`chat-step-status-stopped` 样式由 7.2 #477 补齐。
- 落刀次序：本 PR 须先于 #473/#488/#475 合入；#455（PR #547）等待本刀。归档次序：本刀先于 #455 归档；turn-control「stopped 终态」的「与 web 联合类型」子句由 orchestrator 在 #455 归档时并入其 delta，本刀不写。turn-control 主 spec 由本刀归档新生，Purpose 取父 delta（#449 tool-approval 先例）。

## Non-goals
- 消息 DTO `approvals` 键集、`approval.request`/`approval.resolved` 解码与归约（5.3 #476）。
- 任何 UI：停止按钮、已停止徽章/占位、重新生成、分叉、审批条、容量内联文案（7.2–7.4）；`stopped` 的点/徽章样式。
- server 任何改动；`step.end.status` 放宽（#455 保持 `done|failed`）；chat-stream 与 turn-control「stopped 终态」delta。
