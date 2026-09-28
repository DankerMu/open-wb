# Proposal: smoke-stop（#482）

## Why
父 change `s1c-turn-control-governance` tasks 8.1b（epic #448，issue #482）。

停止的服务端链路已全部在 master 上：stop REST（#475，运行中 202 `{}`、空闲 204）、派发前停止意图（#490）、派发后停止先 Deny 再 abort（#473）、非作答结算（#474）、regenerate REST（#467，bodyless 202 `{assistantMessageId}`）。这些都只经 fake-omp 证明。

真 omp 的 `make smoke` 里还没有 stop 条目。本刀补上 chat.hurl 的两段：
- 次序 (1)：已 done 的首会话 stop → 204；
- 次序 (4)：第二会话审批挂起时 stop → stopped → regenerate → 再 prompt。

这是本 change 唯一由真实 omp v18.0.10 证明的事实：被停止回合的用户消息仍在 omp 历史里，regenerate 能对齐成功（issue「Review priority」）。本 fixture 已在真 omp 上实测，结果见 design「实测」。

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded（agree：真 omp 验证面首次覆盖 stop 与 stopped 会话上的 regenerate；chat.hurl 由 `make smoke`、`make smoke-live`、CI smoke 与 uid-isolation 四个入口共享）
Blast radius: 条目写错时，CI 的 smoke 与 uid-isolation 两条 job 一起红；skip 漏写时 smoke-live 必红；bodyless POST 若带 `Content-Type` 则恒 400；断言过松会让 `failed`/`done` 冒充 `stopped`
Selected risk packs: Public API / CLI / script entry；Concurrency / shared state / ordering；Resource limits / large input / discovery；Legacy compatibility / examples；Error handling / rollback / partial outputs
Evidence floor: 本地真 omp + 假上游 `ci-compiled-server.sh smoke` 两次、同一服务 `make smoke` 连跑两遍，均绿；smoke-live 形态（假上游）绿且新条目全部 skipped；三条变异红（design E3）；`bash scripts/test-ci-harness.sh` 恒绿；PR CI smoke 与 uid-isolation 绿

## What Changes
改动只在 `smoke/chat.hurl`，只追加条目，既有条目逐字不动：
- **(1)** 紧接首轮 done 轮询（当前 `chat.hurl:61-72`）之后：`POST …/{{session_id}}/stop`，bodyless，期望 exact 204、`body == ""`。
- **(4)** 紧接 (1) 之后、本账号 logout（当前 `chat.hurl:74`）之前，共 11 个条目（design 编号 (4a)–(4k)）：
  - 建第二会话 201，prompt 202；
  - 轮询至 pending 审批，stop 202 `{}`，轮询至 stopped；
  - regenerate 202，轮询至 pending 审批，allow 200，轮询至 done；
  - 再 prompt 202，轮询至 done。
- 条目逐条形状见 design「Must add/change」。全部新增条目都带 `[Options] skip: {{skip_turn_control}}`；POST 不重试，只有 messages GET 带有界 retry。
- `chat.hurl:1-4` 的文件头注释改写为当前流程（纯注释，见 design Sibling surfaces）。

## Capabilities
- MODIFIED chat-harness「HTTP 冒烟对话用例」：以主 spec 为底，并入父 delta 的以下部分：
  - 回合控制次序句的 (1) 与 (4) 两段，逐字；
  - Scenario「停止用例」，逐字；
  - 三处按交付裁剪：
    - `skip` 模板句：审批作答条目裁到首轮与第二会话 regenerate，回合控制条目裁到 stop 与第二会话条目；
    - 末句括注；
    - Scenario「smoke-live 跳过回合控制」的 THEN。
  - 空出的部分：(2) 首会话 regenerate 与 Scenario「重新生成用例」归 #483（8.1c），(3) fork 与 Scenario「分叉用例」归 #491（8.1d）。
  - 主 spec 既有的三个 Scenario 保持原样。
- 不涉及其它 capability：turn-control、tool-approval 的服务端契约已由 #475/#467/#473/#474 归档，本刀只消费。

## Impact
- `make smoke`：本地实测 chat.hurl 从约 1.6s（#481 E0-7）增至 30 个请求约 4.7s（E1）。
- `make smoke-live`：预算不变。新增 12 个条目全部 skipped，实测约 61s 通过，与 #481 E4 相同（E2）。
- 零 diff：`Makefile`、`scripts/test-ci-harness.sh`（oracle 只钉配方 argv 与文件名，不读 chat.hurl 内容）、`ci.yml`、`.github/scripts/*`、`AGENTS.md`、server、web。
- CI 消费者：
  - smoke job（`ci.yml:66-92`）；
  - uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，`OMP_USER=omp` 形态下跑 `ci-compiled-server.sh smoke`）。只有 PR CI 能证明。
- 最坏墙钟：hurl 在首个失败条目处停止该文件，所以单次失败最多多出一个 90s 轮询。smoke job 的 10 分钟超时不变。

## 偏离与决定
1. **第二会话 pending 轮询多一条断言**：`steps[?(@.name=='bash')].status == "running"`。
   - 父文只要求「恰一条 pending 审批」。真实 omp 先发 select、同毫秒再发 `tool_execution_start`（#481 E0-2）；而审批事件绕过 pump（carry-forward 80），快照理论上可能先有审批行、后有 bash 步骤。
   - 加这一条后，stop 一定落在「bash 步骤已 running、审批 pending」上。它比父文更严，不改变规范，spec 文本不变。
   - 实测 11/11 次探针的首个 pending 命中即 bash `running`；草稿 3 遍 (4c) 均在 retry 1 命中（E0-2）。
2. **文件头注释改写**：`chat.hurl:2-3` 自 #481 起已过时（carry-forward 92）。本刀追加的条目让它更不准确，所以同刀改写。纯注释，在 PR Boundary（仅 `smoke/chat.hurl`）之内。
3. **不加** carry-forward 92 建议的「done 后 skip 模板 GET 断言首轮 `approvals[0].decision == "allow"`」。它不在 #482 In Scope 内，首轮 allow 已由作答 POST 的 200 body 断言。是否另加，见 Open questions。
4. Makefile、oracle、CI 零 diff，与 issue 一致，无偏离。

## Orchestrator decisions（原 Open questions，已裁定）
- carry-forward :92 首轮 `decision=="allow"` 落库断言：不做（YAGNI；落库由单测覆盖，smoke 以 allow 200 证明作答）。
- carry-forward :94 resumed 真 omp 提审批：仍归 #494/#495（本刀 regenerate 复用存活进程，无 `--resume` spawn）。
- 真 omp 在 Deny 与 abort 之间多开一轮空 assistant（`stopReason:"aborted"`）：服务端仍收敛为 `stopped`；记入 carry-forward，与 #620（fake-omp 帧序）同类，本刀不处理。

## Non-goals
- 首会话 regenerate 条目 (2)（8.1c #483）与 fork 条目 (3)（8.1d #491）；ui-walk 停止/重新生成/分叉（8.2b–8.2d）。
- Makefile 配方、`scripts/test-ci-harness.sh`、CI 工作流、新 Make 目标/job/env；server 与 web 任何改动。
- 真实上游（DMXAPI）下的 smoke-live 验证、`--resume` 路径、多审批回合（#494/#495）。
