# Design: smoke-fork（#491）

本刀对应父设计 D4（fork = 用户消息处分叉，临时进程执行 branch，源会话文件不动、存活进程先 retire）与 D8（受控上游）。行号指 origin/master `9989d4b`。

篇幅超出模板，原因与 #482/#483 相同：本刀要证明的是真实 omp 的事实，所以先写实测。

## 实测（E0，2026-09-28，本机 darwin-arm64）
**条件**：与 #483 E0 相同：
- Node 24.13.1 编译产物 `node server/dist/server.js`（先 `npm run build --workspace server`）；
- 真 omp 为 `var/omp/omp`（v18.0.10）。`OMP_BIN` 指向 scratchpad 里的 Node tee 包装，把每个进程的 argv、stdin/stdout 逐行帧、stdin EOF 与退出码带时间戳写入 JSONL，原样转发给真 omp；
- 上游是假上游 `server/test/support/fake-upstream.mjs`，密钥 `fake`；Hurl 8.0.1，与 CI 相同。

草稿 = 当前 `chat.hurl` 在 `:30` 之后加 capture 行，并在 `:136` 空行之后、`:137` 之前插入下文「Must add/change」的 2 个条目，放在 scratchpad，仓内文件未改。

**结果**
1. **`make smoke` 的 argv**（`skip_turn_control=false`，与 `public`/`auth`/`files` 同跑）：对同一个长驻服务连跑两遍（会话累积），均 exit 0。chat 部分每遍 38 个请求，分别约 8.6s、6.3s。dist 变异还原后再跑一遍，仍 exit 0（66 个请求，8.0s）。
2. **HTTP 观察**（两遍一致）：

   | 遍 | 首轮 prompt 202 | (2a) 202 | (3a) 请求 | (3a) 201 | (3b) 200 |
   |---|---|---|---|---|---|
   | 1 | `{"userMessageId":1,"assistantMessageId":2}` | `{"assistantMessageId":3}` | `{"messageId":1}` | `{"session":{"id":<新>,"title":"你好","status":"idle",…},"draft":"你好"}`，约 611ms | `{"session":{…,"status":"idle"},"messages":[],"streamCursor":{"epoch":0,"seq":null}}` |
   | 2 | 9、10 | 11 | `{"messageId":9}` | 同上，约 633ms | 同上 |

   (3a) 请求头为 Host/Accept/Cookie/Content-Type(application/json)/User-Agent/Content-Length。regenerate 之后用户消息 id 不变，fork 以它为分叉点成功。
3. **omp 帧序**（第一遍，首会话；`<R>` 为运行目录）：
   - 首会话进程 w29123（argv 无 `--resume`）：首轮与 regenerate 回合完成后，regenerate 的 `get_state` 返回新文件 `…13-28-36-045Z_….jsonl`，服务端采纳它；
   - fork 时该进程只收到 stdin EOF（4468ms），4501ms 以退出码 0 退出，其间未收到任何帧；
   - 临时进程 w29238 在 4552ms spawn（晚于源进程退出），argv 为 `--resume <R>/…13-28-36-045Z_….jsonl`，即 regenerate 采纳的文件；
   - 临时进程帧序：`get_branch_messages` → `{"messages":[{"entryId":"f45b4d87","text":"你好"}]}`（**恰一条用户 entry，ordinal 0**；entryId 不同于 regenerate 前的 `ac717cf0`，说明被放弃的分支不在当前 branch 上）→ `branch{entryId:"f45b4d87"}` → `{"text":"你好","cancelled":false}` → `get_state` → 新文件 `…13-28-37-637Z_….jsonl`（≠ 源文件）→ stdin EOF（5040ms）→ 退出码 0（5053ms）；
   - 第二遍同形：源进程 w29333 退出（10921ms）→ 临时进程 w29404 spawn（10970ms，`--resume` regenerate 采纳的 `…13-28-42-464Z_….jsonl`）→ `get_branch_messages` 恰一条 `{"entryId":"af5e30d9","text":"你好"}` → branch `{text:"你好",cancelled:false}` → 退出（11501ms）。
   - 结论（carry-forward :132）：已 regenerate 的首会话上，真 omp v18.0.10 的 fork 返回 201、`draft=="你好"`，临时进程 `get_branch_messages` 在 ordinal 0 恰有一条用户 entry。临时进程在 201 返回前已退出。
4. **smoke-live 形态**：草稿以 `skip_turn_control=true`、`content_pattern=^.+$`、`min_bash_steps=0` 运行，exit 0，128 个请求约 61s。共 20 条 `Entry N has been skipped`（entry 4、5、7–24），其中 entry 12、13 为 (3a)、(3b)。首轮 prompt 条目（entry 3）照常执行，`user_message_id` 照常捕获。
5. **hurl 变异**（对同一服务，均跑后删除草稿）：
   - m1：(3a) body 改为 `{"messageId":{{regen_assistant_id}}}`（存在、但为 assistant 行）→ 红于 (3a) `HTTP 201`，`actual value is <400>`，响应 `bad_request`；16 个请求约 2.6s，fork POST 只发出 1 次；
   - m2：删去 (3a) 的 `Content-Type: application/json` 行 → **全绿**（38 个请求，6.3s）。`--very-verbose` 显示请求仍带 `Content-Type: application/json`：Hurl 8.0.1 对 JSON 字面 body 自动补该 header。故「缺 Content-Type」不是可构造的红证据（proposal 偏离 4）；
   - m3：(3a) header 改为 `Content-Type: text/plain` → 红于 (3a) `HTTP 201`，`actual value is <400>`，响应 `bad_request`；16 个请求约 2.6s。
6. **服务端候选变异**（必交，proposal 偏离 6；各自重启服务，完成后 `npm run build --workspace server` 还原，`grep` 确认原串恢复、变异串为 0）：
   - C1：`server/dist/sessions/store-branch.js` 的 `FORK_HISTORY` 中 `AND id < ?))` → `AND id <= ?))`，即连分叉点 user 消息一起拷贝。201 仍为 `draft:"你好"`、`status:"idle"`（未拷贝 assistant），**只有** (3b) 红：`$.messages count` 实际 `<1>`、期望 `<0>`；17 个请求约 4.8s；
   - C2：同一 SQL 的 `AND (created_at < ? OR (created_at = ? AND id < ?))` → `AND (? IS NOT NULL OR ? IS NOT NULL OR ? IS NOT NULL)`，即拷贝整段历史。红于 (3a)：`$.session.status` 实际 `<done>`、期望 `<idle>`；16 个请求约 4.8s。
7. **oracle 基线**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
8. 所有自起进程（服务、假上游、omp 与 tee 包装）均已停止，`pgrep` 无残留；`git status` 只有本 change 目录。

## Change surface
只改 `smoke/chat.hurl`：
- `:29-30` 首轮 prompt 条目的 `[Captures]` 块，在 `assistant_id` 行之后加一行；
- 紧接 `:136` 空行之后、`:137`（(4) 第二会话注释）之前插入 (3a)–(3b)。

## Must preserve
- `chat.hurl:1-30`、`:31-136`、`:137-306` 的既有条目与注释逐字不变（除上述一行 capture）：头注释、登录、首轮 prompt 的请求/状态码/两条 `exists` 断言、首轮作答与 done、(1)、(2a)–(2d)、(4a)–(4k)、两次 logout、他账号 404、无 bearer 401。
- 全局 `--retry 0`；POST 不带 per-entry retry；只有 messages GET 带有界 retry（主 spec verification-harness:7）。
- `Makefile:64` 与 `:99` 两条配方、`scripts/test-ci-harness.sh` 的 `contract()` 钉值、`ci.yml:66-92` 的 smoke job 与 uid-isolation job：均零 diff。
- smoke-live 的 90s 预算（done 轮询 `chat.hurl:64`）不变；新增条目在 smoke-live 下全部 skipped（E0-4）。

## Must add/change
(3a)–(3b) 全部带 `[Options] skip: {{skip_turn_control}}`；header 放在 `[Options]` 之前（Hurl 语法）。

| # | 条目 | 期望与断言 | retry |
|---|---|---|---|
| 首轮 prompt（既有） | `[Captures]` 加 `user_message_id: jsonpath "$.userMessageId"` | 不变 | 无 |
| (3a) | `POST …/{{session_id}}/fork`，`Content-Type: application/json`，body `{"messageId":{{user_message_id}}}` | `HTTP 201`；捕获 `fork_session_id: jsonpath "$.session.id"`；`$.draft == "你好"`；`$.session.status == "idle"` | 无 |
| (3b) | `GET …/{{fork_session_id}}/messages` | `HTTP 200`；`$.messages` count 0；`$.session.status == "idle"` | 无（fork 在 201 前已提交） |

不对 fork 会话发 prompt；(4) 以后的条目仍只用 `session_id`/`session2_id`，他账号 404 仍读首会话。

**反例如何被抓**（父 Scenario「分叉用例」未点名反例，以下为本刀自列）：
- **首轮 id 取错或 regenerate 改了用户行**：fork 400 或 404，(3a) `HTTP 201` 红（m1 同形）。
- **临时进程对齐失败**（omp 当前分支含两条用户 entry、或 text 不等）：服务端 502，(3a) `HTTP 201` 红。E0-3 实测真 omp 恰一条。
- **拷贝了分叉点**：201 仍 idle、draft 正确，只有 (3b) `count == 0` 能抓（C1）。
- **拷贝了分叉点之后的历史**：新会话 status 取末条 assistant 的 `done`，(3a) `status == "idle"` 红（C2）；(3b) 的 count 同样红。
- **不重试 POST**：(3a) 无 per-entry retry、全局 `--retry 0`；m1/m3/C1/C2 下 fork POST 都只发出 1 次。

**插入位点**
- (3) 紧接 `:136` 空行之后、`:137` 之前：即 (2d) 最后一条断言（`:135`）与其后空行之后，条目末尾再留一个空行。(2)、(4) 都不移动。

## Governing invariant
对已 regenerate 的首会话，以首轮捕获的用户消息 id fork，真实 omp 必须经临时进程在唯一用户 entry 处分叉并返回其文本；新会话以 idle、零消息落地，且不对它发 prompt。全部新条目只在 `skip_turn_control=false` 时执行。

## Sibling surfaces
- **必然变红的既有测试**：无。只插入条目并在一个既有 `[Captures]` 块加一行；服务端、web 与 oracle 不读 chat.hurl 内容（oracle 只钉配方 argv 与文件名）。
- **允许编辑的既有面**：仅 `smoke/chat.hurl`，只允许两处：
  1. `:30` 之后插入 `user_message_id: jsonpath "$.userMessageId"` 一行；
  2. 紧接 `:136` 空行之后、`:137` 之前插入 (3a)–(3b)。
  - 其它字节不动，头注释也不动（proposal 偏离 2）。出现其它破坏时，停下上报。
- **恒绿的消费者**：`make smoke`（`Makefile:64`）；`make smoke-live`（`:99`，新条目全部 skipped，首轮 capture 照常执行）；CI smoke job 与 uid-isolation job 的 smoke 阶段（`ci-uid-isolation.sh:230`，只有 PR CI 能证明）；`bash scripts/test-ci-harness.sh`。
- **契约来源**（只消费、零 diff）：
  - `server/src/sessions/rest.ts:228-244` 的 fork 路由与 `:357-371` 的 `parseForkMessageId`：严格 `{messageId}`，201 `{session, draft}`；
  - `server/src/sessions/branching.ts:189-325` 的 `Forks`：源进程先 retire、临时进程三条命令、`draft = branched.text`；
  - `server/src/sessions/store-branch.ts:160-234` 的 `copyForkHistory`：分叉点严格之前的历史，未拷贝消息时 `idle`。
- **下游**：ui-walk 分叉走查（8.2d）与本刀无共享文件。

## Seams under test
- `make smoke` 的同一组 argv：真实编译服务 + 真 omp v18.0.10 + 假上游，调用方自起服务。本机与 CI 都走 `.github/scripts/ci-compiled-server.sh smoke`，env 见 `ci.yml:80-91`。
- smoke-live 形态：服务同上，`SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=<假上游>/v1 MODEL_UPSTREAM_API_KEY=fake make smoke-live`。
- 真 omp 帧证据：`OMP_BIN` 指向 tee 包装（E0 条件）。注意服务端给 omp 的 env 是白名单，包装的日志路径须写死在脚本里，不能靠 env 传入。
- 候选服务端变异（必交）：只改 gitignored 的编译产物 `server/dist/sessions/store-branch.js`，用 `npm run build --workspace server` 还原。不改 `server/src`。

## Required evidence
（R = 变异红，G = 守护、恒绿。服务端已全部合入，master 上不存在自然红基线，红证据用变异给出。）
- **E1 G**：两种形态都须 exit 0：(a) `ci-compiled-server.sh smoke` 调用两次（CI 形态，每次新起服务与上游）；(b) 对同一个调用方自起的服务连跑两遍 `make smoke`（会话累积）。PR body 附 `--very-verbose` 脱敏片段，须显示：
  - 首轮 prompt 202 `{"userMessageId":U,…}` 与 `user_message_id: U` 捕获；
  - (3a) 请求头含 `Content-Type: application/json`、body `{"messageId":U}`；201 `draft:"你好"`、`session.status:"idle"`；
  - (3b) 200 `"messages":[]`、`session.status:"idle"`；
  - 既有 (1)、(2a)–(2d)、(4a)–(4k) 仍绿。
- **E2 G（omp 帧，carry-forward :132 义务）**：tee 包装下跑一遍 `make smoke` 形态，PR body 附首会话 fork 段的脱敏帧摘录，须显示：
  - 源进程只收 stdin EOF 并退出，之后临时进程才 spawn；
  - 临时进程 argv 含 `--resume <regenerate 采纳的文件>`；
  - `get_branch_messages` 应答恰一条 `{entryId, text:"你好"}`；
  - `branch` 应答 `{text:"你好",cancelled:false}`；`get_state` 新文件 ≠ 源文件；
  - 临时进程在 201 之前退出（由代码保证：`server/src/sessions/branching.ts` 的 `#fork` 先 `await stopQuietly(runtime)` 再进 `#commit`；帧日志与 Hurl 不同钟，不作为「须显示」项）。
- **E3 G**：smoke-live 形态 exit 0（约 61s）。日志中共 20 条 `has been skipped`，含 (3a)、(3b)。
- **E4 R**：以下两条 hurl 变异各跑一次，全部红，然后还原。hurl 失败输出原文附入 PR body：
  - m1：(3a) body 改为 `{"messageId":{{regen_assistant_id}}}` → 红于 (3a)，`actual value is <400>`；
  - m3：(3a) header 改为 `Content-Type: text/plain` → 红于 (3a)，`actual value is <400>`。
  - 另附 m2（删去 `Content-Type` 行 → 绿）的一行说明：Hurl 自动补 header，不作为红证据。
- **E5 R（编排者裁定必交）**：C1、C2 服务端候选变异（E0-6），期望同 E0-6；完成后 build 还原，`git status` 只含本 change 与 `smoke/chat.hurl`。
- **E6 G**：`bash scripts/test-ci-harness.sh` 为 `812 PASS / 0 FAIL`。
- **E7 G**：`git diff --stat` 只含 `smoke/chat.hurl` 与本 change 目录；`git diff smoke/chat.hurl` 只有新增行（1 + (3) 两条目），0 删除；`grep -c 'skip: {{skip_turn_control}}' smoke/chat.hurl` = 18 + 2 = 20。
- **E8（仅 CI）**：PR CI 的 smoke 与 uid-isolation 两条 job 均绿。
- **E9 G**：`openspec validate smoke-fork --strict --no-interactive` 通过。

E0 已在草稿上实测过 E1(b)、E2、E3、E4、E5、E6。

## Non-goals
见 proposal。

## Review focus
1. 首轮 prompt 条目只多一行 capture，其请求、状态码与断言未动；capture 名为 `user_message_id`。
2. (3a)、(3b) 都带 `skip`，都无 retry；(3a) body 用 `{{user_message_id}}`，不是硬编码或 `assistant_id`。
3. (3b) 的 `count == 0` 是抓「拷贝分叉点」的唯一判别式（C1 下 201 与 status 全绿）；(3a) 的 `status == "idle"` 抓「拷贝整段历史」（C2）。删除或放宽任一条都不能接受。
4. 插入位点在 (2d) 与 (4) 之间，(2)、(4) 不移动；不对 fork 会话 prompt。
5. spec delta 块与父 delta 逐字一致，删去主 spec 过渡分句有据（proposal 偏离 3）。
