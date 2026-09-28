# Design: approval-mode-write（#481）

父设计 D5（argv）、D8（harness 在 write 模式下的确定性）。行号指 origin/master `f1b08c2`。

篇幅超出 20–40 行，原因有二：
- 本刀的关键事实只能来自真实 omp v18.0.10，先把实测结果写下来；
- Required evidence 须逐条可执行。

## 实测（E0，2026-09-27，本机 darwin-arm64）
**条件**
- omp 用 `var/omp/omp`（`omp/18.0.10`，非 brew），上游是仓内假上游 `server/test/support/fake-upstream.mjs`，未使用任何真实密钥。
- 服务端是 Node 24.13.1 编译产物（`node server/dist/server.js`），env 与 CI smoke/ui-walk job 相同。`OMP_BIN` 指向 scratchpad 里的包装脚本：它用 `/usr/bin/tee` 记录 stdin/stdout 后，再以 `var/omp/omp "$@"` 执行真实 omp。
- `process.ts:80` 临时改为 `write` 并重新 build；实测后已还原，`git status` 只剩本 change 目录。

**结果**（E0-1 至 E0-8 是真实 omp 结果，E0-9 至 E0-11 是基线与构造性检查）
1. **argv**：记录到的是 `--mode rpc --cwd … --session-dir … --model workbuddy/deepseek-v4.1-flash --approval-mode write --no-extensions --no-lsp --no-pty --no-title`。
2. **select 是否出现、形状与次序**：会出现，逐字为 `{"type":"extension_ui_request","id":"1590b888e2595ae8","method":"select","title":"Allow tool: bash\nCommand: echo workbuddy-smoke","options":["Approve","Deny"]}`。
   - `id` 是 16 位 hex，每次不同；
   - 过 #460 识别谓词，`tool` 解析为 `bash`。
   - 次序固定为 `message_end(toolUse)` → **select** → `tool_execution_start(bash)`：13/13 次 write 回合相同，yolo 回合无 select。
   - `tool_execution_start` 不等作答就发出：在未作答的超时实测回合里，stdout 第 17 帧就是它，而此时 stdin 尚无任何应答，快照中 bash 步骤为 `running`、审批 `decision:null`。
   - 另有非审批的 `extension_ui_request{method:"setWidget"}`：启动时一次、回合末一次，host 照旧回 `cancelled:true`。
3. **Approve**：stdin 写出 `{"type":"extension_ui_response","id":…,"value":"Approve"}`，随后 omp 依次发 `tool_execution_update`×2、`tool_execution_end{isError:false}`、第二轮文本、`agent_end`。
   - REST 计时：`POST …/approvals/1 {"decision":"allow"}` → 200，六键 body 含 `decision:"allow"`；
   - POST 后约 0.2s 快照为 done：正文 `你好，这是 WorkBuddy 的第一条流式回复。`，bash 步骤 `done`。
   - 探针时间戳（从脚本起点计）：allow 路径 pending 快照 2.94s、POST 返回 3.00s；deny 路径（E0-5）0.81s、0.87s。即从命中 pending 到 POST 返回约 60ms。
4. **不作答（超时）**：约 60.9s 后 host 写出 `value:"Approve"`，审批 `decision:"timeout"`，回合 done。此后 `POST allow` → **409** `{"error":{"code":"approval_settled","message":"该审批已处理"}}`。
5. **deny**：200 `decision:"deny"`，bash 步骤 `failed`，回合 done，正文同上。
6. **write 工具**：prompt 含 `WORKBUDDY_WRITE`（`fake-upstream.mjs:112-116` 首轮改发 `write` 调用）。结果无审批 select，`approvals:[]`，`write` 步骤 done。eval/browser/task 未实测：假上游只能编排 bash 与 write。
7. **Hurl 8.0.1**（与 CI `ci-install-hurl.sh` 同版本），对 scratchpad 中的 chat.hurl 草稿：
   - `[Options] skip: {{skip_turn_control}}` 可用：`false` 时执行，`true` 时日志为 `Entry N has been skipped`；被跳过的 POST 引用了未捕获的 `{{approval_id}}` 也不报错。
   - Hurl 会把单节点结果解包：`…approvals[*]" count == 1` 报 `invalid filter input type … object`，不可用；`…approvals" count == 1` 可用。
   - `skip_turn_control=false` 时：`public`+`auth`+草稿+`files` 连跑两遍均 exit 0，草稿 13 个请求约 1.6s；审批轮询首拍在 select 之前，重试 1 次命中。
   - `skip_turn_control=true`（`content_pattern=^.+$`、`min_bash_steps=0`）时：审批两条目被跳过，done 轮询重试 119 次（约 61s）后经 `timeout` 自动允许通过。
8. **浏览器**：Playwright chromium 对编译 web 做探针，两个视口相同。
   - 点击前：`group` 名为 `需要你的确认`，内含 `bash` 徽章、title 全文、`（60s 内未操作将自动允许）` 与 `允许`/`拒绝`；`status` 名为 `bash 运行中`，二者同时可见；此时 gate 为 **`armed`**，末轮尚未开始。
   - 点 `允许` 后：两按钮立即 `disabled`，约 20ms 后组名变为 `已允许执行`（组内无按钮）；约 100ms 后 gate 为 `held`，`bash 已完成` 可见。
   - release 后正文完整；reload 后 `已允许执行` 组有 1 个，`需要你的确认` 为 0。
   - 走查增加的墙钟不足 0.2s。
   - **整套 `make ui-walk`**：在 `ui-walk.spec.ts:307` 后临时插入上述步骤（等待两者可见、断言 `armed`、点 `允许`、等 `已允许执行` 与 `bash 已完成`），并在 `:334` 后断言 `已允许执行` 组为 1、`需要你的确认` 为 0。结果 3 passed（13.8s）：
     - 旅程用时 desktop-light 6.4s、mobile-dark 6.6s，单测上限 30s；审批步骤 161ms/156ms；
     - `walkScrollFollow` 四步、侧栏/欢迎屏、设置、登出与 error oracle 全绿，已结算的审批条留在助手 article 中不影响它们；
     - 实测后已还原。
9. **红基线**（只切 argv，不改 harness）：
   - `make smoke`：`public`/`auth`/`files` 绿，`chat.hurl` 在 44 个请求、20.9s 后红于 `:42`（`actual running / expected done`）；
   - `make ui-walk`：两个 project 都红于 `ui-walk.spec.ts:308`（`Expected "held" / Received "armed"`）；
   - 服务端全套件：只有 14 例失败，全部来自 `omp-process.test.ts:530` 的 `coldArgs` 与 `server-assembly.test.ts:658` 的 `ompArgs`。把这两个字面量也改为 `write` 后，两文件 29/29 绿。
10. **反向红**：argv 仍为 `yolo` 时，草稿的审批轮询在 40 次重试后红于捕获 `approval_id`，报错 `No query result`。
11. **oracle 基线**：`bash scripts/test-ci-harness.sh` 为 `808 PASS / 0 FAIL`。

## Change surface
- `process.ts:79-80`：`"--approval-mode","yolo"` → `"write"`。
- `chat.hurl`：`:24-33`（prompt202）与 `:35` 的 done 轮询之间插入两个条目；done 轮询 `retry: 40` → `180`。
- `Makefile`：`:64` 与 `:99` 各加一个 `--variable`。
- `test-ci-harness.sh`：`:92` 的 `contract()` 与 `:121` 起的 `cm` 变异族同步。
- `web/e2e/ui-walk-approval.ts`：新建。
- `ui-walk.spec.ts`：`:286-340` 的 `walkHeldDialogue` 加两处调用。

## Must preserve
- `--resume` 规则、env 白名单与 sudo 前缀（`process.ts:86-121`）、四目录（`:59-66`）；`spawnOmp` 仍是唯一的 argv 组装点。
- chat.hurl 的既有条目：
  - 登录/创建/prompt/done 断言（`:7-46`）、他账号 404、无 bearer 401 逐字不变；
  - prompt POST 不重试；全局 `--retry 0`；只有 messages GET 带 per-entry retry（主 spec verification-harness:7）。
- `smoke-live` 只跑 `smoke/chat.hurl`，缺配置时的门禁与 clean env 不变（`Makefile:95-99`）。
- ui-walk 的既有 held-gate 流程：
  - `ui-walk.spec.ts:308-337` 的顺序，以及 `expectRunningPrefix` 的 `bash 运行中|已完成` 二选一（`:740-743`）；
  - release 到完成之间禁止 messages GET（`:318-327`）；
  - error oracle 恰两次 `/api/auth/me` 401；
  - `walkScrollFollow`、侧栏、设置、登出段不改：E0-8 在整套 `make ui-walk` 中实测，这些段在已结算审批条存在时仍全绿。

## Must add/change
**smoke：审批轮询条目**（插在 prompt202 之后）
```
GET …/messages
[Options] skip: {{skip_turn_control}} / retry: 40 / retry-interval: 500ms
[Captures] approval_id: jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].id"
[Asserts]
  jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals" count == 1
  jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].decision" == null
  jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].tool" == "bash"
```
轮询预算约 20s，**必须小于 60s**：否则一条迟到的首拍会读到 `timeout` 而不是 pending，从而掩盖故障。

**smoke：allow POST 条目**
```
POST …/approvals/{{approval_id}}
Content-Type: application/json   （header 在 [Options] 之前，Hurl 语法）
[Options] skip: {{skip_turn_control}}
body {"decision":"allow"}
HTTP 200
  jsonpath "$.id" == {{approval_id}}
  jsonpath "$.tool" == "bash"
  jsonpath "$.decision" == "allow"
```
无 per-entry retry。

**smoke：done 轮询**：`retry: 180`、`retry-interval: 500ms`，墙钟 ≥90s。实测 `true` 路径 61s 通过，余量约 30s，用于吸收真实模型的首尾延迟。

**Make 配方**
- `smoke`：在 `--variable "min_bash_steps=1"` 之后插入 ` --variable "skip_turn_control=false"`；
- `smoke-live`：在 `--variable "min_bash_steps=0"` 之后插入 ` --variable "skip_turn_control=true"`；
- 其它字节不变。

**oracle 同步**
- `contract()` 中 `recipes("smoke", […])` 与 `recipes("smoke-live", […])` 的 hurl 行；
- 所有查找/替换串含旧配方片段的 `cm`。按标签锚定，不按行号：
  - 当前清单：`contract Make Hurl connection mutation`、`contract Make smoke min-bash-steps mutation`、`contract Make smoke whitespace duplicate mutation`、`contract Make smoke protected-first multi-target mutation`、`contract Make recipe comment mutation`、`contract Make conditional mutation`、`contract Make smoke-live whitespace duplicate mutation`、`contract Make smoke-live recipe mutation`、`contract Make smoke-live min-bash-steps mutation`、`contract Make smoke-live env mutation`、`contract Make smoke-live recipe comment mutation`、`contract Make smoke-live protected-first multi-target mutation`；
  - 兜底：`ed()`（`:113`）在锚串计数 ≠1 时退出 2，`cm` 记 `FAIL … missing anchor`。所以任何报 missing anchor 的 `cm` 都须同步。
- 新增 4 条拒绝变异：
  - `smoke` 删去该变量；
  - `smoke` 改为 `=true`；
  - `smoke-live` 删去该变量；
  - `smoke-live` 改为 `=false`。

**ui-walk**：新模块导出两个步骤。
- 第一个步骤插在 `parsePromptIds(…)`（`:307`）之后、held 轮询（`:308`）之前：
  1. 在助手 article 内等 `getByRole("group",{name:"需要你的确认"})`，并断言 `status` `bash 运行中` 与 composer 的 `生成中`（`generatingStatus(page)`）可见，不断言三者先后；
  2. 断言组内 `允许`/`拒绝` 均可用；
  3. 断言 `gatePhase(origin,gateId)` 为 `armed`，证明末轮确实被审批挡住；
  4. 确定性地断言按钮禁用，按以下顺序：
     1. 点击前调用 `holdRoute(page, "**/api/sessions/*/approvals/*")`（`web/e2e/route-hold.ts:12-31`，底层 `route.continue`；先例 `ui-walk.spec.ts:155,266`）；
     2. 点 `允许`，`expect.poll(() => hold.held())` 为真；在请求被挂起期间断言两按钮均 `disabled`；
     3. 在 `finally` 中调用 `release()`；
     4. 然后断言组名变为 `已允许执行`、`status` `bash 已完成` 可见。
     - 原因：按钮只在 pending 条内渲染，`approval.resolved` 到达后约 20ms 即随组名切换而卸载（`approval-bar.tsx:33-38,50,54-66`）。不挂起请求时，「点击后断言 disabled」与卸载竞态。
- 第二个步骤在完成后 reload 的 `expectCompletedPair`（`:334`）之后：`已允许执行` 组恰 1 个，`需要你的确认` 组为 0。

## Governing invariant
生产上每个 omp 子进程都以 `--approval-mode write` 启动。真 omp 的 CI 验证面对首轮 bash 审批显式作答 `allow`，不依赖 60s 自动允许，也不存在回 yolo 的旁路。

## 200 vs 409 竞态
- 自动允许发生在 `requestedAt+60s`（`store-approvals.ts:17`）。审批轮询只会在 select 已登记之后命中 pending；它从 prompt202 起算最多约 20s，而 `requestedAt` 晚于 prompt202，所以命中时离过期至少还有约 40s。
- POST 紧跟在命中之后发出，实测间隔约 60ms（E0-3）。
- 本流程中能提前结算该行的路径只有 decide、超时、崩溃、关停与对账（#474）。空闲回收在 pending 期间暂停（#462），smoke 期间不关停；其余路径在正常流程中都不会触发。
- 因此 409 不是 flake，而是真实故障，例如 omp 迟迟不发 select、计时器错误或误结算。POST 不重试，按 `HTTP 200` 精确失败。
- `skip_turn_control=true` 时两条目都被跳过，只走自动允许（E0-7）。smoke-live 下真模型如果在一个回合里**先后**调两次及以上 bash，每条都要等 60s 自动允许，而 `retry: 180` 的 done 轮询（≥90s）只覆盖一条。这种情况下 smoke-live 会在约 90s 时**失败**，属已接受的限制（手工目标）。spec 的 Note（父文逐字「最坏等待 60s×N…accepted」）不改。

## Sibling surfaces
**必然变红、且允许编辑的既有测试**（只改期望值）
- `server/test/omp-process.test.ts:530`：`coldArgs` 内 `"yolo"` → `"write"`，覆盖 12 例；
- `server/test/server-assembly.test.ts:658`：`ompArgs` 内同改，覆盖 2 例。
- 精确 `toEqual` 已经排除了 `yolo`，不另加断言，因为既有测试文件不增长。

**允许编辑的非测试文件**
- `smoke/chat.hurl`、`Makefile`、`scripts/test-ci-harness.sh`、`web/e2e/ui-walk.spec.ts`（只加 import 与两处调用）；
- 为使 `ui-walk.spec.ts` 保持 ≤800 行，**只**允许把 `generatingStatus`（`:701-706`）原样搬到 `web/e2e/ui-walk-approval.ts` 并 import 回 spec，行为不变。新模块确实使用它：审批步骤第 1 步断言 pending 期间 `生成中` 可见。不得搬其它 helper。
- 行数：biome 格式化后 `wc -l web/e2e/ui-walk.spec.ts` 预期为 795（799 − 7 行 helper 与前导空行 + 1 行 import + 2 行调用）；若 import 超过 100 列被折行，则为 799。硬上限 ≤800，实测值记入 PR body。

**恒绿、零 diff 的相邻面**
- `omp-approval-requests.test.ts:67` 与 `omp-runtime-exit-pending.test.ts:94` 的替换变为空操作；
- `session-supervisor-pool-helpers.ts:69-73`，fake 取最后一个 `--approval-mode`；
- `fake-omp-*.test.ts`（直接起 fake，自带 argv，`fake-omp-helpers.ts:20-21`）；
- `smoke/public|auth|files.hurl`（E0-9 在 write 下已绿）；
- AGENTS.md 矩阵行；`ci.yml`；`.github/scripts/*`；`ui-walk-layout.ts`；`ui-walk-oracle.ts`；`fake-upstream.mjs`。
- **仅 CI 可证**：`server/test/linux/uid-isolation.test.ts`。它经真实 `SessionRuntime` → `spawnOmp`（`:80`、`:109`）起 fake-omp，argv 随之变为 `write`。它用的是默认场景加 `probe:` prompt（`:91`）与 `hang-term`（`:120`），都不在 `APPROVAL_SCENARIOS` 中（`fake-omp.mjs:38-43,101` 只对这四个场景门控），所以预期零变化。该文件在非 Linux 或未设 `WORKBUDDY_UID_TEST=1` 时跳过（`:67`），只有 uid-isolation job 的 vitest 阶段（`ci-uid-isolation.sh:225`）能证明，见 E7。

**其它消费者**
- `uid-isolation` job 经 `make smoke` 消费同一 chat.hurl（`ci-uid-isolation.sh:230`），只能由 PR CI 证明。
- `make ui-shots` 受影响但越界，见 proposal Open questions。

## Seams under test
- spawn：既有 `capture(...)`/`probingSpawn` 断言（`omp-process.test.ts:123-177,295,338-382`）与 `server-assembly.test.ts:229,285`，只改期望值。
- HTTP：`make smoke`（真实编译服务 + 真 omp + 假上游），调用方自起服务。本机复现方法见 E0；CI 路径为 `ci-compiled-server.sh smoke`。
- 浏览器：`make ui-walk` 两个 project。gate 相位读取用既有 `gatePhase`（`ui-walk-gate.ts`）。
- oracle：`make test-guardrails`，末尾调用 `test-ci-harness.sh`（`test-guardrails.sh:157`）。

## Required evidence
（R = 先红后绿，G = 守护、恒绿）
- **E1 R**：先改两个测试字面量，`npm test --workspace server` 恰 14 例红（形状同 E0-9 的反面）；再改 `process.ts:80`，全套件绿，覆盖率 ≥80%。
- **E2 R**：先改 Makefile 两条配方、不改 oracle，`bash scripts/test-ci-harness.sh` 的 contract 基线 FAIL；同步 oracle 后为 `(808+4) PASS / 0 FAIL`，4 条新变异各记 PASS（被拒）。
- **E3 R**：`make smoke` 连跑两遍均 exit 0。在 master argv（yolo）下同一 chat.hurl 红于审批捕获（E0-10）。PR body 记录 `--very-verbose` 片段，须显示：
  - 审批轮询：`approvals` count 1、`tool` `bash`、`decision` null；
  - POST：200，`decision` `allow`；
  - done 轮询：精确正文、≥1 个 done bash 步骤、session done；
  - chat.hurl 总时长远小于 60s（本机约 1.6s）。
  - 另附一个 write 回合的原始帧摘录：用 E0 的 `OMP_BIN` tee 包装脚本采集 stdout，须显示 `message_end(toolUse)` → `extension_ui_request{method:"select"}` → `tool_execution_start(bash)` 的次序，并附对应 stdin 的 `extension_ui_response{value:"Approve"}`。归档 PR 据此改写父 D8。
- **E4 G**：对假上游服务执行 `SMOKE_BASE_URL=<app> MODEL_UPSTREAM_BASE_URL=<假上游 /v1> MODEL_UPSTREAM_API_KEY=fake make smoke-live`。门禁只检查非空，值不进 Hurl，所以不需要真实密钥。预期：作答两条目 `has been skipped`，约 61s 经 `timeout` 通过（E0-7）。
- **E5 R**：`make ui-walk` 两个 project 均 exit 0。
  - 审批步骤：`需要你的确认` 组、`bash 运行中` 与 `生成中` 同时可见，gate 为 `armed`；作答请求被 `holdRoute` 挂起期间两按钮 disabled；`release()` 后组名 `已允许执行`、`bash 已完成`；
  - 既有 reload/release 断言照常；完成后 reload 仍为 `已允许执行`；
  - error oracle 零新增。
  - master 上红于 `:308`（E0-9）。
- **E6 G**：`make check` 绿；`make test-guardrails` 绿；`bash scripts/size-guard.sh` exit 0；`wc -l web/e2e/ui-walk.spec.ts` ≤800，与新模块行数一起记入 PR body。
- **E7（仅 CI）**：PR CI 的 `smoke`、`ui-walk`、`uid-isolation` 三条 job 均绿。`uid-isolation` 证明两件事：
  - vitest 阶段（`ci-uid-isolation.sh:225`）：`server/test/linux/uid-isolation.test.ts` 在 `write` argv 下零改动仍绿；
  - smoke 阶段（`:230`）：sudo/setpriv 形态下同样作答。
- **E8 G**：`git diff --stat` 只含 What Changes 所列文件与本 change 目录。
- **E9 G**：`grep -rn '"yolo"' server/src` 无匹配。

## Non-goals
见 proposal。

## Review focus
1. argv 只改一个字面量；两处测试只改期望值；fork/regenerate 同契约句确实没有写进 delta；tool-approval「审批请求识别」只并入 argv 首句，其 Scenario 保持主 spec 原样。
2. chat.hurl：审批轮询预算 <60s；POST 无 retry；done 轮询 ≥90s；两条目都带 `skip`；jsonpath 采用 E0-7 实测可用的形状。
3. 两条配方各只多一个 `--variable`；oracle 基线与全部相关 `cm` 同步；4 条新变异生效；CI 工作流零 diff。
4. ui-walk：作答在 held 轮询之前；不断言 bash 与审批条的先后；有 `armed` 断言；按钮禁用在 `holdRoute` 挂起期间断言；完成后 reload 仍 `已允许执行`；只搬 `generatingStatus`；spec 文件 ≤800 行。
5. 实测次序（先 select 后 `tool_execution_start`）已写进 delta 的括注；父 delta 与父 design.md:103 的修正留给归档 PR。
