# Tasks: s1c-turn-control-governance

> 依赖顺序：1（schema/错误码/配置）→ 2（runtime 命令面）→ 3（归约与事件）→ 4（supervisor 治理与回合控制）→ 5（REST）→ 6（fake-omp）→ 7（web）→ 8（harness）。每组尾部两行为 Stage 5 宽度门禁输入。

## 1. chat-sessions / http-service-skeleton — schema、错误码与配置

- [ ] 1.1 `server/src/core/db/migrations/034_chat_turn_control.sql`：三表重建把 status CHECK 扩为含 `stopped`（列/索引/FK/级联逐一列出，不用 `SELECT *`）、`chat_sessions.parent_session_id`、新表 `chat_approvals`；单测：新库回执八条且三表接受 `stopped`/拒绝其它值；带数据的 033 库升级后每行等价、`chat_approvals` 空表就位；重建中途冲突不留半表且无 034 回执；`PRAGMA foreign_key_check` 为空
- [ ] 1.2 `server/src/core/errors/index.ts` 十一码 → 十三码（`agent_capacity`、`approval_settled`），`server/src/http/errors.ts` 状态映射 503/409 与 `CONTENT_PARSER_OWNED_ROUTES` 加 `/api/sessions/:id/fork`、`/api/sessions/:id/approvals/:approvalId`；既有信封形状/归属测试面扩断言（路由存在前仅为集合成员断言）
- [ ] 1.3 `server/src/agent-config.ts` + `server/src/server.ts`：`OMP_MAX_PROCESSES` 解析（正整数、默认 16、超限启动失败，同 `OMP_IDLE_MS` 纪律），传入 supervisor runtime options；单测覆盖缺省/合法/非法三态与启动失败信号

Suggested fixture level: compact - 迁移与错误表是既有 seam（`openDb` + 形态测试、inject 信封测试）的机械扩展；重建迁移的原子性以真实临时 SQLite 证明即可，无进程/网络面
Minimal mergeable slice: 1.1 迁移单独可合并保绿（openDb 自动执行故非死代码；旧代码只写 done/failed 仍满足新 CHECK）；1.2 独立可合并（集合成员断言）；1.3 独立可合并（配置只被读取、上限尚未消费也非死代码——写入 startup 记录）

## 2. omp-runtime — 命令面与退出上报

- [ ] 2.1 `server/src/sessions/omp/process.ts`：spawn argv `--approval-mode yolo` → `write`；`extension_ui_request` 分流——`select` + options 恰为 `["Approve","Deny"]` + title 前缀 `Allow tool: ` 抛给 owner（不自动应答），其余仍即时 `cancelled`；spawn 契约单测 argv 精确形状更新；帧层单测对 fake-omp `approval` 场景断言未自动应答、对 `confirm` 场景仍 `cancelled`
- [ ] 2.2 `server/src/sessions/omp/runtime.ts`：`command(frame)` 暴露相关请求（进程存活且非回合中，否则 `SessionBusyError`）；`abort()`；`onExit` 恒接线到 owner（空闲/崩溃/retire/驱逐/关停全部上报一次）；审批挂起时 `markPending()/clearPending()` 暂停/恢复空闲计时；单测：可注入时钟证明挂起期不回收、结算后按原 idle 回收；退出上报恰一次

Suggested fixture level: expanded - Critical Path（子进程 spawn/回收、UI 请求分流决定审批是否被静默拒绝），须以真实 fake-omp 子进程证明帧次序与退出上报
Minimal mergeable slice: 2.1 的**分流**部分独立可合并（抛给 owner 的审批请求在 owner 未消费前由 runtime 兜底 `Deny` 应答，保证不悬挂）；2.1 的 **argv `write` 切换**会让既有真 omp smoke/ui-walk 卡在审批，须与 8.1 的审批作答条目、8.2 的审批步骤同 PR（或在 4.3/5.2 作答路径合入之后）；2.2 依赖 2.1

## 3. chat-stream — 归约与审批事件

- [ ] 3.1 `server/src/sessions/events.ts`：`message_end{stopReason:"aborted"}` 记为中断，终止 `agent_end` 发 `turn.end{status:"stopped"}` 且无 `error`；新增纯 `applyStop(state)`（有界退回用，恰一次）；`turn.end.status` 联合加 `stopped`；审批 `extension_ui_request` 不进归约；表驱动单测覆盖 aborted/error/正常三路与 applyStop 幂等
- [ ] 3.2 `ChatEvent` 联合新增 `approval.request{messageId,approvalId,tool,title,expiresAt}`、`approval.resolved{messageId,approvalId,decision}`；ring/SSE 无改动即透传（单测：两事件入 ring、`Last-Event-ID` 回放包含它们）

Suggested fixture level: compact - 纯函数 + 既有 ring 单测面
Minimal mergeable slice: 3.1 单独可合并（归约器新分支在 supervisor 消费前只是更宽的联合类型，既有消费者以穷举 switch 需同 PR 补 `stopped` 分支——store.finishTurn 接受 `stopped` 已由 1.1 迁移放行）；3.2 独立可合并（类型 + ring 测试）

## 4. omp-pool / turn-control / tool-approval — supervisor

- [ ] 4.1 `server/src/sessions/supervisor.ts` 池治理：`#liveProcesses` 登记（最近活动时刻、是否回合中）、`#admitProcess()` 串行临界区（`live<cap` 放行；`==cap` 驱逐最久空闲并等待其 shutdown；无可驱逐抛 `agent_capacity`）、`onExit` 回调删 slot（修复泄漏）；对 fake-omp 以 cap=1/2 证明：第三个会话触发驱逐、全忙 503、被驱逐会话下次 prompt 以 `--resume` 起、空闲回收后 `#slots` 不含该会话
- [ ] 4.2 supervisor 停止：`stop(sessionId)`——先以 `deny` 结算全部 pending 审批（发 `Deny`、落库、审计、发布 resolved），再 `abort`；`OMP_ABORT_GRACE_MS`=8000 内 `agent_end` 未到 → 既有 retire 路径 + `applyStop` 合成 `turn.end stopped`；`store.finishTurn` 接受 `stopped` 并把 running 步骤结算为 `stopped`；对 fake-omp `abort-ok`/`abort-ignored`/`approval-then-abort` 三场景各一用例，probe 断言 `extension_ui_response` 先于 `abort`
- [ ] 4.3 supervisor 审批：审批请求 → `chat_approvals` 落库 pending → 发布 `approval.request` → 60s 可注入时钟计时；`decide(sessionId, approvalId, decision)`：pending → 落库/发 `Approve|Deny`/审计 `session.approval`/发布 resolved；非 pending → `approval_settled`；超时 → `timeout` + `Approve`；快照读取每条助手消息最新审批；对 fake-omp `approval` 场景证明 allow/deny/timeout 三路与重复作答 409
- [ ] 4.4 supervisor 重新生成：`regenerate(sessionId, ownerId)`——前置形态校验、取/起 slot（计入池）、`get_branch_messages` 末项 text 与 SQLite 末条用户消息相等（否则 `agent_unavailable`）、`branch`、`get_state` 新文件、单事务删旧助手行/插新 running 行/更新 `omp_session_file`、以 text 派发；fake-omp `branch` 场景证明历史只剩新回答且新文件路径落库
- [ ] 4.5 supervisor fork：`fork(sessionId, ownerId, messageId)`——用户消息校验、新会话行（`parent_session_id`、title 复制）、临时 runtime 经 `#admitProcess` 以 `--resume` 原文件起、序号+文本对齐选 entryId、`branch`、`get_state`、关停临时进程、事务写新文件与拷贝分叉点前消息/步骤行、不一致回滚并 `agent_unavailable`；fake-omp `branch` 场景证明原会话文件/进程不动、新会话行与拷贝内容、临时进程计入上限（cap=1 时 fork 期间新 prompt 得 503）

Suggested fixture level: expanded - AGENTS.md Critical Path「omp 子进程治理」白盒面：进程计数、驱逐、abort 次序、审批默认方向都只能以真实子进程证明
Minimal mergeable slice: 4.1 单独可合并保绿（池治理 + 泄漏修复不依赖新 REST；既有 prompt 路径经 `#admitProcess`）；4.2 依赖 3.1、2.2；4.3 依赖 2.1、2.2、3.2、1.1；4.4 依赖 2.2、1.1；4.5 依赖 4.1、2.2、1.1；4.2–4.5 互相独立

## 5. chat-sessions — REST

- [ ] 5.1 `server/src/sessions/rest.ts`：`POST /api/sessions/:id/stop`（running → 202；非 running → 204；owner 404）与 `POST /api/sessions/:id/regenerate`（202 `{assistantMessageId}`；running 409 `session_busy`；形态不符 400；对齐失败 502；容量 503）；inject 单测覆盖全部状态码与 no-store
- [ ] 5.2 `POST /api/sessions/:id/fork`（body 恰 `{messageId:number}`；201 `{session, draft}`；非用户消息/外部消息 400；running 409；502/503）与 `POST /api/sessions/:id/approvals/:approvalId`（body 恰 `{decision:"allow"|"deny"}`；200；非 pending 409 `approval_settled`；404）；`GET …/messages` 助手消息增 `approval` 字段；inject 单测 + 既有 messages 形状测试更新

Suggested fixture level: compact - `app.inject()` + 真实 SQLite + stub supervisor 是既有 REST seam；进程语义已在组 4 证明
Minimal mergeable slice: 5.1 依赖 4.2、4.4（对 stub supervisor 可先合并路由形状，但 knip 会把未接线的 supervisor 方法判死代码，故按依赖顺序合入）；5.2 依赖 4.3、4.5

## 6. omp-test-harness — fake-omp

- [ ] 6.1 `server/test/support/fake-omp.mjs` 新 scenario：`abort-ok`、`abort-ignored`、`branch`（真实在 `--session-dir` 下建新文件、`get_state` 随之改变）、`approval`（仅 argv 含 `--approval-mode write` 时在 bash 前发审批 select；`Approve` 继续、`Deny` 发 `tool_execution_end{isError}` 后完成）、`approval-then-abort`（select 挂起时不响应 abort）；`approval` 场景按真实次序先发 `tool_execution_start` 再发 select；新增解析 `--session-dir`、`--approval-mode`；probe 尾部增 `frames=` 入站帧类型次序（`fake-omp.test.ts` 精确相等断言与 `server/test/linux/uid-isolation.test.ts` 的 `parseLabeledReport` 同 PR 更新）；自身契约单测

Suggested fixture level: compact - 测试支撑脚本 + 自带契约测试，无生产代码
Minimal mergeable slice: atomic - 单文件脚本，五个 scenario 共享同一 argv/probe 解析，拆开会让组 2/4 的消费者分批等待且每批都要重跑同一契约测试；建议先于组 2 合入

## 7. chat-web

- [ ] 7.1 `web/src/lib/{api,session-contract}.ts` + `web/src/features/chat/stream.ts`：四个新 API 方法；status 联合加 `stopped`、消息 `approval` 字段、`hasExactlyKeys` 键集更新；归约 `turn.end stopped`、`approval.request/resolved`；503/409 信封文案透出；单测：解析三态、归约新事件、未知 approvalId 忽略
- [ ] 7.2 `composer.tsx` 运行中 `停止` 按钮（aria-label `停止`，Icon `square`——`square`/`refresh-cw`/`git-branch` 三个图标从 lucide 移植进 `web/src/ui/icon.tsx`，恰调一次 stop，202 → Toast `已停止生成`，204 无 toast）+ `status-label.ts` 加 `stopped: 已停止`（会话点/步骤徽章/composer）+ 503 `agent_capacity` 内联文案并解锁；jsdom：运行中点停止一次、状态文案、容量错误
- [ ] 7.3 `message-actions.tsx` 末条助手消息 `重新生成`（会话 done/failed/stopped 时可用，恰调一次，Toast `正在重新生成…`，对账后旧回答被替换）+ 用户消息操作条 `从此处分叉`（恰调一次 fork → 跳转 `?session=<new>` → 草稿填 `draft` 不发送）；jsdom 覆盖两操作与失败分支
- [ ] 7.4 `approval-bar.tsx`：pending（`需要你的确认`、title、`（<n>s 内未操作将自动允许）` 实时倒计时（初值 60）、`允许`/`拒绝` 点击后禁用）、allow/timeout → `已允许执行`、deny → `已拒绝执行`；`approval_settled` 409 不弹错、等下次快照；jsdom 覆盖四态与刷新后从快照恢复 pending

Suggested fixture level: expanded - 呈现改动按前端通用契约至少真实浏览器 + 视口矩阵（S1e 后 web 任务不得只以 jsdom 收口）；7.1 可 compact
Minimal mergeable slice: 7.1 单独可合并保绿（解析/归约扩展带配对测试；server 已先合入组 5 时旧页面严格解析亦兼容）；7.2 依赖 7.1；7.3 依赖 7.1；7.4 依赖 7.1；7.2–7.4 互相独立

## 8. chat-harness — smoke 与 ui-walk

- [ ] 8.1 `smoke/chat.hurl`：既有首轮用例在 prompt 后轮询到 pending 审批并 `POST …/approvals/:id {decision:"allow"}` 再等 done（轮询上限覆盖 60s）；新建第二会话 prompt → pending 审批时 `POST …/stop` 202 → 轮询 status 至 `stopped` → 再 prompt 202；idle 会话 stop → 204；回合控制条目以 `[Options] skip: {{skip_turn_control}}` 模板化；Makefile `smoke`（false）/`smoke-live`（true）各加一个 `--variable`，`scripts/test-ci-harness.sh` oracle 同 PR 跟随且 `make test-guardrails` 绿；`make smoke` 绿
- [ ] 8.2 `web/e2e/ui-walk*.ts`（真 omp + 假上游）：首轮 running bash 步骤与审批条 `需要你的确认` 同时可见（不断言先后）→ 点 `允许` → `已允许执行` → 回合完成；同会话第二个受控 prompt 在 `held` 时点 `停止` → Toast `已停止生成`、会话 `已停止`、composer 解锁；两个 project 全绿；CI 不传 `OMP_MAX_PROCESSES`

Suggested fixture level: expanded - 真实 HTTP 与真实浏览器证据，CI 既有 smoke/ui-walk job；8.1 触碰受保护 Make 配方需 oracle 同步
Minimal mergeable slice: 8.1 依赖 5.1、5.2（独立可合并；**注意**：5.x 合入后 `--approval-mode write` 已生效，既有 chat.hurl 会红，故 8.1 须紧随 2.1 的 argv 切换同批或先于其合入——建议 2.1 与 8.1 的审批作答部分同 PR）；8.2 依赖 7.2、7.4（独立可合并，同样受 2.1 切换影响，ui-walk 审批步骤须与 2.1 同批）；两者互相独立

## 9. 收尾

- [ ] 9.1 `docs/architecture/system.md` §3.1 `sessions` 行补"全局上限/最久空闲驱逐/审批经 host 应答"一句；`IMPLEMENTATION_PLAN.md` S1c 节标注 change A 归属与偏差留痕引用；`make check` 全绿

Suggested fixture level: none - 文档
Minimal mergeable slice: atomic - 两处文档一句话改动，随任一末尾 PR 或独立 docs PR
