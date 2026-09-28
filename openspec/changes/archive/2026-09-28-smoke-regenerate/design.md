# Design: smoke-regenerate（#483）

本刀对应父设计 D3（重新生成）与 D8（受控上游的 `hasToolRole` 分支）。行号指 origin/master `fc6275b`。

篇幅超出模板，原因与 #482 相同：本刀要证明的是真实 omp 的事实，所以先写实测。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**：与 #482 E0 相同：
- Node 24.13.1 编译产物 `node server/dist/server.js`（先 `npm run build --workspace server`）；
- 真 omp 为 `var/omp/omp`（v18.0.10），`OMP_BIN` 指向 scratchpad 里的 tee 包装脚本，只记录 argv、stdin、stdout 并加时间戳；
- 上游是假上游 `fake-upstream.mjs`，密钥为 `fake`。二者之间加一个 scratchpad 日志代理，只记录每次上游请求的 `messages[].role`；
- Hurl 8.0.1，与 CI 相同。

草稿 = 当前 `chat.hurl` 紧接 `:81` 空行之后、`:82`（(4a) 注释）之前插入下文「Must add/change」的 4 个条目，放在 scratchpad，仓内文件未改。

**结果**
1. **草稿以 `make smoke` 的 argv 运行**（`skip_turn_control=false`，与 `public`/`auth`/`files` 同跑）：对同一个长驻服务连跑两遍（会话累积），均 exit 0。chat 部分每遍 36 个请求，分别约 8.2s、5.7s。
2. **首会话 regenerate 提出审批**：
   - 上游第 3 个请求（即 regenerate 回合的首个请求）的 roles 为 `["system","system","user"]`，`hasTool=false`，与首轮第 1 个请求相同；
   - 这说明 `branch` 把 omp 历史退回到了唯一用户消息之前，首轮的 toolResult 不在历史中，所以 `fake-upstream.mjs:112` 再次走 `toolFrames` 分支；
   - 新助手随即出现一条 pending bash 审批，(2b) 两遍都在 retry 1 命中，命中时 bash 步骤为 `running`。
3. **omp 侧帧序**（第一遍，会话 1 的 stdin/stdout）：
   - stdin 依次为 `get_branch_messages`、`branch{entryId}`、`get_state`、`prompt{message:"你好"}`；
   - `get_branch_messages` 只返回一项 `{text:"你好"}`，`branch` 返回 `{text:"你好",cancelled:false}`；
   - 之后是新的 `turn_start` 与 select（`Allow tool: bash\nCommand: echo workbuddy-smoke`）；
   - 两遍共 4 次 spawn，argv 都不含 `--resume`，每个会话一个 pid，即 regenerate 复用了首轮的存活进程。
4. **到达 done**：allow 返回 200，约 0.5s 后会话与新助手都是 `done`。
5. **消息与 id**（两遍一致）：

   | 遍 | 首轮 prompt 202 | (2a) 202 | (2d) 快照 |
   |---|---|---|---|
   | 1 | `userMessageId` 5、`assistantMessageId` 6，审批 1 | `assistantMessageId` 7 | 恰 `[5 user done, 7 assistant done]`；7 的审批恰一条 `(2,allow)`，步骤 `[(bash,done)]`，正文精确 |
   | 2 | 13、14，审批 5 | 15 | 恰 `[13 user, 15 assistant]`；审批 `(6,allow)`，bash done |

   旧助手行（6/14）及其审批（1/5）已级联删除。用户消息 id 不变。
6. **smoke-live 形态**：草稿以 `skip_turn_control=true`、`content_pattern=^.+$`、`min_bash_steps=0` 运行，exit 0，127 个请求约 60.8s。
   - 共 18 条记录 `Entry N has been skipped`：首轮作答 2 条、(1) 1 条、(2) 4 条、(4) 11 条；
   - 被跳过的条目引用了从未捕获的 `{{regen_assistant_id}}` 等变量，也不报错。
7. **变异与候选**（均跑后还原）：
   - m1：(2a) 加 `Content-Type: application/json`，红于 (2a)，`actual value is <400>`，共 10 个请求约 1.5s；
   - C1：把 `server/dist/sessions/store-branch.js` 中 regenerate 事务的 `DELETE` 替换为 `const deleted = { changes: 1 };`，即保留旧行并追加新行。
     - 约 96s 后红于 (2d)：`$.messages count` 实际 `<3>`、期望 `<2>`；`$.messages[1].id` 实际为旧 id `<2>`、期望 `<3>`；
     - 该快照中两个 assistant 都是 `done`、正文精确、bash `done`，所以 (2d) 其余断言都通过；
     - regenerate POST 只发出 1 次。
   - C2：把同一事务返回的 `assistantMessageId: Number(inserted.lastInsertRowid),` 替换为 `assistantMessageId: expectedAssistantId,`，即复用旧 id。
     - 立即红于 (2a)：`$.assistantMessageId != {{assistant_id}}`，实际 `<2>`；
     - 共 10 个请求约 3.6s，regenerate POST 只发出 1 次。
   - 还原：`npm run build --workspace server`，之后 `grep -c MUT` 为 0，`git status` 仅有本 change 目录。
8. **删去 (2c) 不会变红**：实测 exit 0，约 67s。(2d) 快照中审批 decision 为 `timeout`：60s 自动允许后回合照常 done。据此编排者裁定 (2d) 加断言 `decision == "allow"`，m2（删去 (2c)）证明其承重（proposal 偏离 3）。
9. **oracle 基线**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
10. 所有自起进程（服务、假上游、日志代理、omp 与 tee 包装）均已停止，`pgrep` 无残留。

## Change surface
只改 `smoke/chat.hurl`：在 (1)（`:74-80`）之后，紧接 `:81` 空行之后、`:82`（(4a) 注释）之前插入 (2a)–(2d)。

## Must preserve
- `chat.hurl:1-80` 与 `:82-251` 的既有条目与注释逐字不变：头注释、登录、首轮 prompt/作答/done、(1)、(4a)–(4k)、两次 logout、他账号 404、无 bearer 401。
- 首轮 prompt 条目（`:24-33`）不加 capture。`userMessageId` 的捕获归 #491（carry-forward :129）。
- 全局 `--retry 0`；POST 不带 per-entry retry；只有 messages GET 带有界 retry（主 spec verification-harness:7）。
- `Makefile:64` 与 `:99` 两条配方、`scripts/test-ci-harness.sh` 的 `contract()` 钉值、`ci.yml:66-92` 的 smoke job 与 uid-isolation job：均零 diff。
- smoke-live 的 90s 预算（done 轮询 `chat.hurl:64`）不变。新增条目在 smoke-live 下全部 skipped（E0-6）。

## Must add/change
(2a)–(2d) 全部带 `[Options] skip: {{skip_turn_control}}`。有 `Content-Type` 时，header 放在 `[Options]` 之前（Hurl 语法）。捕获变量不带 `2` 后缀，与 #482 的 `regen2_*` 区分。

| # | 条目 | 期望与断言 | retry |
|---|---|---|---|
| (2a) | `POST …/{{session_id}}/regenerate`，无 header、无 body | `HTTP 202`；捕获 `regen_assistant_id: jsonpath "$.assistantMessageId"`；`$.assistantMessageId != {{assistant_id}}` | 无 |
| (2b) | `GET …/{{session_id}}/messages` | 捕获 `regen_approval_id`（该助手 `approvals[0].id`）；对该助手：`approvals` count 1、`approvals[0].decision == null`、`tool == "bash"` | 40×500ms（<60s） |
| (2c) | `POST …/{{session_id}}/approvals/{{regen_approval_id}}`，JSON `{"decision":"allow"}` | `HTTP 200`；`$.id == {{regen_approval_id}}`、`$.decision == "allow"` | 无 |
| (2d) | `GET …/{{session_id}}/messages` | `$.session.status == "done"`；`$.messages` count 2；`[0].role == "user"`；`[1].role == "assistant"`；`[1].id == {{regen_assistant_id}}`；`[1].status == "done"`；`[1].content` matches `content_pattern`；`[1].steps[?(@.name=='bash')].status == "done"`；`[1].steps[?(@.status!='done')]` not exists；`[1].approvals[0].decision == "allow"`（编排者裁定：使 (2c) 作答成为承重断言——否则删去 (2c) 后 60s 超时自动 allow 仍全绿） | 180×500ms |

**反例如何被抓**（父 Scenario「重新生成用例」第二对 WHEN/THEN）：
- **保留旧助手行**：done 快照为 `[user, 旧 assistant, 新 assistant]`。(2d) 的 `count == 2` 红（实际 3）；`[1].id` 红（实际为旧 id）。E0-7 C1 实测。
- **追加第二助手行**：可观测形态与上一条相同，同样被 `count == 2` 与 `[1].id` 抓住。
- **复用旧 id**：(2a) 的 `!= {{assistant_id}}` 在 202 响应上即红，不进入轮询。E0-7 C2 实测。若服务端返回新 id、却把回合写回旧行，(2d) 的 `[1].id == {{regen_assistant_id}}` 红。
- **不重试 POST**：(2a) 无 per-entry retry，全局 `--retry 0`。C1/C2 下 regenerate POST 都只发出 1 次；只有 (2d) 这个 GET 在重试。

**预算**
- pending 轮询 (2b) 必须 <60s。否则迟到的首拍会读到 `timeout`，(2b) 的 `decision == null` 或 (2c) 的 200 会响亮地红，不会假绿。
- (2d) 与既有 done 轮询同为 180 次（≥90s）。

**插入位点**
- (2) 紧接 `:81` 空行之后、`:82`（(4a) 注释）之前：即 (1) 的 `body == ""`（`:80`）与其后空行之后，条目末尾再留一个空行。
- 若 #491 的 (3) 先合入，(2) 插在 (1) 与 (3) 之间；(3)、(4) 都不移动。

## Governing invariant
对已 done 首会话的 regenerate，必须在同一个真实 omp 进程上把历史退回到唯一用户消息之前，重新走审批与完成；完成后该会话恰有一条 user 与一条 assistant，且 assistant 就是 regenerate 返回的新行。全部新条目只在 `skip_turn_control=false` 时执行。

## Sibling surfaces
- **必然变红的既有测试**：无。只插入条目，既有条目逐字不变。服务端、web 与 oracle 不读 chat.hurl 内容（oracle 只钉配方 argv 与文件名）。
- **允许编辑的既有面**：仅 `smoke/chat.hurl`，只允许紧接 `:81` 空行之后、`:82`（(4a) 注释）之前插入 (2a)–(2d)。其它字节不动，头注释也不动（proposal 偏离 1）。
- **恒绿的消费者**：
  - `make smoke`（`Makefile:64`）；
  - `make smoke-live`（`:99`，新条目全部 skipped）；
  - CI smoke job 与 uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，只有 PR CI 能证明）；
  - `bash scripts/test-ci-harness.sh`。
- **下游**：#491 的 (3) fork 以首轮 `userMessageId` 为 fork 点，依赖 regenerate 不改用户消息 id（E0-5 实测不改）。本刀不钉此事（proposal 偏离 2）。
- **契约来源**（只消费、零 diff）：
  - `rest.ts:209-228` 的 regenerate：bodyless，202 `{assistantMessageId}`；带 body 或 `Content-Type: application/json` 空 body 时 400（carry-forward :109）；
  - `store-branch.ts:126-158` 的 `replaceLastAssistant`：删旧行，级联删步骤与审批，插新 running 行；
  - `fake-upstream.mjs:112` 的 `hasToolRole` 分支。

## Seams under test
- `make smoke` 的同一组 argv：真实编译服务 + 真 omp v18.0.10 + 假上游，调用方自起服务。本机与 CI 都走 `.github/scripts/ci-compiled-server.sh smoke`，其 env 见 `ci.yml:80-91`。
- smoke-live 形态：服务同上，`SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=<假上游>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`。门禁只检查非空，不需要真实密钥。
- 候选服务端变异（E3 C1/C2）：只改 gitignored 的编译产物 `server/dist/sessions/store-branch.js`，用 `npm run build --workspace server` 还原。不改 `server/src`。
- 上游 roles 与 omp 帧序证据（可选，归档用）：E0 的日志代理与 tee 包装 `OMP_BIN`。

## Required evidence
（R = 变异红，G = 守护、恒绿。服务端已全部合入，master 上不存在自然红基线，所以红证据用变异给出。）
- **E1 G**：两种形态都须 exit 0：(a) `ci-compiled-server.sh smoke` 调用两次（CI 形态，每次新起服务与上游）；(b) 对同一个调用方自起的服务连跑两遍 `make smoke`（会话累积，对应 issue「`make smoke` 连跑两次绿」）。PR body 附 `--very-verbose` 脱敏片段，须显示：
  - (2a) 请求头只有 Host/Accept/Cookie/User-Agent，无 `Content-Type`；202 `{"assistantMessageId":N}`，N ≠ 首轮 `assistant_id`；
  - (2b) 命中时新助手恰一条 pending bash 审批；
  - (2c) 200 allow；
  - (2d) 快照恰 `[user, assistant]`，`[1].id == N`，正文精确，bash `done`；
  - 既有 (1)、(4a)–(4k) 仍绿。
- **E2 G**：smoke-live 形态 exit 0（约 61s）。日志中首轮作答 2 条、(1)、(2a)–(2d)、(4a)–(4k) 共 18 条都为 `has been skipped`。
- **E3 R**：以下四条变异各跑一次，全部红，然后还原。hurl 失败输出原文附入 PR body：
  - m1：(2a) 加 `Content-Type: application/json` → 红于 (2a)，`actual value is <400>`；
  - C1：对编译产物执行替换
    - 原串 `const deleted = db.prepare("DELETE FROM chat_messages WHERE id = ?").run(expectedAssistantId);`
    - 新串 `const deleted = { changes: 1 };`
    - 期望：约 96s 后红于 (2d)，`count` 实际 `<3>`，`[1].id` 实际为旧 id；regenerate POST 只发出 1 次；
  - m2：删去 (2c) 作答条目 → 60s 自动允许后 decision 恒为 `timeout`，(2d) 重试至 180×500ms 预算耗尽，约 90s+ 后红于 (2d) 的 `decision == "allow"`（实际 `<timeout>`）；
  - C2：对编译产物执行替换
    - 原串 `assistantMessageId: Number(inserted.lastInsertRowid),`
    - 新串 `assistantMessageId: expectedAssistantId,`
    - 期望：立即红于 (2a) 的 `!=`；regenerate POST 只发出 1 次；
  - C1/C2 各需重启服务。完成后 `npm run build --workspace server` 还原，`git status` 只含本 change 与 `smoke/chat.hurl`。
- **E4 G**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`（与 E0-9 相同）。
- **E5 G**：`git diff --stat` 只含 `smoke/chat.hurl` 与本 change 目录；`grep -c 'skip: {{skip_turn_control}}' smoke/chat.hurl` = 14（#482 后现值）+ 4 = 18（#491 若先合入，再加其条目数）。
- **E6（仅 CI）**：PR CI 的 smoke 与 uid-isolation 两条 job 均绿。
- **E7 G**：`openspec validate smoke-regenerate --strict --no-interactive` 通过。

E0 已在草稿上实测过 E1(b)、E2、E3、E4。

## Non-goals
见 proposal。

## Review focus
1. 4 个新增条目都带 `skip`，且只有 messages GET 带 retry；regenerate 是 bodyless，没有 `Content-Type`。
2. (2d) 的 `$.messages count == 2` 与 `[1].id == {{regen_assistant_id}}` 是抓「保留旧行、追加第二助手」的唯二判别式：C1 快照里旧 assistant 同样 `done`、正文精确、bash `done`，`[1]` 上的其余断言都会通过。任何删除或放宽这两条的改动都不能接受。
3. (2a) 的 `!= {{assistant_id}}` 是抓「复用旧 id」的判别式，且 POST 无 retry。
4. (2b) 预算 <60s；插入位点在 (1) 与 (4a)（或 #491 的 (3)）之间，(4) 不移动，首轮 prompt 条目不动。
5. spec delta 只裁去 fork，且「重新生成用例」逐字取父文。
