# Proposal: smoke-regenerate（#483）

## Why
父 change `s1c-turn-control-governance` tasks 8.1c（epic #448，issue #483）。

regenerate 的服务端链路已全部在 master 上：regenerate REST（#467，bodyless 202 `{assistantMessageId}`）、`get_branch_messages → branch → get_state → CAS 事务 → prompt`（#465/#466）。真 omp 上它只被 #482 的第二会话条目覆盖过，而那条是「被停止回合」上的 regenerate。

「已 done、历史里已有 tool result 的首会话」上的 regenerate 还没有真 omp 证据：
- `branch` 能否把 omp 历史退回到唯一用户消息之前；
- 受控上游能否因此再次发出 bash 调用（`hasToolRole` 为假）；
- 旧助手行能否被替换，而不是保留或追加。

本刀补上 chat.hurl 次序 (2)。本 fixture 已在真 omp 上实测，结果见 design「实测」。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：与 #482 同一共享入口；chat.hurl 由 `make smoke`、`make smoke-live`、CI smoke 与 uid-isolation 四个入口共享；真 omp `branch` 路径在已完成会话上首次覆盖）
Blast radius: 条目写错时，CI 的 smoke 与 uid-isolation 两条 job 一起红；skip 漏写时 smoke-live 必红；bodyless POST 若带 `Content-Type` 则恒 400；少了 count/id 断言，保留旧行或追加第二助手的服务端也能假绿
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 本地真 omp + 假上游 `ci-compiled-server.sh smoke` 两次、同一服务 `make smoke` 连跑两遍，均绿；smoke-live 形态（假上游）绿且新条目全部 skipped；两条 hurl 变异（m1、m2）与两条候选服务端变异（C1、C2）红（design E3）；`bash scripts/test-ci-harness.sh` 恒绿；PR CI smoke 与 uid-isolation 绿

## What Changes
改动只在 `smoke/chat.hurl`，只插入条目，既有条目逐字不动：
- **(2)**：在 (1)（当前 `chat.hurl:74-80`）之后，紧接 `:81` 空行之后、`:82`（(4a) 注释）之前，共 4 个条目，design 编号 (2a)–(2d)：
  1. 首会话 regenerate，期望 202，新 id 不同于首轮助手；
  2. 轮询到新助手恰一条 pending bash 审批；
  3. allow，期望 200；
  4. 轮询到 done，断言恰 `[user, assistant]`，assistant 的 id 等于 regenerate 捕获值，正文精确匹配，bash 步骤 done。
- 若 #491 的 (3) 先合入，(2) 插在 (1) 与 (3) 之间。(4) 不移动。
- 条目逐条形状见 design「Must add/change」。全部新增条目都带 `[Options] skip: {{skip_turn_control}}`；POST 不重试，只有 messages GET 带有界 retry。
- 新 capture：`regen_assistant_id`（issue「Key interfaces」）、`regen_approval_id`。二者不与 #482 的 `regen2_*` 冲突。

## Capabilities
- MODIFIED chat-harness「HTTP 冒烟对话用例」：以当前主 spec 为底（#482 归档后的文本，含 (1)、(4) 与「停止用例」），并入父 delta 的以下部分：
  - 回合控制次序句的 (2) 段，逐字，插在 (1) 与 (4) 之间；
  - Scenario「重新生成用例」，两对 WHEN/THEN 全部逐字，放在「停止用例」之后、「smoke-live 跳过回合控制」之前；
  - `skip` 模板句的审批作答括注，逐字取父文「for the first prompt and for both regenerates below」（本刀交付后已全量成立）；
  - 三处按交付裁剪（只裁去 fork）：
    - `skip` 模板句的回合控制括注；
    - 末句括注；
    - Scenario「smoke-live 跳过回合控制」的 THEN。
  - 空出的部分：(3) fork 与 Scenario「分叉用例」归 #491（8.1d）。
  - 主 spec 既有的四个 Scenario 保持原样。
- 不涉及其它 capability：turn-control「重新生成 REST」与 tool-approval「审批作答 REST」「审批快照」已由 #467/#465/#466 归档，本刀只消费。

## Impact
- `make smoke`：chat.hurl 从 30 个请求约 4.7s（#482 E1），增至本机实测 36 个请求约 5.7–8.2s（E0-1）。
- `make smoke-live`：预算不变。新增 4 个条目全部 skipped，实测约 61s 通过，与 #482 E2 相同（E0-6）。
- 零 diff：`Makefile`、`scripts/test-ci-harness.sh`（oracle 只钉配方 argv 与文件名，不读 chat.hurl 内容）、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web。
- CI 消费者：
  - smoke job（`ci.yml:66-92`）；
  - uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，`OMP_USER=omp` 形态下跑 `ci-compiled-server.sh smoke`）。只有 PR CI 能证明。
- 最坏墙钟：hurl 在首个失败条目处停止该文件，单次失败最多多出一个 90s 轮询。smoke job 的 10 分钟超时不变。

## 偏离与决定
1. **文件头注释不改**：`chat.hurl:1-4` 已按 #482 改写为只列步骤、不写条目数，其中「回合控制」已涵盖 (2)。
2. **(2d) 不断言用户消息 id 或正文**：父 THEN 只要求恰一 user、一 assistant。首轮 `userMessageId` 的捕获归 #491（carry-forward :129），本刀不改首轮 prompt 条目。E0 实测 regenerate 保留用户消息 id（5→5、13→13），#491 的 fork 依赖这一点，但本刀不钉它。见 Open questions。
3. **(2d) 断言 `[1].approvals[0].decision == "allow"`（编排者裁定）**：父文未要求，#482 的 (4i) 也未断言；但 design E0-8 实测删去 (2c) 后约 60s 以 `timeout` 自动允许、全文件仍绿，作答不承重。加此一行后 m2（删去 (2c)）红于 (2d)。
4. **E3 含两条候选服务端变异**：它们改动 gitignored 的 `server/dist`，跑完用 build 还原，仓内零 diff。这超出了 #482 只做 hurl 变异的先例。原因：父 Scenario 第二对 WHEN 点名的反例（保留旧行、追加第二助手、复用旧 id）是服务端行为，任何 hurl 改动都造不出来。
5. Makefile、oracle、CI 零 diff，与 issue 一致，无偏离。

## Orchestrator decisions（原 Open questions，已裁定）
- (2d) 不加 `$.messages[0].content == "你好"`：#491 的 fork 条目自己断言 `draft == "你好"`，YAGNI。
- (2d) **加** `[1].approvals[0].decision == "allow"`：实测删去 (2c) 后审批 60s 超时自动 allow、全文件仍绿，作答 POST 不承重；加一行即令其承重（design E3 m2）。这与 DECISION #482（不加首轮 allow 落库 GET）不冲突：本条是 (2) 自身终态快照上的一个断言，不新增请求。（4i）同形缺口记入 carry-forward，不在本刀修。
- C1/C2 服务端候选变异：列为 implementer 必交证据（父 Scenario 点名的三种反例只能由服务端行为构造）。

## Non-goals
- (3) fork 条目（8.1d #491）；(1)(4) 停止条目（8.1b #482，已合入）；ui-walk 的停止、重新生成、分叉（8.2b–8.2d）。
- Makefile 配方、`scripts/test-ci-harness.sh`、CI 工作流、新 Make 目标/job/env；server 与 web 任何改动。
- 首轮 `userMessageId` 捕获（#491）；首轮 allow 落库断言（DECISION #482）。
- 已回收进程上的 regenerate（`--resume` spawn）与该路径上真 omp 能否提审批（#494/#495）：本刀的 regenerate 复用存活进程（E0-3）。
