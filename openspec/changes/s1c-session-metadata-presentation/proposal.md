# Proposal: s1c-session-metadata-presentation（S1c change B：会话元数据与呈现）

## Why

S1c 的会话页在 change A（`s1c-turn-control-governance`，Epic #448）之后只剩「会话是什么、放在哪、长什么样」这半边：会话不能绑定工作空间、没有场景、侧栏是一条扁平列表、不能重命名/置顶/删除、模型的 reasoning 被服务端丢弃、工具改了哪些文件用户看不见、对话内无法搜索。demo（`resource/workbuddy-live-demo.html`）把这些当作一等呈现，S1e 按「无后端契约控件不渲染」全部留空（`docs/acceptance/demo-parity-checklist.md` CH-03/CH-13 与 #403/#404 的未归属项）。本 change 按 2026-09-26 grill（23 分支，用户确认）一次补齐服务端契约与呈现，覆盖 F-CHAT-1、F-CHAT-2、F-CHAT-9、F-CHAT-10。

## What Changes

- **空间绑定（F-CHAT-2 的一半）**：`POST /api/sessions` 接受可选 body `{workspaceId?, scene?}`（该路由由此成为 content-parser 归属路由）；绑定会话的 omp 进程以该空间根为 `--cwd`（所有者沙箱内，经既有 `rootOf` 所有者校验），未绑定沿用所有者根；绑定不可改（omp `--resume` 以会话文件头记录的 cwd 为准，事实上也不可改）。`chat_sessions` 增可空列 `workspace_id`（`REFERENCES workspaces(id) ON DELETE SET NULL`）、`scene`、`pinned_at`；迁移 `035_chat_session_metadata.sql`（`ADD COLUMN` 三列 + `chat_messages.thinking` + `chat_steps.changes`），**在 A 的 034 之后**作为第九条回执。
- **场景（F-CHAT-1）**：`scene ∈ {office, code, design}`（文案 日常办公/代码开发/创意设计），欢迎页场景胶囊决定新会话初值与快捷任务列表（demo:1221-1239、2540-2542、2652-2663）；`PATCH /api/sessions/:id` 可改；会话内切换入口归 S1d（Non-goal）。场景只影响欢迎页快捷任务与会话标记，**不**改变模型或工具面（S1c 无专家/工具面契约，留痕为与 F-CHAT-1 原文「决定默认专家与工具面」的偏差）。
- **会话元数据 REST**：单一 `PATCH /api/sessions/:id`，body 为 `{title?, scene?, pinned?}` 的非空子集（多余键 400），返回更新后的 session DTO；`DELETE /api/sessions/:id` 同步删除：running → 登记控制占用 → A 的 stop（同时记录 A 的「停止已在途」，并发 stop 不重复 abort/结算）→ 等回合终态或该受理被补偿（停止意图期间获取/派发失败时无 `turn.end`；终态上限 A 的 `OMP_ABORT_GRACE_MS` + retire）→ retire 进程并关闭该会话 SSE 订阅者 → 删行（级联消息/步骤/审批，fork 子会话 `parent_session_id` 置 NULL）→ 删当前 `omp_session_file` → 204；非 running 直接后半段。`http/errors.ts` 的 parser-owner 映射从 POST-only 扩到 PATCH；归属集在 A 的十条之上加 `POST /api/sessions`、`PATCH /api/sessions/:id` 共十二条（DELETE 无 body，不入归属集）。审计新增 `session.delete`（含被删的 `omp_session_file` 与消息数）与 `session.bind`（绑定空间时）。
- **分区侧栏（F-CHAT-2 的另一半）**：侧栏按「置顶任务 / 任务 / 空间（按 workspace 名分子组）」三分区互斥渲染（置顶 > 空间 > 任务，每个会话恰一条目）；状态×时间筛选纯前端（状态 全部/进行中/已完成；时间 全部时间/今天/更早，按 `updatedAt`）；条目「更多」菜单：重命名 / 置顶·取消置顶 / 删除（确认对话框 `删除任务`）；`助理任务`分区与`导出记录`不渲染（Non-goal）。session DTO 严格键集从五键扩为八键 `{id,title,status,createdAt,updatedAt,scene,workspaceId,pinnedAt}`（server/web 同刀）。
- **顶栏入口**：`useTopbar` 增 `actions` 插槽（spa-shell 修改）；会话页按 DOM 顺序注入「重命名」「对话内搜索」「产物面板」三个图标按钮（铅笔紧贴标题，同 demo:1942-1953；次序由 `features/chat/topbar-actions.ts` 的单一有序常量固定）；composer footer 在欢迎态显示 `任务启动于 <空间名|未选择>` 与空间选择 popover（`搜索工作空间`），不显示权限开关（Non-goal → S3b）。
- **深度思考折叠（F-CHAT-10）**：服务端把 `message_update.assistantMessageEvent.thinking_delta` 映射为新事件 `thinking.delta{messageId, delta}`（按 2048 B / 2 s 合并发布与落库，与 text.delta 刷盘纪律一致），持久化到 `chat_messages.thinking`（上限 32K 码点 + 截断标记，与 #367 双字段 4096 码点的「有界 + 截断」原则一致）；快照消息 DTO 增 `thinking: string | null`；web 在助手正文之前渲染 `<details>` 折叠块 `深度思考过程`（流式中展开、结束后折叠），`thinking` 为 null/空时不渲染。前提：托管 `models.yml` 的模型条目按配置声明 `reasoning: true`（默认开，`MODEL_REASONING=off` 关闭），fake-omp 新增 `thinking` 场景，真 omp + 假上游 smoke 证明帧到达。
- **文件变更卡与产物卡（F-CHAT-9）**：服务端从 `edit`/`write` 工具 `tool_execution_end.result.details` 归纳新事件 `files.changed{messageId, stepId, files:[{path, added, removed, kind}]}`：edit 取 `details.diff` 中 `+N|`/`-N|` 行计数（多文件取 `perFileResults`），write 取 `details.resolvedPath`、`kind="write"`、无行数；路径相对时按会话 cwd 解析，realpath 前缀落在绑定空间根内的才保留（未绑定会话不产生事件；bash 写入不覆盖，写入 spec）；`path` 为空间内相对路径，web 以 ADR-0011 逻辑路径 `<account>/<dir>/<path>` 显示。持久化到 `chat_steps.changes`（JSON），步骤 DTO 增 `changes`。web：助手消息内渲染 `文件变更（N 个）` 卡（`查看详情` 跳 `/files?ws=<workspaceId>` 该空间的文件页；文件页无 path 参数，不定位到具体文件——Stage 2 事实核对后的有意收窄）；按扩展名派生产物卡 html/img/code（正文经现有预览 API 拉取不存副本；html 卡「打开网页预览」在 Dialog 内以 `iframe sandbox="allow-scripts"` srcdoc 渲染取回文本；img 卡「下载」；code 卡「复制代码」；不渲染「在编辑器中打开」）；顶栏「产物面板」Drawer 聚合本会话 `changes` 去重列表。
- **对话内搜索**：纯前端；顶栏按钮展开搜索框（`搜索对话内容`，计数器 `i/n`，上一个/下一个/关闭，Enter/Shift+Enter/Esc）；只搜消息正文（Markdown 源文本，大小写不敏感子串），计数为匹配消息数；跳转时滚动到该消息并做消息级高亮（相对 demo 只 toast 的偏差留痕）。`FollowTranscript` 暴露按消息 id 滚动的接口。
- **fork 继承**：A 的 fork 新会话行继承源会话 `workspace_id` 与 `scene`，不继承 `pinned_at`（B 改 A 的 `store-branch.ts` 插入列表；omp `--resume` 使 fork 会话 cwd 必然等于源空间根）。
- **web 契约同步**：会话/消息/步骤 DTO 键集扩展；SSE 事件联合增 `thinking.delta`、`files.changed`（新事件类型，旧页面按未知类型忽略）；`hasExactlyKeys` 严格解析随字段同步。
- **验证 harness 延伸**：fake-omp 新增 `thinking`（thinking_start/delta/end + 正文）、`edit-write`（一次 edit `+N|/-N|` diff + 一次 write `resolvedPath`）场景，probe 回报增 `cwd=` 字段；fake-upstream（`server/test/support/fake-upstream.mjs`）新增 prompt 文本标记 `WORKBUDDY_THINK`（作答前发三段 `reasoning_content`）与 `WORKBUDDY_WRITE`（工具轮以 `write` 代替 bash）——`make smoke`/`make ui-walk` 消费的是真 omp + 假上游，无法选择 fake-omp 场景，受控上游标记是真运行时取证的唯一确定性手段；新增 `smoke/session-meta.hurl`（POST 绑定空间、PATCH 三字段、DELETE 级联；Makefile `smoke` 配方追加该文件 + `scripts/test-ci-harness.sh` oracle + `AGENTS.md` Verification Matrix 的 HTTP smoke 证据行同 PR）；ui-walk 新建 `web/e2e/ui-walk-sessions.spec.ts`（`ui-walk.spec.ts` 已 799 行）并把 Playwright `testMatch` 改为 glob `ui-walk*.spec.ts`、`globalTimeout` 150 s → 300 s，走查分区侧栏/重命名/置顶/删除/场景胶囊/思考折叠/文件变更卡/产物面板/搜索。
- **文档**：`docs/architecture/system.md` §3.1 与 `IMPLEMENTATION_PLAN.md` S1c 节留痕；A 的 proposal「change B 预定决策」第 12 条「B 不依赖 A」改为「B 排在 A 之后实施（2026-09-26 B grill 修订）」；`CONTEXT.md` 增「任务」术语（= 未绑定空间的会话在侧栏的分区名）。

## 功能覆盖声明

覆盖 F-CHAT-1（三场景：本 change 只做场景标记、欢迎页胶囊与快捷任务切换、PATCH 可改；「决定默认专家与工具面」无 S1c 契约，留痕为偏差，专家/工具面归后续阶段）、F-CHAT-2（会话分组侧栏：置顶/任务/空间三分区 + 空间绑定；「项目/专家团」分组不渲染）、F-CHAT-9（逐回复文件变更卡 / 产物卡 + 顶栏产物面板同批）、F-CHAT-10（深度思考折叠）；另承接 S1e 移交的对话内搜索、重命名、置顶、删除、composer footer 与场景胶囊。

**与 IMPLEMENTATION_PLAN S1c 的偏离**：`:209` 写 F-CHAT-9 「结合沙箱审计中的写记录」——审计只记 `sandbox.reject`/`workspace.create`/`dir.create`，omp 写文件不经 `sandbox.resolve`（`IMPLEMENTATION_PLAN.md:336`），本 change 只从工具帧推导；`:209` 「卡片 `打开`/`查看详情` 跳 `/files` 预览」——html 卡改为会话内 sandbox iframe 预览（grill），`查看详情` 仍跳 `/files`。

**与 grill 拍板的有意修订（留痕）**：A 的 proposal 第 12 条「B 不依赖 A」被本轮 grill 推翻——迁移账本要求 035 在 034 之后（`migration-ledger.ts` 连续前缀校验），A 的重建配方按显式列名复制，A/B 共改 `events.ts`/`session-contract.ts`/`conversation-view.tsx`/`page.tsx`；结论：B 的 spec/设计先行，实施 issue 逐条 `Depends on` A。另：grill「顶栏入口」分支按「对话内搜索」「重命名」「产物面板」列举三按钮，Stage 2 依 demo:1942-1953（铅笔紧贴标题）定 DOM 次序为 重命名 → 对话内搜索 → 产物面板，视为对列举顺序的澄清而非推翻 的对应 issue（迁移 → #449；归约 → #455/#453；前端 → #471/#489/#472；删除 → #473/#490；fork 继承 → #466）。

**与 demo 的有意偏差（留痕）**：
1. 对话内搜索跳转时滚动并消息级高亮（demo 只 toast）；计数为匹配消息数（demo 为匹配处数）。
2. composer footer 只显示空间，不显示权限（demo 显示 `权限 默认权限|完全访问`）。
3. `助理任务`分区、`导出记录`、产物卡`在编辑器中打开`、顶栏`更多`不渲染（IMPLEMENTATION_PLAN:157-158 明确不做）。
4. write 工具的文件变更行只标「写入」无行数（demo 每行都有 +/-；omp write 帧无 diff）。
5. 场景切换只改会话标记与欢迎页快捷任务，不切换模型/工具面。

## Non-goals

- 会话内切换场景入口（S1d）；「允许完全访问」权限开关（S3b）；助理任务/项目分组；导出对话记录；追问 chip（#404 明确不做）。
- bash/heredoc 等非 edit/write 途径的文件写入不进 `files.changed`；空间目录被外部删除/改名后的会话 cwd 修复；branch 产生的旧 `.jsonl` 在删除会话时的清理（见 design「Not yet specified」）。
- 跨会话搜索、步骤输出/thinking 内搜索；产物卡的图片缩略图生成（img 卡只显示名字与下载）。
- 任何 omp 集成面新增（不使用 omp `artifact://`、不新增 RPC 命令）。

## Capabilities

### New Capabilities
- `session-metadata`：会话与空间绑定、场景、重命名、置顶、删除的服务端契约（`POST /api/sessions` body、`PATCH /api/sessions/:id`、`DELETE /api/sessions/:id`、omp `--cwd` 取空间根、审计 `session.bind`/`session.delete`、fork 继承）。
- `session-sidebar`：web 侧分区侧栏、状态×时间筛选、条目菜单（重命名/置顶/删除）、欢迎页场景胶囊与场景化快捷任务、composer footer 空间选择、顶栏重命名入口。
- `turn-artifacts`：`files.changed` 事件的推导、持久化与呈现（文件变更卡、产物卡 html/img/code、顶栏产物面板）。
- `thinking-fold`：`thinking.delta` 事件、`chat_messages.thinking` 持久化与折叠块呈现、`models.yml` reasoning 声明前提。
- `conversation-search`：对话内搜索（纯前端）。

### Modified Capabilities
- `chat-sessions`：会话数据 schema（035 五列，作为 A 034 之后的第九条回执）、会话 REST（八条路由 → 十条：PATCH、DELETE；`POST /api/sessions` 带 body；DTO 八键）、Session module registration and teardown（`runtimeState` 带 `workspaceId`，supervisor 经注入的 `workspaceRootOf` 解析 cwd；删除路径的 retire 与订阅者关闭）、Supervisor dispatch（`--cwd` 取空间根）、fork 行继承。
- `chat-stream`：事件联合增 `thinking.delta`、`files.changed`；`thinking_delta` 不再丢弃；`tool_execution_end.details` 对 edit/write 读取；持久化与回放纪律。
- `chat-web`：DTO 严格键集（会话八键、消息 `thinking`、步骤 `changes`）；事件归约；会话页助手消息块新增折叠块/文件变更卡/产物卡；顶栏入口；欢迎页胶囊；composer footer；搜索。
- `http-service-skeleton`：parser-owner 归属集 A 的十条 → 十二条（按「方法 + 路由」判定），parser 错误映射覆盖 PATCH；服务启动与装配新增第十四个配置键 `MODEL_REASONING`；错误码表不变（复用 `bad_request`/`not_found`/`session_busy`）。
- `omp-runtime`：spawn 契约 `--cwd` 由所有者根改为「绑定空间根，未绑定为所有者根」。
- `omp-test-harness`：新增 `thinking`、`edit-write` 场景，probe `cwd=` 字段；受控上游 `WORKBUDDY_THINK`/`WORKBUDDY_WRITE` 标记。
- `model-proxy`：托管 `models.yml` 模型条目增 `reasoning: true` 与 `compat.reasoningContentField`（`MODEL_REASONING=off` 时省略）；该声明只影响 omp 请求侧与历史回放，不门控宿主 thinking 链路。
- `spa-shell`：顶栏 `actions` 插槽。
- `chat-harness`：新增 `smoke/session-meta.hurl` 与 `web/e2e/ui-walk-sessions.spec.ts`，Makefile `smoke` 配方与 harness oracle 同步，Playwright `testMatch` 改 glob。

## Impact

- **服务端**：`server/src/core/db/migrations/035_chat_session_metadata.sql`（新）；新 `sessions/rest-metadata.ts`（PATCH/DELETE/POST body，`rest.ts` 只接线）、`sessions/store.ts`（列与投影、`runtimeState` 增 `workspaceId`）、新 `store-metadata.ts`（元数据读写、删除）与 `store-changes.ts`（`setStepChanges`）、`sessions/supervisor.ts`（公开 `retire(sessionId)`、订阅者关闭）、`sessions/events.ts`（thinking/files 归约，或新拆 `events-artifacts.ts`）、`sessions/omp/process.ts`（`--cwd`）、A 的 `store-branch.ts`（fork 继承）、`http/errors.ts`（PATCH 映射 + 归属集）、`model-proxy/models-yml.ts`（reasoning）、`core/audit`（两类新 kind）。
- **web**：`features/chat/session-nav.tsx` → 分区组件族（新文件）、`session-contract.ts`、`stream.ts` 接线 + 新 `stream-artifacts.ts`/`stream-thinking.ts`、`conversation-view.tsx`、新 `thinking-block.tsx`/`file-changes-card.tsx`/`artifact-card.tsx`/`artifacts-panel.tsx`/`conversation-search.tsx`/`session-menu.tsx`/`scene-pills.tsx`/`composer-footer.tsx`、`lib/topbar.tsx` + `routes/shell/topbar.tsx` + 新 `features/chat/topbar-actions.ts`（顶栏按钮有序常量）、`lib/api-sessions.ts`（A 拆出）、`scroll-follow.tsx`、`ui/icon.tsx`（新增 star/pencil/trash/more-horizontal/package/download/globe/palette/chevron-up/filter；folder/image/search/code 等 master 已有）。
- **harness**：`server/test/support/fake-omp.mjs`（两场景 + `cwd=`，`expectedProbeReport`/`REPORT_LABELS` 同 PR）、`server/test/support/fake-upstream.mjs`（两标记）、`smoke/session-meta.hurl`、Makefile `smoke` 配方 + `scripts/test-ci-harness.sh` + `AGENTS.md` 证据行、`web/playwright.config.ts` testMatch/globalTimeout、`web/e2e/ui-walk-sessions.spec.ts`。
- **依赖 change A**：实施 issue 逐条 `Depends on` A 的 #449/#455/#453/#466/#471/#489/#472/#473/#490；A 归档在 B 之前。
- **配置**：新增 `MODEL_REASONING`（`on|off`，默认 `on`）。不新增 Make 目标、CI job。
