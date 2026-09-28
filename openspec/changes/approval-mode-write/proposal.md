# Proposal: approval-mode-write（#481）

## Why
父 change `s1c-turn-control-governance` tasks 2.1b、8.1a、8.2a（epic #448，issue #481；组 2/组 8 的 Width exception merged-tasks 合为同一 PR）。

审批全链路已经在 master 上：识别与应答（#460）、登记/计时/作答（#464）、非作答结算（#474）、作答 REST（#468）、快照 `approvals`（#476）、审批条（#480）。但生产 argv 仍是 `--approval-mode yolo`（`server/src/sessions/omp/process.ts:79-80`），自 #85（`f455063`）起从未改过，所以生产上审批不可达（carry-forward 37）。

本刀做三件事：把 argv 切到 `write`；让 `make smoke` 作答首轮审批；让 `make ui-walk` 点 `允许`。

后两件是 argv 切换后真 omp 验证面保绿的唯一办法，已在本机实测：
- 只切 argv 时，未改的 `chat.hurl` 在 20.9s 后红在 `chat.hurl:42`（`running` ≠ `done`）；
- 未改的 ui-walk 两个 project 都红在 `ui-walk.spec.ts:308`（gate 停在 `armed`）；
- 反过来，argv 仍为 `yolo` 时，新的作答条目红在审批捕获（`No query result`）。
证据见 design「实测」E0。

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded（agree：生产 spawn argv 属 Critical Path 契约；受保护 Make 配方与 oracle 同步；真 omp 验证面首次经过审批链路）
Blast radius: argv 错，exec 工具要么被静默放行，要么每轮挂满 60s。smoke/ui-walk 作答写错，CI 的 smoke、ui-walk、uid-isolation 三条 job 一起红，或者靠 60s 自动允许假绿。oracle 漏钉，配方漂移没人发现。
Selected risk packs: Public API / CLI / script entry；Config / project setup；Auth / permissions / secrets；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: spawn 契约两处既有期望值改后全绿；`make test-guardrails`（oracle 新增 4 条拒绝变异）；`make smoke` 连跑两遍；`make ui-walk` 两个 project；`make check`；PR CI 的 smoke/ui-walk/uid-isolation 三条 job 全绿（design E1–E9）

## What Changes
- `server/src/sessions/omp/process.ts:80`：`"yolo"` → `"write"`，其它 argv/env 不动。
- `server/test/omp-process.test.ts:530`（`coldArgs`）与 `server/test/server-assembly.test.ts:658`（`ompArgs`）：期望值 `"yolo"` → `"write"`。只改这两个字面量，一共 14 个用例经它们断言，见 design Sibling surfaces。
- `smoke/chat.hurl`：在 prompt202 之后、done 轮询之前插入两个条目，都带 `[Options] skip: {{skip_turn_control}}`：
  - 审批轮询：有界 retry，直到 captured assistant 恰一条 pending `bash` 审批，捕获 `approval_id`；
  - allow POST：期望 200，`decision` 为 `allow`。
  - 既有 done 轮询 `retry: 40` → `retry: 180`（500ms 间隔，墙钟 ≥90s，覆盖 60s 自动允许窗口）。
- `Makefile`：`smoke` 配方加 `--variable "skip_turn_control=false"`，`smoke-live` 加 `--variable "skip_turn_control=true"`，都紧跟在各自的 `min_bash_steps` 变量之后。
- `scripts/test-ci-harness.sh`：
  - `contract()` 基线的两条 `recipes(...)`，以及所有锚串含旧配方的 `cm` 变异，同步更新；
  - 新增 4 条拒绝变异。
- `web/e2e/ui-walk-approval.ts`（新建）：放审批条走查步骤。`web/e2e/ui-walk.spec.ts` 只加 import 和两处调用，文件保持 ≤800 行。

## Capabilities
- MODIFIED omp-runtime「子进程 spawn 契约」：主 spec 原文为底，并入父 delta 的三部分：
  - argv `write`；
  - 「唯一审批模式值 / 仅 exec 档工具」句；
  - Scenario「参数与目录」的父文。
  父文末句「fork 的临时进程与 regenerate 取得的会话进程 SHALL 走同一 spawn 契约…」**不交付**，归 #465（4.4）/#466（4.5），见偏离 1。
- MODIFIED tool-approval「审批请求识别」：以主 spec 为底，只并入父 delta 首句「omp 子进程 SHALL 按 omp-runtime 修订后的 spawn 契约以 `--approval-mode write` 启动。」，该句由 #460 归档时明确留给 #481。三个 Scenario 保持主 spec 原样。
  - 这三个 Scenario 的 THEN 里，父文写的是 supervisor 收审批、落库、无 `approval.*` 事件等表述（#460 proposal「偏离」：留给 #464 归档时换回）。
  - #464 已交付这些行为，但归档时没有推进这些表述，属孤儿片段。它们不是本刀交付的行为，留待 #486 收尾对账，见 Open questions。
- MODIFIED chat-harness「手动真实上游冒烟入口」：父 delta 整块逐字，本刀全量交付。
- MODIFIED chat-harness「HTTP 冒烟对话用例」：主 spec 原文为底，并入父 delta 的以下部分：
  - 首轮作答句；
  - `skip` 模板句，裁去 regenerate 与回合控制条目；
  - 放宽轮询句；
  - 末句的变量子句，裁去 stop/regenerate/fork；
  - Note；
  - Scenario「审批作答后完成对话」（逐字）；
  - Scenario「smoke-live 跳过回合控制」（保留标题，THEN 裁到作答条目）。
  未交付的部分：回合控制 (1)–(4) 与 Scenario「停止用例」归 #482（8.1b），「重新生成用例」归 #483（8.1c），「分叉用例」归 8.1d。
- MODIFIED chat-harness「UI 走查对话步骤」：主 spec 原文为底，并入以下部分：
  - 父 delta 的作答子句，其中实现次序的括注按实测改写，见偏离 2；
  - 完成后 reload 仍 `已允许执行` 的子句；
  - 双 project 句，裁到审批与 reload 两步；
  - Scenario「审批条走查」（逐字）。
  停止、重新生成、分叉三步及其 Scenario 分别归 #484（8.2b）、#485（8.2c）、8.2d。

## Impact
- 生产行为：合入后每个 omp 子进程（首次与 `--resume`）都以 `--approval-mode write` 启动。首轮 bash 会显示审批条，60s 不操作则自动允许。实测 `write` 工具不触发审批（design E0-6）。
- CI 三条 job 都会走作答链路：`smoke`、`ui-walk`，以及 `uid-isolation`。`uid-isolation` 在 `ci-uid-isolation.sh:230` 以 `OMP_USER=omp` 跑 `ci-compiled-server.sh smoke`，也就是整套 `make smoke`，所以 sudo/setpriv 形态下同样作答。sudoers 尾参 `*`（`ci-uid-isolation.sh:42-43`；ADR-0010:55）已覆盖 argv 变化。三条 job 的工作流、env、超时都不改，不传 `OMP_MAX_PROCESSES`（oracle `check_wf` 钉住 env 列表，`test-ci-harness.sh:118`）。
- 零 diff 的文件：supervisor/store/REST/web src；`fake-omp.mjs`；`session-supervisor-helpers.ts` 与 `session-supervisor-pool-helpers.ts`；`ci.yml` 与 `.github/scripts/*`；`AGENTS.md`，其 HTTP smoke 证据行只列文件名，不含变量。
- 测试侧 argv 替换在 #481 后变成空操作，保持零改动、仍全绿（E1）：
  - `omp-approval-requests.test.ts:67` 与 `omp-runtime-exit-pending.test.ts:94` 的 `yolo→write` 替换；
  - `session-supervisor-pool-helpers.ts:69-73` 追加的 `--approval-mode write`，fake 取最后一个。
- 相邻 spec：
  - 并行 change `s1c-session-metadata-presentation` 以父 A 的「手动真实上游冒烟入口」为基线追加 `smoke/session-meta.hurl`（其 tasks.md:93 已预期 #481 改写同一配方与 oracle）。本刀对该块整块逐字取父文，归档后主 spec 与 B 的基线一致。
  - 主 spec verification-harness:7 的「仅 messages GET 允许有界 per-entry retry」「`make smoke` SHALL 传入 … `min_bash_steps=1`」在本刀后仍成立：新增的轮询是 messages GET，POST 不重试。
- 行数：
  - `process.ts` 759 不变；
  - `ui-walk.spec.ts` 当前 799 行，改后须 ≤800（AGENTS.md:107；`size-guard.sh` 不扫 `web/e2e`，此处是评审守卫）；
  - 新模块 ≤120 行；
  - `test-ci-harness.sh` 不在 size-guard 扫描范围。

## 偏离与决定
1. **fork/regenerate 同契约句不交付。** issue In Scope 写了「fork 临时进程与 regenerate 进程走同一契约」。但 fork（#466）与 regenerate（#465）仍为 OPEN，master 上没有这两条获取路径，无从断言。按 runbook「只放本 issue 交付的行为」，这句留给 #465/#466 在各自 fixture 中并入。现状下 `spawnOmp` 是唯一的 argv/env 组装点，`process.ts:70-126` 可证。
2. **UI 走查句中的实现次序括注按实测改写。** 父 delta 与父 design D8「事实」都写「real omp emits `tool_execution_start` before the wrapper's select」。实测相反：v18.0.10 在 13/13 次 write 模式 bash 回合里都**先**发 `extension_ui_request{method:"select"}`，**再**发 `tool_execution_start`，后者不等作答（E0-2）。
   - 「运行中 bash 步骤与审批条同时可见」这一结论仍然成立（E0-8），所以 issue 写的「不断言先后」正确；
   - 本 delta 把括注改为实测次序；
   - 归档 PR 应同步修正父 chat-harness delta 与父 design.md:103。
3. **`skip` 模板句与末句裁剪。** 这两句是部分交付：只放作答条目，回合控制条目归 8.1b/8.1c/8.1d。父文逐字列举了「both regenerates」「stop, regenerate and fork」，现在写进来会承诺未交付的条目，所以裁到作答条目。后续切片按父文整句替换。
4. **ui-walk 审批步骤放进新模块。** issue 的模块清单写的是 `web/e2e/ui-walk*.ts`，新文件在通配内。`ui-walk.spec.ts` 已 799 行，内联必超 800。为腾出行数，允许把`generatingStatus`（仅此一个） 原样搬到新模块，详见 design Sibling surfaces。

## Open questions（上报编排者）
- **carry-forward 81（infraFaulted 计时器）本刀后在生产可达。** pump infra-fault 且有 pending 审批时，60s 后仍会记一条 `timeout`（自动允许）审计，而工具从未执行。PR Boundary 禁止触碰 supervisor，本刀不修。建议在 #481 合入前后另开 issue。
- **carry-forward 84 已核对。** `process.ts` 的 argv 自 #85 起恒为 `yolo`：`git log -S'"write"' -- server/src/sessions/omp/process.ts` 为空，#474（`5ab634b`）早于本刀。所以任何部署库都不存在 #474 之前产生的 NULL 审批行，无需迁移。
- **OUT-OF-SCOPE：`make ui-shots` 在 #481 后会卡在审批。** `web/e2e/ui-shots.mjs:263-277` 的 `createDoneSession` 发一轮 prompt，只等 `已完成|失败`，上限 60s（`:29`）。首轮 bash 的审批要 60s 才自动允许，与这个上限几乎重合，chat-done 格大概率超时。`make ui-shots` 是 review-only 手工目标，不在本 PR 边界内。建议另开 issue，让它点 `允许`。
- **OUT-OF-SCOPE：fake-omp 审批场景的帧序与真实 omp 相反。** 主 spec omp-test-harness（`openspec/specs/omp-test-harness/spec.md:10`「mirroring real omp, where the agent loop emits `tool_execution_start` before the tool wrapper asks」）与 fake 实现，都是先 `tool_execution_start` 后 select；真实 v18.0.10 先 select 后 `tool_execution_start`（E0-2）。
  - 对 fake 的依赖：服务端全套件在 write argv 下只有 E1 的两处期望值失败（E0-9），说明服务端没有测试依赖 fake 的这个次序。
  - 真实次序下的服务端行为：allow、deny、timeout 三路在真实 omp 上都能正确收敛（E0-3/4/5）。
  - 风险：先 select 后 start 时，#473 的 Deny 会在 `tool_execution_start` 之前写出，这条路径只在真实 omp 上发生，fake 未覆盖。
  - **规范性表述也错**：主 spec `openspec/specs/tool-approval/spec.md:43`「审批事件」（父 delta `specs/tool-approval/spec.md:123`）写「omp 在 `tool_execution_start` 之后、工具执行之前下发审批 select，故该事件位于对应 `step.start` 之后」。生产上这句不成立：真实 omp 先 select，所以 `approval.request` 先于 `step.start` 发布（E0-2）。
  - 归属：#481 的归档 PR 修正父 design D8（`design.md:103`）与父 tool-approval:123 的措辞；另开新 issue 修正主 spec（tool-approval:43、omp-test-harness:10）与 fake-omp 的帧次序。
- **孤儿 spec 片段**：tool-approval「审批请求识别」三个 Scenario 的 THEN 中，父文 supervisor 级表述（「supervisor 收到审批请求」「无 `chat_approvals` 行、无 `approval.*` 事件」「仍落库为审批…流程与正常审批一致」）没有随 #464 归档推进，主 spec 仍是 #460 的 owner 级表述。它们与 carry-forward 82 同类，建议 #486 一并吸收。
- **仍未验证（carry-forward 38）**：select 挂起时真实 omp 遇到 stdin EOF 的行为。smoke 每条审批都作答，ui-walk 也点了 `允许`，所以本刀的验证面覆盖不到这条路径。
- 真实 omp 的 Approve 结束帧 `tool_execution_end` 带 `isError:false` 键，fake 不带（carry-forward 31）。归约只看 `isError===true`，实测结果为 done（E0-3），仅作记录。

## Non-goals
- chat.hurl 的停止/regenerate/fork 条目（8.1b #482、8.1c #483、8.1d），ui-walk 的停止/重新生成/分叉步骤（8.2b #484、8.2c #485、8.2d）。
- 新增 Make 目标、CI job 或 env；`OMP_APPROVAL_MODE` 之类回 yolo 的开关（父 design D8 否决）；sudoers 行变更。
- 清理测试侧已成空操作的 `yolo→write` 替换；fake-omp 帧序校正；infraFaulted 计时器；`ui-shots` 作答（均见 Open questions）。
- 文档（9.1 #486）。
