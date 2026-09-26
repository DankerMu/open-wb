# Proposal: omp-approval-recognition（#460）

## Why
父 change `s1c-turn-control-governance` tasks 2.1a（epic #448，issue #460）。`OmpProcess` 目前对所有 `extension_ui_request` 在帧处理内即时回 `{cancelled:true}`（`server/src/sessions/omp/process.ts:554-564`）。omp 一旦以 `--approval-mode write` 运行，exec 档工具的审批 select 就会被静默拒绝。本刀让 transport 识别审批 select 并上抛给 owner，并提供 `respondApproval` 作为审批应答的唯一写出口。transport 永不自行作答，这是 tool-approval 全链路的前提（4.3 #464 登记/计时/作答、4.2a #473 先 Deny 后 abort、4.6 #474 非作答结算）。生产 argv 仍为 `yolo`，该分支在生产中不可达，argv 切换归 #481。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: 属 omp 子进程治理 Critical Path，UI 请求分流决定审批是被上抛还是被静默 `cancelled`，新增 `OmpProcess` 公开方法与事件)
Blast radius: 识别写宽，非审批 UI 会挂死子进程；写窄，审批会被静默拒绝；transport 或 runtime 在超时、retire、退出时自行作答，审批就会被绕过。`respondApproval` 不幂等或在收尾期写帧，会产生重复应答，或让 retire 变成 transport 错误。
Selected risk packs: Public API / CLI / script entry；Schema / columns / units / field names；Auth / permissions / secrets；Concurrency / shared state / ordering；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 新建一个测试文件，按 design「Required evidence」E1–E11 验证：真实 fake-omp `approval`/`extension-ui`，argv 经测试侧 `spawnImpl` 由 `yolo` 改为 `write`；FakeChild 喂合成帧；SessionRuntime 使用注入时钟。R 项先红后绿，G 项恒绿。以下命令退出 0：`npm test --workspace server`、`make lint`、`make typecheck`、`make anti-drift`、`bash scripts/size-guard.sh`。既有测试零改动全绿。

## What Changes
- 新建 `server/src/sessions/omp/ui-requests.ts`，是无状态的纯函数模块。它按识别谓词把 `extension_ui_request` 分成审批请求和即时回绝两类，解析工具名，并构造 `extension_ui_response` 的两种帧形状：`cancelled:true` 与 `value:"Approve"|"Deny"`。它还导出 owner 侧类型 `{id, title, tool}` 与 `"allow"|"deny"`，这些类型只从该模块导出，`process.ts` 不做 re-export。
- `server/src/sessions/omp/process.ts`：
  - `OmpEvents` 新增 `approval` 事件，载荷为 `{id, title, tool}`。
  - `#onFrame` 保持先发 `frame` 事件，再按分类结果二选一：审批请求记入 outstanding 集合并同步发 `approval`；其它请求照旧写 `cancelled`。
  - 新增公开方法 `respondApproval(id, decision): void`。只有 outstanding 中的 id 才写恰一帧，写后移出集合；未知 id、已答 id、不可写（stdin 已 end、writes 已关、已 fatal/退出）时不写、不抛、不触发 transport 错误。
  - writes 关闭时清空 outstanding。
  - argv 保持 `yolo` 不动。
- 新建一个帧层测试文件（建议 `server/test/omp-approval-requests.test.ts`）。

## Capabilities
- MODIFIED `omp-runtime`「RPC IO and child observation」：整段逐字取父 delta，本 issue 全量交付。其中「Neither the transport nor SessionRuntime…」由 runtime 零改动加源码守护（E10）兑现。
- MODIFIED `omp-runtime`「omp 运行时源码模块划分」：以主 spec 为底，加 `ui-requests.ts` 的职责句与新 Scenario「UI 请求分类模块边界」。原 Scenario「模块划分可持续验证」逐字保留。
- ADDED `tool-approval`「审批请求识别」，部分交付：包含分流句、工具名句，以及逐字重述的「不进归约」句（#455 已交付）。首句 argv `write` 留给 #481；Scenario THEN 中 supervisor、落库、事件部分留给 #464，标题与 WHEN 保持父文。

## Impact
- 源码只涉及 `process.ts` 与新增的 `ui-requests.ts`。`runtime.ts`（公开 API 与实现）、`commands.ts`、supervisor、store、`fake-omp.mjs`、既有测试与测试 helper 零 diff。
- 行数估算（2.0 #452 留下的条件拆分）：
  - 不拆时 `process.ts` 从 732 行增加约 55 行（类型 8、事件与字段 2、`respondApproval` 14、`#onFrame` 净增 2、清空 outstanding 3、分类与解析函数 26），约 787/800 行。这个余量在 biome 折行误差内，评审轮次里的任何修补都可能触发 size-guard。
  - 拆分后 `process.ts` 净增约 24 行（多行 import 5、事件与字段 2、`respondApproval` 12、`#onFrame` 净增 2、清空 3），约 756 行；`ui-requests.ts` 约 50 行（头注释 3、`import type` 1、常量 2、类型 10、分类约 20、解析与帧构造约 14）。
  - 以上是估算，实现 PR 记录实测 `wc -l`。

## Deviations
- `respondApproval` 的 decision 取 `"allow"|"deny"`，以 issue Key interfaces 为准。父 tasks.md 2.1a 原文写的是 `respondApproval(requestId, "Approve"|"Deny")`（本 tasks.md 逐字保留该原文）。建议在归档 PR 中把父 tasks 文字改为 `"allow"|"deny"`，与父 spec 的「`respondApproval(id, decision)`… `allow`/`deny`」一致。
- tool-approval 三个 Scenario 的 THEN 改写为 owner 级表述（「`OmpProcess` 的 owner 收到审批请求」），不写 supervisor、落库和事件。原因是 supervisor 接线归 #464，逐字引入父文会多承诺未交付的行为。#464 归档时换回父文。
- 选定拆分，偏离父 2.0 的严格条件：估算不拆约 787 行，并未超过 800，而父 2.0 只在「若 2.1a 后将超限」时才拆。选择拆分是因为约 13 行余量落在 biome 折行误差内，评审轮次里的任何修补都可能触发 size-guard。是否接受由编排者裁定；若否决，则全部内联进 `process.ts`，并删去 omp-runtime「源码模块划分」的 MODIFIED 块。`ui-requests.ts` 用职责描述其内容，不标为「搬迁 helper」；它包含新代码和从 `#onFrame` 移出的回绝帧形状。
- 真实子进程的 argv 注入在新测试文件内包装 `createRealFakeRuntime(...).runtime.spawnImpl`（`server/test/session-supervisor-helpers.ts:87-121`），不修改 helper 本身。原因是 PR Boundary 只允许一个新测试文件。当前 helper `:98` 只追加 `--scenario`，不做 `yolo→write` 替换，父 tasks.md:8 所述的替换至今不存在（见 Open questions）。
- 审批形状的请求若在 writes 已关闭（原生退出后排空）时到达，不上抛也不写帧。这沿用 `process.ts:557` 既有的 `!#writesClosed` 闸门，避免 owner 为一个永远无法再应答的子进程登记 pending。

## Open questions（上报编排者，本刀不处理）
- **runtime 转接无归属**：supervisor 持有的是 `SessionRuntime`，拿不到 `OmpProcess`。把 `OmpProcess` 的 `approval` 事件经 `SessionRuntime` 转给 supervisor，并透传 `respondApproval`，需要改 `runtime.ts` 公开 API。本 issue 的 PR Boundary 禁止这样做；#462 的 scope 只有 `onExit` 与 `markPending/clearPending`；#464 的 PR Boundary 写明「不触碰 `omp/`」，其 Current behavior 却写「runtime 已能把审批 select 抛给 owner（2.1a）」。建议由 #462 承接（它本就扩展 runtime 构造选项与公开方法，新增 `onApproval` 选项与 `respondApproval` 透传，约 +10 行），或放宽 #464 的边界。
- #464 的 fixture 须自带 `yolo→write` 替换，或在其边界内扩展 `session-supervisor-helpers.ts:98`，因为该 helper 目前不做替换。

## Non-goals
- 生产 argv 切 `write`：2.1b #481。
- `markPending/clearPending` 空闲暂停与 runtime 转接：2.2a #462，见 Open questions。
- supervisor 落库、60s 计时、作答结算与超时应答 `respondApproval(id,"allow")`：4.3 #464。
- 停止路径的 Deny：4.2a #473。
- 非作答结算：4.6 #474。
- 归约器过滤：3.1 #455 已交付。
- 修正「审批挂起期间 idle 到期会回收」：#462。
