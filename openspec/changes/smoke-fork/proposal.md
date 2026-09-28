# Proposal: smoke-fork（#491）

## Why
父 change `s1c-turn-control-governance` tasks 8.1d（epic #448，issue #491）。

fork 的服务端链路已全部在 master 上：fork REST（#469，JSON body `{messageId}`，201 `{session, draft}`）、源进程先 retire → 临时进程 `--resume` → `get_branch_messages → branch → get_state` → 单事务插入新会话并拷贝分叉点之前的历史（#466）。这条链路只有 fake-omp 的 inject/supervisor 测试，真 omp 上从未被任何 harness 覆盖。

本刀在 chat.hurl 次序 (3) 补上它，并且作用于**已 regenerate 的首会话**（carry-forward :132）：
- 该会话的 omp 文件是 regenerate 后从 `get_state` 采纳的新文件，树上留有一条被放弃的分支；
- 临时进程 `--resume` 它之后，`get_branch_messages` 须只返回当前分支上的一条用户 entry（ordinal 0，`text` 为「你好」），否则服务端按序号/文本对齐失败 502；
- 首轮 `userMessageId` 必须在 regenerate 后仍指向该会话唯一的用户行。

本 fixture 已在真 omp v18.0.10 上实测，结果见 design「实测」。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：与 #482/#483 同一共享入口；chat.hurl 由 `make smoke`、`make smoke-live`、CI smoke 与 uid-isolation 四个入口共享；真 omp 临时进程 `--resume` + `branch` 路径首次被 harness 覆盖）
Blast radius: 条目写错时 CI smoke 与 uid-isolation 两条 job 一起红；skip 漏写时 smoke-live 大概率照样绿（(2) 被跳过后首会话仍 done、仅一条「你好」，fork 前提成立），防线是 E3（20 条 `has been skipped`）与 E7（`grep -c` = 20）；capture 写错则 fork 400；少了 count/status 断言，拷贝了分叉点或整段历史的服务端也能假绿
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 本地真 omp + 假上游 `ci-compiled-server.sh smoke` 两次、同一服务 `make smoke` 连跑两遍，均绿；smoke-live 形态（假上游）绿且 20 个 skip 条目全部 skipped；两条 hurl 变异（m1、m3）与两条候选服务端变异（C1、C2）红；omp 帧日志证明临时进程 `get_branch_messages` 恰一条 `你好`；`bash scripts/test-ci-harness.sh` 恒绿；PR CI smoke 与 uid-isolation 绿

## What Changes
改动只在 `smoke/chat.hurl`：
- **首轮 prompt 条目加一行 capture**（`chat.hurl:29-30` 的 `[Captures]` 块内，`assistant_id` 之后）：`user_message_id: jsonpath "$.userMessageId"`。该条目的请求、状态码与两条 `exists` 断言不变。
- **(3)**：插在 (2d)（`chat.hurl:119-135`）之后，紧接 `:136` 空行之后、`:137`（(4) 第二会话注释）之前，共 2 个条目，design 编号 (3a)–(3b)：
  1. (3a) `POST …/{{session_id}}/fork`，`Content-Type: application/json`，body `{"messageId":{{user_message_id}}}` → exact 201；捕获 `fork_session_id`；断言 `draft == "你好"`、`session.status == "idle"`；
  2. (3b) `GET …/{{fork_session_id}}/messages` → 200，`messages` count 0，`session.status == "idle"`。
- 两条都带 `[Options] skip: {{skip_turn_control}}`，都不带 retry；不对 fork 会话发 prompt。条目逐条形状见 design「Must add/change」。

## Capabilities
- MODIFIED chat-harness「HTTP 冒烟对话用例」：本刀交付该 requirement 的最后一段，整块逐字取父 delta。与当前主 spec（#483 归档后）恰五处差异：
  - `skip` 模板句回合控制括注补 fork；
  - 次序句插入 (3) 段；
  - 末句括注取父文（随之删去主 spec 的过渡分句「including the second session's follow-up prompt,」，见偏离 3）；
  - 新增 Scenario「分叉用例」（置于「重新生成用例」之后）；
  - Scenario「smoke-live 跳过回合控制」THEN 补 fork。
  - 主 spec 既有六个 Scenario 全部保留。归档后父块与主 spec 逐字一致，该 requirement 无剩余父文差异。
- 不涉及其它 capability：turn-control「从此处分叉 REST」已由 #466/#469 归档，本刀只消费。

## Impact
- `make smoke`：chat.hurl 从 36 个请求增至 38 个，本机实测 6.3–8.6s（E0-1）；fork 请求自身约 0.6s（临时进程 spawn + 三条命令）。
- `make smoke-live`：新增 2 个条目 skipped，实测 128 个请求约 61s（E0-4），90s 预算不变。
- omp 进程：每遍多一次临时进程 spawn（fork 前先 retire 首会话存活进程，E0-3），进程上限不变。
- 零 diff：`Makefile`、`scripts/test-ci-harness.sh`（oracle 只钉配方 argv 与文件名，不读 chat.hurl 内容）、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web。
- CI 消费者：smoke job（`ci.yml:66-92`）；uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，只有 PR CI 能证明）。

## 偏离与决定
1. **capture 放在首轮 prompt 条目，而不是 (3) 自己的 GET**（carry-forward :129 给了两个选项）：
   - issue In Scope 与 Key interfaces 原文点名「首轮 prompt 202 新增 capture `user_message_id`」；
   - #483 design「Must preserve」明确把这一 capture 留给 #491，属预期编辑；
   - 只在既有 `[Captures]` 块加一行，不新增请求，不改任何断言；另起 GET 取 `$.messages[0].id` 要多一个请求，而且依赖 regenerate 之后的快照次序；
   - 该条目在 smoke-live 下不 skip，capture 照常执行；它与既有 `$.userMessageId exists` 同源，不引入新失败面（E0-4 实测）。
   - 这是本刀唯一一处对既有条目的编辑，在 PR Boundary「仅 `smoke/chat.hurl`」之内。
2. **文件头注释不改**：`chat.hurl:1-4` 只列步骤，「回合控制」已涵盖 (3)。与 #483 偏离 1 同。
3. **末句括注随父文删去「including the second session's follow-up prompt,」**：这是 #483 为过渡保留的主 spec 措辞，父文终态不含。本刀交付整块，按 runbook 须与父块逐字一致；被删信息仍由 Scenario「smoke-live 跳过回合控制」逐项列出（「including the second session's stop, regenerate and follow-up prompt」），语义不丢。
4. **`Content-Type: application/json` 显式写出，但不承重**：Hurl 8.0.1 对 JSON 字面 body 自动补该 header（E0-6 m2 实测：删去后请求仍带 `Content-Type: application/json`，全绿）。显式写出是沿用 `chat.hurl:26/51` 的惯例。「缺 Content-Type → 400」这一变异在 Hurl JSON body 下造不出来，改用 m3（`Content-Type: text/plain` → 400）证明 content-parser 归属。
5. **(3b) 不带 retry**：fork 在 201 之前已提交事务、临时进程已退出（主 spec turn-control「从此处分叉 REST」末句），立即读取是更强的断言；主 spec verification-harness 只允许 GET 重试，不要求。
6. **服务端候选变异 C1/C2 为必交证据（编排者裁定）**：父 Scenario「分叉用例」未点名反例，但 C1 是 (3b) `count == 0` 承重的唯一证据。E0 已实测二者分别红于 (3b) count 与 (3a) status。
7. Makefile、oracle、CI 零 diff，与 issue 一致。

## Orchestrator decisions
- 末句括注采用父文（删去主 spec 过渡分句「including the second session's follow-up prompt,」）：本刀整块交付，块须与父 delta 逐字一致；该信息仍由 Scenario「smoke-live 跳过回合控制」逐项列出。
- C1/C2 服务端候选变异为必交证据（C1 是 (3b) `count == 0` 承重的唯一证据）。
- (3b) 不带 retry：fork 在 201 前已提交。
- carry-forward 追加：Hurl 对 JSON 字面 body 自动补 `Content-Type: application/json`（「缺 header」不能作红证据）；分叉会话复制源标题（与 ui-walk 同名侧栏项同源）。

## Non-goals
- (1)(4) 停止条目（8.1b #482，已合入）；(2) regenerate 条目（8.1c #483，已合入）；ui-walk 的分叉走查（8.2d）。
- 对 fork 会话发 prompt，或断言其 `--resume <新文件>` 能续聊（turn-control Scenario「池满与临时进程释放」由 inject/supervisor 测试覆盖）。
- slash prompt 下 fork draft 与存储文本不一致（carry-forward :107，#494/#495）；本刀 prompt 为纯文本「你好」。
- 源会话文件字节不变的真 omp 证明（carry-forward :107 已记录 `--resume F` 不改写 F）。
- Makefile 配方、`scripts/test-ci-harness.sh`、CI 工作流、新 Make 目标/job/env；server 与 web 任何改动。
