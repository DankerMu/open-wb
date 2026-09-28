# Proposal: ui-walk-fork（#492）

## Why
父 change `s1c-turn-control-governance` task 8.2d（epic #448，issue #492）。

分叉链路已经在 master 上：fork REST（#466/#469）、`从此处分叉` 按钮与跳转/草稿（#479）、smoke 分叉条目（#491）、停止走查（#484）、重新生成走查（#485）。
但 `make ui-walk` 从未在真实浏览器里点过 `从此处分叉`。本刀在重新生成步骤之后、同一走查会话上追加分叉步骤，给父 chat-harness「UI 走查对话步骤」的分叉段提供真实浏览器、两个视口的证据，并补齐该 requirement 余下的全部文字。

走法已在本机实测，见 design「实测」E0：
- 草稿终版两个 project 全绿（连跑 4 遍，另满载 1 遍）；
- 十个变异中九个红（八个两个 project 同红，M7 只红 `mobile-dark`，与设计一致），一个（M6c，延迟 300ms 的自动发送）恒绿——如实记录，原因见决定 3。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：真实浏览器 + 真 omp 分叉临时进程 + 假上游；CI 共享 `ui-walk` job；两个视口）
Blast radius: 草稿被自动发送（fork 交互闭环的核心判定）或草稿取自错误的用户消息而走查仍绿；空转录在历史未装载时被空集合「满足」；分叉会话与源会话同名，按名定位会点错；分叉会话 `updated_at` 最新、排在列表首位，打断 `mobile-dark` 旅程后段的 #424 选会话断言。
Selected risk packs: Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: `make ui-walk` 两个 project 全绿（本机 CI 脚本连跑 ≥3 遍，含一遍满载）；design E2 的 M1/M2/M3/M3b/M4/M5/M6a/M6b/M7 各自红、M6c 记录恒绿；`make lint`、`make typecheck`；`wc -l web/e2e/ui-walk.spec.ts` ≤800（预期 799）；PR CI `ui-walk` job 绿

## What Changes
- `web/e2e/ui-walk-stop.ts`：
  - 新增导出 `walkFork(page, project, sessionId, prompt)`：首条用户消息正文守护 → 等 `从此处分叉` 可用 → 挂 prompt POST 监听 → 点击，fork **201** → URL `?session=` 等于 201 体的新会话 id、≠ 走查会话 → `消息` region 可见且 0 条 article、无 `重新生成` → composer 草稿恰为首条 prompt、`发送` 可用 → 侧栏当前项 `<title> 未开始` → 监听期间 0 个 prompt POST。
  - `sessionPost` 的端点联合加 `"fork"`；模块头注释加两行分叉说明；`walkFork` 含 `mark()` 打点（fork 201 / URL / 空转录 / 草稿 / 侧栏，Node 侧 `console.log`）；新增 `type Request` import 与两个正则常量（会话 id、prompt 路径）。
  - 模块名不改（仍是 `ui-walk-stop.ts`）：改名只会扩大 diff，import 行不省。
- `web/e2e/ui-walk.spec.ts`：复用既有 `:38` import 行（只加名字 `walkFork`）；`:341` `walkRegenerate(...)` 之后加 1 行 `await walkFork(page, project, sessionId, prompt);`（`prompt` 即 `:290` 的首条模板 prompt）。798 → **799** 行。
- `web/e2e/ui-walk-layout.ts`：`selectFirstSessionInOverlay`（`:309-314`）改为点列表中首个**非 `未开始`** 的会话（`filter({ hasNot: status 名以 ' 未开始' 结尾 })`），注释写明原因。spec 零行变化，`:121-124` 的 #424 断言不改。
- 其它文件零 diff：`web/src`、server、Makefile、CI、env、`ui-walk-gate.ts`、`ui-walk-oracle.ts`、`ui-walk-approval.ts`、`route-hold.ts`、`fake-upstream.mjs`、`playwright.config.ts`。

## Capabilities
- MODIFIED chat-harness「UI 走查对话步骤」：以当前主 spec 原文（#485 归档后）为底，并入父 delta 余下的全部差异：
  - 分叉步骤句（逐字），接在重新生成步骤句之后；
  - 双 project 句枚举改为「approval, reload, stop, regenerate and fork steps」；
  - 禁止区间句枚举改为「the stop, regenerate and fork steps」；
  - Scenario「分叉走查」（逐字）。
- 交付后整块与父 delta 同名块**逐字一致**（`cmp` 通过，design「Spec 对账」）；父块不缺主 spec 已有的任何文字。

## Impact
- CI `ui-walk` job：每个 project 的旅程多约 0.6s。
  - 本机实测旅程：master（#485）12.1/12.6s；本刀 12.1–12.7s（desktop）/ 13.1–13.2s（mobile）；满载（14 核 `yes` ×14）13.5/14.3s；单测上限 30s（`playwright.config.ts:14`）。
  - 步骤耗时几乎全在服务端 fork（临时 omp 进程 `--resume` → `get_branch_messages` → `branch` → `get_state`）：POST 于步骤起 +19–23ms 发出，201 于 +560–611ms 到达（满载 782/1314ms）；其后各断言合计 ≤35ms。
- 分叉不弹 Toast（`message-actions.tsx:61-79` `ForkAction` 不调 `useToast`，文件头注释「no toast」），无需 #643 类等待。
- 走查结束时页面停在空的分叉会话、composer 带未发送草稿。调用点之后的 `ui-walk.spec.ts:115-150` 实测不受影响（design E0-3）。
- 行数：`ui-walk.spec.ts` 799/800；`ui-walk-stop.ts` 157 → 226；`ui-walk-layout.ts` 561 → 567。

## 决定与偏离
1. **步骤放进 `ui-walk-stop.ts`、复用 import 行**（carry-forward :136、:140）。spec 只剩 2 行余量；import 行加名字不增行，调用 1 行 → 799。
2. **定位不靠会话名**（carry-forward :123、:133）：分叉会话复制源标题，侧栏有两个 `WORKBUDDY_UI_WALK:`。新会话以 URL `?session=` 认定，并与 fork 201 体 `session.id` 交叉核对；侧栏只看 `aria-current` 项。按钮限定在首条用户 article 内（每条用户消息都有 `从此处分叉`），点击前等可用（composer 锁定期间禁用，`conversation-view.tsx:154`）。
3. **「无 prompt POST」的观察窗口是因果定义的，不用 sleep。**
   - 开：点击前 `page.on("request")`，记录**任何**会话的 `POST /api/sessions/<id>/prompt`（点击时还不知道新 id；自动发送若发生，与 `setDraft`/`refreshList`/`selectSession` 同在 `turn-actions.ts:383-389` 的回调里，监听必须先于它）。断言 0 条，是「新会话无 prompt POST」的超集。
   - 关：侧栏 `未开始` 断言之后。空转录（历史已装载）、侧栏新项（列表刷新已渲染）都在那个回调的下游，回调里或其触发的渲染/effect 里的任何同步发送此时已发出。
   - 承重性（E2）：M5（DOM 断言都过了才发送）只有这条红，3/3（每遍两个 project）。
   - M6a（产品代码在回调里立即发送）先红于空转录，M6b 去掉网络断言仍红于同处，各 1 遍、两个 project 均 Received 2。这依赖服务端先处理 prompt 插入、再响应新会话首个 messages GET：浏览器侧次序有利（POST 与跳转同一回调、先于 GET 发出），但仍是服务端竞态，不是保证。`toHaveCount(0)` 一旦见 0 即通过，所以对窗口内发出的请求，不依赖竞态的守护是网络观察。
   - **残余**：M6c（产品代码 `setTimeout` 300ms 后发送）两个 project 全绿、整条旅程全绿。窗口在 201 之后约 25–35ms 关闭，晚于此的定时发送不在本步骤可见范围。现有 `forkTurn` 没有定时器，这类回归需要刻意引入；不加固定 sleep 延长窗口（任何有限 sleep 都有同样的残余）。见 Open questions。
4. **空转录非空洞**：先断言 `region 消息` 存在且可见（`<section aria-label="消息">` 只在 `historyView` 就绪后渲染，`conversation-view.tsx:151`、`:203-213`），再断言 0 条 article。历史加载中 section 不存在，0 条 article 不能被加载态满足。E0 用的是 `toBeVisible()`（空 section 有非零盒子，全部实测通过）；论证只依赖「存在」，实现改用 `toHaveCount(1)` 同样成立。
5. **首条用户正文守护**：点击前断言首条用户 `.chat-msg-body` 恰为 `prompt`，把「草稿 = 首条模板 prompt」绑定到被点的那条消息上。M3b 证明草稿断言会区分分叉点。
6. **偏离 issue PR Boundary「既有 journey 不改」**：只改 helper 的选择条件、断言零改动，原因是分叉会话按 `updated_at` 排在最前。**`selectFirstSessionInOverlay` 跳过 `未开始` 会话**（carry-forward :140）。列表 `ORDER BY updated_at DESC`（`server/src/sessions/store.ts:248`），分叉行插入时 `created_at = updated_at = now`（`store-branch.ts:166`、`:210`），空分叉排第一，原 `.first()` 点到它，`:123` `article 助手` 5s 找不到（M7，只红 mobile）。空会话按定义就是 `idle`（chat-web：`idle` 仅当无历史），「跳过 `未开始`」与「选一个有消息的会话」等价。#424 断言意图（mobile 能从覆盖层选会话并看到其消息）不变；E0 诊断确认 mobile 选中的是本 project 的走查会话。
7. **常量重复**。首条 prompt 由调用方传入，不在 `ui-walk-stop.ts` 重新拼接；会话 id 正则在模块内再定义一次，不从 spec 导出（同 #484 决定 3）。

## Orchestrator decisions / Open questions
- 自动发送的观察窗口止于侧栏断言，不加固定 sleep（决定 3）。M6c 的残余是否可接受，请编排者裁定；本 fixture 建议接受。
- carry-forward :126「分叉跳转后键盘焦点落到 `body`」：E0 诊断两个 project 均为 `BODY`。chat-web spec 对此未作要求，本刀不断言、不修，只记录；如需约束，归 web/src 另开 issue。
- carry-forward :123「用户气泡内图标的视觉/a11y（hover/focus-visible/tooltip）」：E0 诊断 `title="从此处分叉"`（tooltip）、操作条 opacity 1（常显，非悬停出现）；hover/focus-visible 视觉不在本刀断言范围（spec 未要求，行数也不允许在 spec 内加），如需截图证据归 ui-shots。
- 草稿遗留：走查结束后 composer 草稿（page 级 `draft` state，`page.tsx:44`）随 ChatPage 在 `/` 的欢迎态、mobile 选中的走查会话里一直存在，到 `设置` 路由卸载才消失；E0 实测后段断言全绿、无确认对话框。只记录。
- demo-parity-checklist CH-09/CH-12/CH-22 更新不归本刀，至 #486 时另开 docs issue（carry-forward :134、:141），本刀只提供证据。

## Non-goals
- 重新生成（8.2c）、停止（8.2b）与审批（8.2a）步骤本身的行为。
- 任何 `web/src`、server、Makefile、CI、env 改动（CI 不传 `OMP_MAX_PROCESSES`，默认 16 容纳 fork 临时进程）；不新增 Playwright project、不新增 gate；不 build/start/stop 服务。
- 分叉后焦点管理、图标 hover/focus-visible 视觉。
- demo-parity-checklist 与其它文档更新（至 #486 时另开 docs issue，carry-forward :141）。
