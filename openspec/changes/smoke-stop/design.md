# Design: smoke-stop（#482）

本刀对应父设计 D2（停止）、D3（重新生成）、D5（停止先 Deny）与 D8（第二会话即确定性 running 点）。行号指 origin/master `46a5bdd`。

篇幅超出模板，原因与 #481 相同：本刀要证明的是真实 omp 的事实，所以先写实测。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**：环境与 CI smoke job 相同：
- Node 24.13.1 编译产物 `node server/dist/server.js`；
- 真 omp 为 `var/omp/omp`（v18.0.10），`OMP_BIN` 指向 scratchpad 里的 tee 包装脚本，只记录 stdin/stdout 并加时间戳；
- 上游是假上游 `fake-upstream.mjs`，密钥为 `fake`；
- Hurl 8.0.1，与 CI 相同。

草稿 = 当前 `chat.hurl` 加上下文「Must add/change」的全部条目，放在 scratchpad，仓内文件未改。

**结果**
1. **草稿以 `make smoke` 的 argv 运行**（`skip_turn_control=false`，与 `public`/`auth`/`files` 同跑）：对同一个长驻服务连跑两遍（会话累积），均 exit 0。chat 部分每遍 30 个请求，约 4.7s。
2. **stop 落点**：用 curl 探针单独跑第二会话流程 11 次，外加草稿 3 遍。
   - 11/11 次探针的首个 pending 命中快照中，bash 步骤都已是 `running`；草稿 3 遍的 (4c) 都在 retry 1 命中（(4c) 同时断言两者，只能证明组合条件成立）；
   - stop 恒为 202 `{}`，约 100ms 后快照为：会话与助手都是 `stopped`，`content` 为 `""`，唯一审批 `deny`，bash 步骤 `failed`，无 `running` 步骤；
   - 从未出现 `done` 或 `failed`。
3. **真 omp 帧序**：select 与 `tool_execution_start` 同毫秒发出。之后 stdin 依次收到：
   1. `{"type":"extension_ui_response",…,"value":"Deny"}`；
   2. 1ms 后 `{"type":"abort"}`。

   omp 随即依次发出：
   1. `tool_execution_end{isError:true}`（结果为 `Tool call denied by user: bash`）；
   2. toolResult；
   3. 第二个 `turn_start`；
   4. 空 content 的 assistant 消息（`stopReason:"aborted"`）；
   5. `agent_end`；
   6. abort 的 response。

   全程约 30ms，远在 8s grace（`turn-control.ts:15`）之内，没有走 retire 回退（`commands.ts:7-8`，5s+3s）。
4. **stopped 会话上的 regenerate**：
   - 202，`assistantMessageId` 为新 id；
   - 新助手再次出现一条 pending bash 审批，allow 后 200，随后 done；
   - messages 恰为 `[user, assistant]`，assistant 的 id 等于捕获值，正文为精确回复，bash 步骤 done；
   - 没有出现 502，说明被停止回合的用户消息确实留在 omp 历史中，branch 对齐成功；
   - 整轮只 spawn 了会话 1 与会话 2 两个 omp 进程，24 个 argv 记录都不含 `--resume`，即 regenerate 复用了存活进程。
5. **再 prompt**：202，然后 done，正文匹配，不产生审批。原因是历史中已有 toolResult，`fake-upstream.mjs:112` 的 `hasToolRole` 为真。
6. **Hurl 形状**（8.0.1 实测可用）：
   - bodyless POST：`--very-verbose` 显示请求头只有 Host/Accept/Cookie/User-Agent，无 `Content-Type`、无 `Content-Length`，请求体为空；
   - `body == ""` 可断言 204，`body == "{}"` 可断言 202；
   - `jsonpath "$.assistantMessageId" != {{assistant2_id}}` 可用；
   - `…steps[?(@.name=='bash')].status == "failed"` 可用：单节点会被解包，若有两个 bash 步骤，比较对象变成数组，断言即失败；
   - `jsonpath "$.messages" count == 2`、`$.messages[0].role`、`$.messages[1].id` 可用。
7. **smoke-live 形态**：草稿以 `skip_turn_control=true`、`content_pattern=^.+$`、`min_bash_steps=0` 运行，exit 0，约 61s。
   - 新增 12 个条目（(1) 与 (4a)–(4k)）加上首轮作答 2 条，共 14 条，全部记录 `Entry N has been skipped`；
   - 被跳过的条目引用了从未捕获的 `{{session2_id}}` 等变量，也不报错。
8. **oracle 基线**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。

## Change surface
只改 `smoke/chat.hurl`：
- `:1-4` 头注释改写；
- 在 `:72`（首轮 done 轮询末行）与 `:74`（本账号 logout）之间插入 (1) 与 (4)。

## Must preserve
- `chat.hurl:6-72` 与 `:74-107` 的既有条目逐字不变：登录、建会话、prompt、首轮作答、`retry: 180` 的 done 轮询、两次 logout、他账号 404、无 bearer 401。
- 全局 `--retry 0`；POST 不带 per-entry retry；只有 messages GET 带有界 retry（主 spec verification-harness:7）。
- `Makefile:64` 与 `:99` 两条配方、`scripts/test-ci-harness.sh` 的 `contract()` 钉值、`ci.yml:66-92` 的 smoke job 与 uid-isolation job：均零 diff。
- smoke-live 的 90s 预算（done 轮询 `chat.hurl:64`）不变。新增条目在 smoke-live 下全部 skipped，不占预算（E0-7）。

## Must add/change
(1) 与 (4) 的全部条目都带 `[Options] skip: {{skip_turn_control}}`。有 `Content-Type` 时，header 放在 `[Options]` 之前（Hurl 语法）。捕获变量名以 `2` 为后缀，与 8.1c/8.1d 的首会话捕获不冲突。

| # | 条目 | 期望与断言 | retry |
|---|---|---|---|
| (1) | `POST …/{{session_id}}/stop`，无 header、无 body | `HTTP 204`；`body == ""` | 无 |
| (4a) | `POST /api/sessions` | `HTTP 201`；捕获 `session2_id`；`$.status == "idle"` | 无 |
| (4b) | `POST …/{{session2_id}}/prompt`，JSON `{"message":"你好"}` | `HTTP 202`；捕获 `assistant2_id` | 无 |
| (4c) | `GET …/{{session2_id}}/messages` | 捕获 `approval2_id`；对该助手：`approvals` count 1、`approvals[0].decision == null`、`tool == "bash"`、`steps[?(@.name=='bash')].status == "running"`（偏离 1） | 40×500ms（<60s） |
| (4d) | `POST …/{{session2_id}}/stop`，bodyless | `HTTP 202`；`body == "{}"` | 无 |
| (4e) | `GET …/messages` | `$.session.status == "stopped"`；对该助手：`status == "stopped"`、`approvals` count 1、`approvals[0].id == {{approval2_id}}`、`decision == "deny"`、`steps[?(@.status=='running')]` not exists、`steps[?(@.name=='bash')].status == "failed"` | 180×500ms |
| (4f) | `POST …/{{session2_id}}/regenerate`，bodyless | `HTTP 202`；捕获 `regen2_assistant_id`；`$.assistantMessageId != {{assistant2_id}}` | 无 |
| (4g) | `GET …/messages` | 捕获 `regen2_approval_id`；对新助手：`approvals` count 1、`decision == null`、`tool == "bash"` | 40×500ms（<60s） |
| (4h) | `POST …/approvals/{{regen2_approval_id}}`，JSON `{"decision":"allow"}` | `HTTP 200`；`$.id == {{regen2_approval_id}}`、`$.decision == "allow"` | 无 |
| (4i) | `GET …/messages` | `$.session.status == "done"`；`$.messages` count 2；`[0].role == "user"`；`[1].role == "assistant"`；`[1].id == {{regen2_assistant_id}}`；`[1].status == "done"`；`[1].content` matches `content_pattern`；`[1].steps[?(@.name=='bash')].status == "done"`；`[1].steps[?(@.status!='done')]` not exists | 180×500ms |
| (4j) | `POST …/{{session2_id}}/prompt`，JSON `{"message":"你好"}` | `HTTP 202`；捕获 `followup2_assistant_id` | 无 |
| (4k) | `GET …/messages` | `$.session.status == "done"`；该助手 `status == "done"`、content matches `content_pattern`。不断言审批，也不断言 bash 计数 | 180×500ms |

**预算**
- pending 轮询 (4c)/(4g) 必须 <60s。否则迟到的首拍会读到 `timeout`：stop 会变成 204，或 allow 得到 409。两者都是响亮的红，不会假绿。
- 其余轮询与既有 done 轮询同为 180 次（≥90s），覆盖 stop 的最坏情况：8s grace 加 retire 的 5s+3s。
- **插入位点**：当前 (1) 紧跟 `:72`，(4) 紧跟 (1)，logout 在 (4) 之后。
  - 8.1c（#483）的 (2) 插在 (1) 与 (4a) 之间；
  - 8.1d（#491）的 (3) 插在 (2)（若 8.1c 尚未合入则为 (1)）之后、(4a) 之前；
  - (4) 自身不移动。
- **头注释**：`chat.hurl:2-3` 改写为：登录 → 首轮 prompt/作答/done → 回合控制（仅 `skip_turn_control=false`）→ 他账号 404 → 无 bearer 401。只列步骤，不写条目数，以便 8.1c/8.1d 追加时仍然成立。

## Governing invariant
第二会话的 stop 必须落在「审批 pending、bash running」的真实 omp 回合上，并收敛为 `stopped`，不得是 `failed` 或 `done`。随后的 regenerate 必须在同一 omp 历史上对齐成功。全部新条目只在 `skip_turn_control=false` 时执行。

## Sibling surfaces
- **必然变红的既有测试**：无。只追加条目，既有条目逐字不变。服务端、web 与 oracle 不读 chat.hurl 内容（oracle 只钉配方 argv 与文件名）。
- **允许编辑的既有面**：仅 `smoke/chat.hurl`，只允许两类改动：`:1-4` 注释改写，以及在 `:72`/`:74` 之间插入新条目。其它字节不动。
- **恒绿的消费者**：
  - `make smoke`（`Makefile:64`）；
  - `make smoke-live`（`:99`，新条目全部 skipped）；
  - CI smoke job 与 uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，只有 PR CI 能证明）；
  - `bash scripts/test-ci-harness.sh`。
- **契约来源**（只消费、零 diff）：
  - `rest.ts:189-206` 的 stop：非 running 时 204，否则 202 `{}`；有 body 时 400；
  - `rest.ts:208-226` 的 regenerate：202 `{assistantMessageId}`；
  - `turn-control.ts` 的 `#run`：先 Deny、再 abort；
  - `fake-upstream.mjs:112` 的 `hasToolRole` 分支。

## Seams under test
- `make smoke` 的同一组 argv：真实编译服务 + 真 omp v18.0.10 + 假上游，调用方自起服务。本机与 CI 都走 `.github/scripts/ci-compiled-server.sh smoke`，其 env 见 `ci.yml:80-91`。
- smoke-live 形态：服务同上，`SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=<假上游>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`。门禁只检查非空，不需要真实密钥。
- 帧序证据（可选，归档用）：E0 的 tee 包装 `OMP_BIN`。

## Required evidence
（R = 变异红，G = 守护、恒绿。服务端切片均已合入，master 上不存在自然红基线，所以红证据用变异给出。）
- **E1 G**：两种形态都须 exit 0：(a) `ci-compiled-server.sh smoke` 调用两次（CI 形态，每次新起服务与上游）；(b) 对同一个调用方自起的服务连跑两遍 `make smoke`（会话累积，对应 issue「`make smoke` 连跑两次绿」）。PR body 附 `--very-verbose` 片段，须显示：
  - (1) 204、空 body；
  - (4c) 命中时 pending 且 bash `running`；
  - (4d) 202 `{}`，请求头无 `Content-Type`；
  - (4e) `stopped`/`stopped`/`deny`/bash `failed`；
  - (4f) 202，新 id；
  - (4h) 200 allow；
  - (4i) 恰 2 条消息、捕获 id、精确正文；
  - (4k) done。
- **E2 G**：smoke-live 形态 exit 0（约 61s）。日志中 (1)、(4a)–(4k) 以及首轮作答两条都为 `has been skipped`。
- **E3 R**：以下三条变异各跑一次，全部红，然后还原：
  - (4d) 加 `Content-Type: application/json` → 红于 (4d)，`actual value is <400>`；
  - (4f) 加 `Content-Type: application/json` → 红于 (4f)，`<400>`；
  - 删去 (4d) → 约 93s 后红于 (4e)：`session.status` 为 `done` 而非 `stopped`，`decision` 为 `timeout` 而非 `deny`。这证明不 stop 时 60s 自动允许无法满足该轮询。

  E0 已在草稿上实测过这三条。
- **E4 G**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`（与 E0-8 相同）。
- **E5 G**：`git diff --stat` 只含 `smoke/chat.hurl` 与本 change 目录；`grep -c 'skip: {{skip_turn_control}}' smoke/chat.hurl` = 2（首轮作答）+ 12（新增）= 14。
- **E6（仅 CI）**：PR CI 的 smoke 与 uid-isolation 两条 job 均绿。
- **E7 G**：`openspec validate smoke-stop --strict --no-interactive` 通过。

## Non-goals
见 proposal。

## Review focus
1. 每个新增条目都带 `skip`，且只有 messages GET 带 retry；stop/regenerate 是 bodyless，没有 `Content-Type`。
2. (4e) 同时断言会话与助手都是 `stopped`（排除 `failed`/`done`）、审批 `deny` 且 id 等于 `approval2_id`、无 running、bash `failed`。
3. (4i) 断言恰 2 条消息，且 assistant 的 id 等于 regenerate 捕获值，旧助手行不能留下。
4. 两个 pending 轮询的预算都 <60s；插入位点允许 8.1c/8.1d 按编号插入而不移动 (4)。
5. spec delta 的三处裁剪没有承诺首会话 regenerate/fork。
