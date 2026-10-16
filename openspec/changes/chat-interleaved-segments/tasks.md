# Tasks: chat-interleaved-segments

> 跟踪：#915 为父 issue，Stage 5 按下面的切片（1、2、3a、3b、4…）在其下建子 issue，一个子 issue 一个 PR。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - 1、2、7 互不依赖，也不依赖其它组，可立即并行。
> - 3a ← 2（写 `chat_steps.body_offset`）。
> - 3b ← 3a（正文已发布长度计数与 `store-segments.ts`）、3b ← 1（3.10 的官方用例要 `WORKBUDDY_INTERLEAVE`）。
> - 4 ← 3a（配对写在 3a 移出的 `startStep` 事务里）。4 与 3b 互不依赖：二者同改 `store-branch.ts` 的拷贝段与 `store-segments.ts`，后合入者 rebase。
> - 5 ← 3b（段行与段时长）、5 ← 4（`step_id` 与 `approvalId`）。
> - 6 ← 5（视图字段）、6 ← 7（6.2 的「展开态只随用户点击变化」双工具段部分要 7 去掉的自动展开；6 反正等 5，先合 7 不增加等待）。
> - 8 ← 6（同改 `message-thread.tsx` 的块次序段；兜底记录排在分段区之后）、8 ← 4（8.5 的 CH-20 / CH-22 / CH-24 / CH-50 取 4.4 实测所取的分支；传递地已含于 6 ← 5 ← 4，这里显式列出）。
> - 9 ← 8（传递地含 5、6、7）、9 ← 1（交错标记）。
>
> 通用纪律：见 design「通用纪律」，本文不复述；下面每组的「验证」都以它的合入门槛为底线。补充两条只与任务写法有关的：
> - **测试先行。** 有行为的任务先写测试并在未改动的代码上看到红（或在 PR 写明为何不可能红，例如新模块），再实现。
> - **开工核对。** 每组第一个任务是核对；核对出入先改 design 与本组任务，再继续（design「行号核对」）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Public API / CLI / script entry | 选中：`step.start` 两个新字段、`approval.request` 的 `stepId`、`thinking.end` 的 `segment`、快照与 REST 三处新键（严格键集，服务端与 web 同刀；部署时已打开的旧标签页重新同步一次后关流提示刷新，design Migration Plan） | 5 |
| Schema / columns / units / field names | 选中：迁移 045（两列一表）；偏移单位 UTF-16 码元；上限按码点 | 2、3a、3b |
| Concurrency / shared state / ordering | 选中：开段前冲刷与闭段量长；审批行早于 pump 插入；select 与 start 的线上先后不保证，配对在后到的一方；配对与作答的先后 | 3b、4 |
| Error handling / rollback / partial outputs | 选中：步骤插入与配对同一事务；段行写失败不发布；宿主崩溃留下越界偏移 | 3a、3b、4、6 |
| Legacy compatibility / examples | 选中：045 之前的消息无位置信息走旧布局；既有夹具补键 | 5、6 |
| Resource limits / large input / discovery | 选中：32768 码点上限之后的零长度段 | 3b、6 |
| Documentation / migration notes | 选中：验收清单（design D15）、CI 列表、design D6 实测结论 | 4、6、7、8 |
| Release / packaging / dependency compatibility | 未选：不加依赖；omp 版本仍是 v18.0.10 | — |
| Config / File IO / Auth | 未选：不涉及配置、文件路径与鉴权 | — |

## 行数预算（800 行硬上限；`scripts/size-guard.sh`）

| 文件 | 现在 | 合入后上限 | 改动的切片 |
|---|---|---|---|
| `server/src/sessions/store.ts` | 791 | 3a ≤ 765；3b、4 两刀不论先后，单独合入后 ≤ 770、两刀都合入后 ≤ 774；5 ≤ 784 | 3a、3b、4、5 |
| `server/src/sessions/supervisor.ts` | 776 | 4 ≤ 781；5 ≤ 783（per-pump 对象 `PumpSteps`，design D16） | 4、5 |
| `server/src/sessions/thinking-span.ts` | 112 | 3b ≤ 150；5 ≤ 160 | 3b、5 |
| `server/src/sessions/approvals.ts` | 264 | 4 ≤ 275；5 ≤ 280 | 4、5 |
| `server/src/sessions/events.ts` | 531 | ≤ 540 | 5 |
| `server/src/sessions/rest.ts` | 574 | ≤ 590 | 5 |
| `server/src/sessions/store-approvals.ts` | 407 | ≤ 412 | 5 |
| `server/test/session-rest.test.ts` | 800 | 5 ≤ 800：`:157-229`、`:745-792` 两组整快照断言改用共享的助手视图常量展开（先例 `session-rest-helpers.ts:38` 的 `UNBOUND_USER_VIEW`），净减；新断言进新文件 | 5 |
| `server/test/delta-coalescer.test.ts` | 771 | 不改：3b 的新例进新文件 `delta-coalescer-segments.test.ts` | — |
| `server/test/thinking-span.test.ts` | 620 | ≤ 700 | 3b |
| `server/test/session-thinking.test.ts` | 786 | 5 ≤ 800：`:269`、`:354` 的 `thinking.end` 补 `segment` 用一个共享常量 | 5 |
| `web/src/features/chat/stream-thinking.ts` | 63 | ≤ 90 | 5 |
| `web/src/features/chat/stream-approvals.ts` | 120 | ≤ 130 | 5 |
| `web/src/features/chat/stream.ts` | 776 | ≤ 790 | 5 |
| `web/src/features/chat/use-chat-session.ts` | 790 | 不改 | — |
| `web/src/features/chat/turn-actions.ts` | 760 | 不改 | — |
| `web/src/lib/session-contract.ts` | 696 | ≤ 710 | 5 |
| `web/src/features/chat/message-thread.tsx` | 393 | 6 ≤ 425；8 ≤ 430 | 6、8 |
| `web/e2e/ui-walk-layout.ts` | 789 | 不改 | — |
| `web/e2e/ui-walk.spec.ts` | 680 | ≤ 700 | 9 |

其余被改文件与新模块的上限见 design「行数预算」。每个 PR 写明它改到的上表文件改动前后的行数；超出上限先停下改 design，不调阈值。

## 1. omp-test-harness — 受控上游交错标记 `WORKBUDDY_INTERLEAVE`

- [x] 1.1 开工核对：
  - 重读 `server/test/support/fake-upstream.mjs` 的标记查找、答复轮与工具轮的判定、已武装闸门路径（`serveFinal` / `holdFinal`）与 `WORKBUDDY_PACE` 的分派处；
  - 重读 `server/test/support/fake-upstream-pace.mjs`（47 行）的写出函数，确认交错序列可以直接交给它写（只换记录列表），不复制节奏逻辑。

  验证：核对结果写进 PR。
- [x] 1.2 先写测试 `server/test/fake-upstream-interleave.test.ts`（`fake-upstream-pace.test.ts` 已 441 行，另开文件），覆盖 omp-test-harness「受控上游交错标记」：
  - 「交错写出」：记录次序与内容逐字相等；服务端写出间隔 ≥ 20ms（只设下限，同 #910 的 PACE 测量位置）；每次写出时 `writableCorked` 为 0；
  - 「不改变其它请求」四例：无标记、同带 `WORKBUDDY_PACE`、带已武装闸门、工具轮，各与对照输出逐字节相同；
  - 同带 `WORKBUDDY_THINK` 时不另发其思考片；
  - 连接中途关闭时停止写出，不留未处理拒绝。

  验证：在未改动的代码上新用例判红。
- [x] 1.3 实现标记：`fake-upstream.mjs` 只加标记识别与一次调用，记录列表与写出交给 `fake-upstream-pace.mjs`。`fake-upstream.mjs` 合入后 ≤ 670 行。
  验证：1.2 全绿。
- [x] 1.4 变异证据（逐条做、逐条撤销，结果贴进 PR）：去掉 25ms 间隔 → 间隔断言判红；把思考片挪到两片正文之前 → 「交错写出」判红；让本标记在同带 `WORKBUDDY_PACE` 时生效 → 「不改变其它请求」判红；带闸门时不忽略本标记 → 同上判红。
- [x] 1.5 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿（通用纪律的合入门槛）。
Suggested fixture level: compact - 只动测试夹具，不碰产品代码；行为由单测直接钉住（#910 组 1 先例）。
Minimal mergeable slice: atomic - 一个标记加它的单测；再切就是半个标记，无法独立验证。

## 2. chat-sessions — 迁移 045

- [ ] 2.1 开工核对：
  - 重读迁移 042–044 与它们的测试、受信迁移计数所在处；
  - 用 `grep -rn "ended_at\|decided_at" server/test` 找出钉住 `chat_steps` 与 `chat_approvals` 精确列清单的夹具（#910 时的四处列清单夹具 `core-db-message-error.test.ts`、`core-db-chat-schema.test.ts`、`core-db-session-fixture.ts`、`migration-034.test.ts` 先看），列成本组的补列清单；
  - 确认 045 仍未被任何分支或打开的 PR 占用（`git ls-remote` 只读、`gh pr list` 只读）。

  验证：清单与核对结果写进 PR。
- [ ] 2.2 先写测试 `server/test/migration-045.test.ts`，覆盖 chat-sessions「迁移 045 分段位置与确认关联」三例：「新库与存量库」（存量行新列为 NULL、无回填）、「约束与级联」（负值被 CHECK 拒绝；删除消息级联删除段行）、「中途失败可重试」；受信迁移计数加一。
  验证：在未改动的代码上判红。
- [ ] 2.3 实现 `server/src/core/db/migrations/045_chat_interleaved_segments.sql`，DDL 逐字按规格；只加列、加表，不读不写。2.1 清单里的列清单夹具补列（通用纪律第 4 种改法），逐条列进偏离记录。
  验证：2.2 全绿；`make check` 全绿。
- [ ] 2.4 变异证据：去掉段表的 `ON DELETE CASCADE` → 「约束与级联」判红；去掉非负 CHECK → 同上判红；`step_id` 写成 `NOT NULL DEFAULT 0` → 「新库与存量库」判红。
- [ ] 2.5 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。
Suggested fixture level: expanded - 迁移（一张新表、两个新列），是 schema 变化；没有读写方，风险只在迁移账本与列清单夹具。
Minimal mergeable slice: atomic - 一个迁移文件及其测试与补列。

## 3. chat-stream / thinking-fold / chat-sessions — 位置的记录

- [ ] 3.1 开工核对（3a）：
  - 重读 `server/src/sessions/store.ts` 的 `Turn`（`:247-262`）、`openTurn`（`:725-745`）、`appendDelta`（`:525-546`）、`startStep`（`:553-585`）与快照 `content` 的拼接（`:352`）；
  - 重读 `turn-control.ts:246-262` 的 `step.start` 分支、`store-branch.ts:248-254` 的拷贝 SQL；
  - `grep -rn "startStep" server/src server/test` 列出全部调用方，确认移模块不改签名之外的东西。

  验证：核对结果写进 PR。
- [ ] 3.2 先写测试（3a）：
  - `server/test/store-segments.test.ts`（真 SQLite）：正文已发布长度按 UTF-16 码元累加（chat-stream「码元而非码点」：`a😀` 后开始的步骤 `body_offset` 为 3）；跨过 2048 字节 / 2000ms 落库后仍等于已发布正文长度（pending 不丢计）；新回合从 0 开始；`body_offset` 与步骤行同一事务写入，事务失败两者都不在；
  - `server/test/session-segment-offsets.test.ts`（fake-omp `approval-parallel`）：chat-stream「步骤的正文偏移」在库这一层成立——两个步骤的 `body_offset` 等于各自 `step.start` 之前 ring 中 `text.delta` 拼接的长度（事件字段到 5 才有）；
  - 分叉：chat-sessions「Fork copies history before the chosen user message」与 turn-control「拷贝分段位置」里关于步骤 `body_offset` 的部分，读新会话的库行断言。

  验证：在未改动的代码上判红。
- [ ] 3.3 实现（3a）：
  - 新模块 `server/src/sessions/store-segments.ts`，把 `startStep` 整体移入并在插入步骤行时写 `body_offset`；`store.ts` 留接口声明与委托；
  - `Turn` 加正文已发布长度，`appendDelta` 按 `delta.length` 累加，`openTurn` 置 0（design D2）；
  - `store-branch.ts` 的步骤拷贝加 `body_offset`（design D7，同一刀补，不留丢数据的窗口）；
  - 对外形状不变：`step.start` 负载与快照都不加字段（design D8）。

  验证：3.2 全绿；`store.ts` ≤ 765 行。
- [ ] 3.4 变异证据（3a）：计数改用 `Buffer.byteLength` → 「码元而非码点」判红；偏移改读库里 `content` 的长度 → pending 用例判红；`openTurn` 不清零 → 新回合用例判红；拷贝漏掉 `body_offset` → 分叉用例判红。
- [ ] 3.5 整刀验证（3a）：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。
Suggested fixture level（3a）: expanded - 改持久化（步骤插入事务）与回合共享状态，并改 fork 拷贝。
Minimal mergeable slice（3a）: atomic - 计数、写列与 fork 拷贝是同一个数据的产生与搬运；只做一半，分叉出的会话要么缺偏移、要么偏移错。

- [ ] 3.6 开工核对（3b）：
  - 重读 `delta-coalescer.ts` 的 `route`（`:86-102`）与 `#take`（`:149-176`）、`thinking-span.ts`（`:59-101`）、`store-thinking.ts`（`:43-69`）；
  - 重读既有 `server/test/delta-coalescer.test.ts`、`thinking-span.test.ts`、`session-thinking-span.test.ts`、`omp-official-delta-coalescing.test.ts`；`grep -n "spans.open\|open(" server/test/delta-coalescer.test.ts server/test/thinking-span.test.ts` 找出钉住「开段时刻合并器里仍有正文」次序的既有断言（预计没有：ring 次序本来就是先正文后思考，变的只是开段时刻的库状态），有则列成改写清单。

  验证：核对结果与清单写进 PR。
- [ ] 3.7 先写纯层测试（3b，注入时钟 + 假端口；`delta-coalescer.test.ts` 已 771 行，合并器的新例进新文件 `server/test/delta-coalescer-segments.test.ts`，段行与段时长的新例扩写 `thinking-span.test.ts`，≤ 700 行）：
  - chat-stream「合并器缓冲着正文时开段」：ring 次序与段行 `body_offset` 为 3；「闭段时长度含缓冲的思考」：正文与 `approval.request` 两例下 `thinking_length` 为 3、`thinking.end` 先于它们；
  - thinking-fold「思考时长记录与下发」：「多段思考累计」（每段一行、各自 `thinking_length` 与 `thinking_ms`，消息累计不变）、「相邻的两段不合并」、「上限之后的段」（零长度段照常计时）、「写库失败」（段行写失败时不发布该 `thinking.delta` / `thinking.end`）、「停止与失败」「中断后无法恢复」中段行的取值；
  - 段的 `thinking_offset` / `thinking_length` 按已保存文本的 UTF-16 长度（含截断标记），`steps_before` 为开段时已开始的步骤数。

  验证：在未改动的代码上判红。
- [ ] 3.8 先写集成测试（3b，fake-omp，扩写 `session-thinking-span.test.ts`）：既有 `thinking` 与 `edit-write` 场景回合结束后段行的取值（`edit-write` 的 `steps_before`）；开段后关闭 store 并以 `reconcileOnStartup` 重开，段行 `thinking_length` 与 `thinking_ms` 仍为 NULL。
- [ ] 3.9 先写分叉、撤回、重新生成的测试（3b，真 SQLite）：turn-control「拷贝分段位置」的段行部分（逐值、含 NULL、次序不变）；message-undo「撤回连带删除分段数据」；chat-sessions「Regenerate replaces only the last assistant message」里旧助手行的段行随之删除、新行没有段行。
- [ ] 3.10 官方 omp 取证（3b）：在 `server/test/omp-official-delta-coalescing.test.ts` 追加一例，经 `openProxiedApp` 发送含 `WORKBUDDY_INTERLEAVE` 的 prompt（第一个请求是被世界拒绝的 bash 工具轮，第二个是交错答复轮）。断言 chat-stream「真 omp 链路上的开段偏移」在库这一层的部分：第一条 `thinking.delta` 之前的 `text.delta` 拼接恰为 `先说一句，再补一句。`；该消息恰一行段，`body_offset` 等于该拼接长度（10）、`thinking_offset` 0、`thinking_length` 3。快照断言在 5.2 追加。打印一行实测（`text.delta` 条数、段行），贴进 PR，不写进断言。该文件已在 `.github/scripts/ci-uid-isolation.sh:292` 的列表里，不改 CI。
  验证：`WORKBUDDY_OMP_TEST=1 OMP_BIN=<repo>/var/omp/omp` 下该文件通过。
- [ ] 3.11 实现（3b）：
  - `delta-coalescer.ts` 的 `route`：思考分支改为「先冲刷缓冲着的正文 → 再 `spans.open` → 再 `#take`」（design D3）；
  - `thinking-span.ts`：开段在清空 `thinking_ms` 的同一事务里插入段行；闭段在写累计时长的同一事务里写段的长度与毫秒（读写函数在 `store-segments.ts`）；`thinking.end` 负载本切片不变；
  - `store-branch.ts` 加段行拷贝（design D7）；撤回与重新生成不改代码（外键级联）。
  - 3.6 清单里的既有断言按通用纪律改写，逐条列进偏离记录。

  验证：3.7–3.10 全绿；`store.ts` ≤ 770 行（若 4 已先合入则 ≤ 774）。
- [ ] 3.12 变异证据（3b）：把 `route` 的次序改回「先开段后冲刷」→ 「合并器缓冲着正文时开段」判红，3.10 也应判红（偏移为 5；若 omp 把两片正文并成一帧发出则不判红，如实记录并贴实测行）；相邻两段合并成一行 → 「相邻的两段不合并」判红；`thinking_offset` 改按码点计 → 「上限之后的段」或截断用例判红（如实记录是哪一个）；拷贝漏掉段行 → 3.9 分叉用例判红。
- [ ] 3.13 整刀验证（3b）：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；`WORKBUDDY_OMP_TEST=1` 下 `omp-official-delta-coalescing.test.ts` 全绿。
Suggested fixture level（3b）: expanded - 改合并器的冲刷次序（并发 / 次序风险包）与开段、闭段的持久化。
Minimal mergeable slice（3b）: atomic - 开段前冲刷、段行的开与闭、fork 拷贝是同一段数据的产生与搬运；先冲刷而不记段没有可观察的价值，记段而不先冲刷则记下的偏移是错的。

## 4. tool-approval — 确认与步骤配对

> 执行次序：4.1 → 4.4 → 4.5 / 4.6 → 4.2 → 4.3 → 4.7 → 4.8 → 4.9。4.4 的实测不依赖配对代码，放在本组最前面，先定下 8.5 要取的分支；编号不变，其它产物按编号引用它。

- [ ] 4.1 开工核对：
  - 重读 `supervisor.ts` 的 `#pump`（`:598-651`，`toolIds` `:606`、`publishRequest` 处 `:624-628`）、`approvals.ts` 的 `register` / `publishRequest` / `#finish`（`:61-107`、`:200-231`）、`omp/ui-requests.ts:19-36`、`omp/process.ts:602-621`、`omp/runtime.ts:570-580`；
  - 重读 3a 移出的 `startStep` 与 `store-branch.ts` 的审批拷贝 SQL；
  - 确认审批行确实可能早于 pump 处理前面的帧插入（design Context），写出可以造出这个次序的 fake-omp 帧序列；
  - 重读 design Context「select 与 start 的线上先后不是保证」所引的 omp v18.0.10 源码（`agent-loop.ts:2547-2555`、`wrapper.ts:276-332`、`rpc-mode.ts:716-739`、`:978-980`、`agent-session.ts:2188-2240`），有出入先改 design；
  - 重读既有的真栈证据：`make smoke` 跑的是官方 omp，`smoke/chat.hurl:191-203` 断言审批挂起时 bash 步骤已在 `running`，`:219-228` 断言停止以 `deny` 结算后该 bash 步骤为 `failed`。所以「步骤先于作答存在」与「停止结算的拒绝让步骤失败」已在官方二进制上观察到，4.4 只需测剩下的两件：用户作答拒绝时的 `tool_execution_end{isError}`，以及 select 与 start 的线上先后；
  - 确认 fake-omp 能否发出「`tool_execution_start` 先于其审批 select」的帧序列；不能时用受控子进程（#910 `session-thinking.test.ts` 先例），不改 fake-omp 的既有脚本。

  验证：核对结果写进 PR。
- [ ] 4.4 被拒绝调用的实测（design D6；本组第一个动手的任务；临时打印与探针不提交，用例文件随 4.5 / 4.6 固化后提交）。范围收窄为两件事：用户作答拒绝的那次调用有没有 `tool_execution_start` / `tool_execution_end{isError:true}`，以及 select 与 start 的线上先后（4.1 已列出 smoke 里的既有证据）：
  (a) 新建 `server/test/omp-official-approval-pairing.test.ts`，经 `openProxiedApp`（世界拒绝每个审批）发送 `跑一个命令`：第一个请求是 bash 工具轮，审批被拒绝；
  (b) 记录：帧里是否有该调用的 `tool_execution_start` 与 `tool_execution_end`（及其 `isError`）、该调用的审批 select（`extension_ui_request`）与 `tool_execution_start` 在帧序列里的先后（没有 start 时记「无」）、ring 里是否有该步骤的 `step.start` / `step.end`、库里 `chat_steps` 的行（`chat_approvals.step_id` 一项要等 4.3 的配对写入，到 4.9 时补记进结果表）；同一用例连跑三次；
  (c) omp 用 `make omp-fetch` 拉到的 v18.0.10（`OMP_BIN=<repo>/var/omp/omp`），不用 brew 装的版本；只打受控假上游。

  验证：一张结果表（帧、线上先后、事件、库行，三次各一列）。有没有步骤三次不一致时停下报告，不取分支；线上先后三次不一致时如实记录，不固化先后断言（配对规则本来就不依赖它，design D6），并在 PR 里写明。
- [ ] 4.5 分支一——被拒绝的调用有步骤：4.4(a) 的用例固化为常驻断言：恰一个 bash 步骤，以 `failed` 结束；被拒绝审批的 `step_id` 等于该步骤 id；`decision` 为 `deny`；4.4 观察到的 select 与 start 的先后（三次一致时）作为常驻断言。design D6 的「被拒绝的调用」改写为实测结论（删去「没有步骤」一支的推演，保留规格的两支合法终态不动）；design D15 的 CH-20 / CH-22 / CH-24 / CH-50 取「该步骤卡标 `已拒绝`」。（未取此分支时：在本条后注明「未取，见 4.4 的结果表」并勾选。）
- [ ] 4.6 分支二——被拒绝的调用没有步骤：4.4(a) 的用例固化为常驻断言：没有 bash 步骤；被拒绝审批的 `step_id` 为 NULL；`decision` 为 `deny`；帧里没有该调用的 `tool_execution_start`。design D6 写明实测结论与「同回合后一个同名步骤会配走被拒绝的审批」这一已知局限（Risks 同步）；design D15 的 CH-20 / CH-22 / CH-24 / CH-50 取「消息末尾 `已拒绝执行`」。（未取此分支时：在本条后注明「未取，见 4.4 的结果表」并勾选。）
- [ ] 4.2 先写测试：
  - `server/test/approval-pairing.test.ts`（纯）：select 先到时 start 按名字先进先出取出；start 先到时 select 配给最早开始、仍在运行的同名步骤；名字不同两个方向都不配；已结束的步骤不再配；request 已发布的 select 只入队（含登记已被删除的情形）；回合结束丢弃；
  - `server/test/session-approval-pairing.test.ts`（fake-omp + 真 SQLite）：tool-approval「确认与步骤配对」的「同名工具按先进先出配对」（`approval-parallel`；`decision`、`decided_at`、审计行、发给子进程的帧与 `approval.resolved` 与改动前逐值相同）、「步骤先于审批 select 到达」（审批行已插入而 pump 未读到 select；配对写在 select 时、`approval.request` 发布之前）、「已结束的步骤不再配对」「工具名不同不配对」两例、「没有步骤的审批保持未配对」两例、「配对写失败」两例、「作答先于 pump 读到 select」（作答路径已补发 `approval.request`、登记已删除；select 时只入队、不写 `step_id`，后到的同名 `step.start` 取出它）；
  - 分叉：turn-control「拷贝审批记录」里 `step_id` 按步骤序号重映射、原值 NULL 时为 NULL。

  验证：在未改动的代码上判红。
- [ ] 4.3 实现：
  - 新模块 `server/src/sessions/approval-pairing.ts`（未配对审批队列与未配对的运行中步骤两份状态，design D6）；
  - pump 在 `publishRequest` 之前的同一处：读到审批 select 且其 request 尚未发布时，查运行中的同名步骤，有则执行 `step_id` 的 `UPDATE` 并提交，否则入队（`supervisor.ts` 只加这一处调用，≤ 781 行）；「此刻 `publishRequest` 是否会为该帧发布 request」（登记仍在且未发布；登记已删除即为否）由 `approvals.ts` 新加的一个只读查询给出，与 `publishRequest` 共用判定；
  - `turn-control.ts` 的 `step.start` 分支取出同名审批交给 `startStep`，后者在插入步骤行的同一事务里写 `step_id` 并返回配上的审批 id；没有配上的步骤记入运行中列表；`step.end` 分支把步骤移出列表；
  - 本切片不改任何事件负载：`step.start.approvalId` 与 `approval.request.stepId` 到 5 才发布；
  - `store-branch.ts` 的审批拷贝按 design D7 重映射 `step_id`；
  - `ApprovalRegistry` 的登记、计时、作答、结算，`settleApproval`、审计与两类审批事件的发布代码零改动（design D6）。

  验证：4.2 全绿；`approvals.ts` 的 diff 只有那一个只读查询，`store-approvals.ts` 无改动。
- [ ] 4.7 CI：把 `omp-official-approval-pairing.test.ts` 加进 `.github/scripts/ci-uid-isolation.sh:292` 的官方 omp 用例列表，同步改 `scripts/test-ci-harness.sh` 里钉住该命令的断言；PR 单列 CI 一节，写明 uid-isolation job 的实测总时长（上限 15 分钟）。
- [ ] 4.8 变异证据：配对改为「库里 `step_id IS NULL` 的最小 `id`」→ 「步骤先于审批 select 到达」判红（`step.start` 提前配上了 pump 尚未读到的审批）；select 时只入队、不查运行中步骤 → 同一场景判红；`step.end` 不移出运行中列表 → 「已结束的步骤不再配对」判红；select 时的 `UPDATE` 挪到 `approval.request` 发布之后 → 「配对写失败」第二例判红；取出时不比对名字 → 「工具名不同不配对」判红；配对写在步骤事务之外 → 「配对写失败」判红；select 时不判「request 是否已发布」、一律按运行中步骤配对 →「作答先于 pump 读到 select」判红（实时视图的 `stepId` 为 null 而快照有值）；配对时顺手改 `decision` 或 `decided_at` → 「同名工具按先进先出配对」的逐值断言判红；拷贝不重映射 `step_id`（原样拷贝）→ 分叉用例判红。
- [ ] 4.9 整刀验证：4.4 结果表补记被拒绝审批的 `chat_approvals.step_id`；`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；`WORKBUDDY_OMP_TEST=1` 下 `omp-official-approval-pairing.test.ts` 与 `omp-official-approval-modes.test.ts` 全绿；CI 的 uid-isolation job 绿。PR 请求白盒审查（design D18），审查重点是「配对没有改变任何作答与结算路径」。
Suggested fixture level: expanded - 与审批闸门同表、同一 pump 的持久化写入；并发次序（审批行早于 pump 插入、select 与 start 的先后不保证）；fork 重映射。
Minimal mergeable slice: atomic - 队列、写列、fork 重映射与实测是同一个关联的产生、搬运与真链路证据；拆开会留下「分叉出的会话配错步骤」的窗口。

## 5. chat-sessions / chat-stream / chat-web — 快照、REST 与事件字段（同刀）

- [ ] 5.1 开工核对：
  - 重读 `rest.ts:480-502` 的快照形状、`store.ts` 的 `MessageView` / `StepView` / `ApprovalEntry`（`:78-160`）与读出、`events.ts` 的 `step.start` / `thinking.end` / `approval.request` 类型、`approvals.ts` 的 `register` 里 request 负载的构造与 `publishRequest`；
  - 重读 web `session-contract.ts:266-372`、`stream.ts:655-720` 的事件解码与 `:367-371` 的重新同步、`stream-steps.ts`、`stream-approvals.ts`、`stream-thinking.ts`、`runtime-convert.ts`；
  - 列出全部要补键的严格键集夹具，用下面四组 grep，结果全部写进 PR：
    - 键集常量：`grep -rn "MESSAGE_KEYS\|STEP_KEYS\|APPROVAL_KEYS" server/test`；
    - 事件负载：`grep -rnE 'type: "(step\.start|approval\.request|thinking\.end)"' server/test web/test` 与 `grep -rnE 'emitData\("(step\.start|approval\.request|thinking\.end)"' web/test`；
    - 整份快照或视图的严格比较：`grep -rnE 'toStrictEqual|expectWorkspaceResponse|publicApproval' server/test web/test` 中涉及消息、步骤、审批的；
    - 显式列清单的 SELECT 助手：`grep -rn "SELECT .* FROM chat_approvals\|SELECT .* FROM chat_steps" server/test/support server/test/*-helpers.ts`。
  - Stage 3 已点名、必须出现在清单里的文件——服务端：`session-prompt-attachments.test.ts:56`、`session-approval-snapshot.test.ts:32`、`message-undo-state.test.ts:39`、`session-composer-align.test.ts:82`、`session-snapshot-metadata.test.ts:25`（`STEP_KEYS` `:39`）、`session-supervisor.test.ts:442-478`、`session-file-changes.test.ts:239-260`、`session-approval-events.test.ts:24-27`、`:122-126`、`session-approvals-parallel.test.ts:256`、`session-approval-rest.test.ts:213`、`:242`、`session-fork-rest-real.test.ts:220-229`、`session-rest.test.ts:157-229`、`:745-792`、`session-thinking.test.ts:269`、`:354`，以及 `session-fork-helpers.ts:214` 的 `approvalsOf`（显式列清单、不含 `step_id`，4.2 的 fork 重映射断言若用它要先加列）；web：`chat-message-waiting.test.tsx`、`chat-page-file-changes.test.tsx`（:184-233 的步骤视图）、`chat-page-ownership.test.tsx`、`chat-stream-failure.test.ts`、`chat-stream-recovery.test.ts`、`chat-stream-todo.test.ts`、`chat-workspace-sidebar-filter-select.test.tsx`、`chat-workspace-sidebar-refresh.test.tsx`、`chat-workspace-sidebar-relocate.test.tsx`（四键 `step.start`），`chat-approval-bar.test.tsx`、`chat-stop-button.test.tsx`、`chat-unknown-turn.test.tsx`（五键 `approval.request`），以及 `grep -rln thinkingMs web/test web/e2e` 的全部命中。

  验证：补键清单写进 PR。
- [ ] 5.2 先写服务端测试（新断言进新文件），按验证路径分三项：
  - **5.2a 快照与 REST**：chat-sessions「会话 REST」：消息 13 键、步骤 8 键、审批 7 键，`decideApproval` 的 200 为七键；「Snapshot carries segment positions」；「Fork copies history…」与「Regenerate…」中新键的取值；tool-approval「审批作答 REST」改写后的「允许」（200 七键含 `stepId`）；
  - **5.2b 事件负载**：chat-stream：「Ordered publication after persistence」（`thinking.end.segment` 与段行相等）、「步骤的正文偏移」（`step.start.bodyOffset` 与快照相同）、「合并器缓冲着正文时开段」的快照部分；
  - thinking-fold 改写后带 `segment` 负载的场景；tool-approval「审批快照」（`stepId` 与归约）、改写后的「审批事件」两例（`approval.request` 六键、`stepId`）；chat-stream 改写后的「审批事件发布」全部场景（含 select 时配对写失败不发布）；tool-approval「步骤先于审批 select 到达」的事件部分（`approval.request.stepId` 为该步骤 id）；「作答先于 pump 读到 select」的事件部分（作答路径补发的 `approval.request.stepId` 为 `null`，随后 `step.start.approvalId` 为该审批 id，实时视图与快照的 `stepId` 相同）；
  - **5.2c 官方 omp 追加**（`WORKBUDDY_OMP_TEST=1`）：3.10 的用例追加快照断言（`thinkingSegments` 恰一段，值同库行）；4.4 的用例追加快照 `stepId` 断言（按所取分支）。

  验证：在未改动的代码上判红。
- [ ] 5.3 先写 web 测试：chat-web「分段位置三键严格解析」「分段位置归约」「步骤开始事件的两个新字段严格解码」（含：缺键或多键的 `step.start` 触发重新同步，与其它已知事件一致）、「审批请求事件的 stepId 严格解码」、「审批请求与结算归约」与「分段位置归约」中 `approval.request` 带 `stepId` 的部分、改写后的「convertMessage 映射」（新字段透传，part 次序不变）；chat-web「实时与快照切段一致」的视图部分（事件归约出的视图与快照视图的 `thinkingSegments`、步骤 `bodyOffset`、审批 `stepId` 逐值相等；切段函数的比较在 6.2）。
  验证：在未改动的代码上判红。
- [ ] 5.4 实现服务端：读出与快照形状加三处键（读写函数在 `store-segments.ts`）；`step.start` 发布 `bodyOffset` 与 `approvalId`；`thinking.end` 发布 `segment`；`approval.request` 发布 `stepId`（pump 把 4.3 的 select 时配对结果传给 `publishRequest`；作答路径补发 request 时为 `null`）；纯协议事件归约的输出不变；`approvals.ts` 只改 request 负载，不改发布时机与任何作答路径。
  验证：5.2 全绿；`store.ts` ≤ 784、`events.ts` ≤ 540、`rest.ts` ≤ 590、`store-approvals.ts` ≤ 412 行。
- [ ] 5.5 实现 web：新模块 `web/src/lib/session-contract-segments.ts`（新键的严格解析）与 `web/src/features/chat/stream-segments.ts`（`thinking.delta` 临时段、`thinking.end` 取代、`step.start` 记偏移与 `stepId`、`approval.request` 取事件的 `stepId`、`turn.start` 清空）；`stream.ts`、`session-contract.ts`、`stream-thinking.ts`、`stream-approvals.ts` 只加类型字段与分派（行数见预算表）；`runtime-convert.ts` 透传新字段并把 `:44-48` 的注释改为「part 不承载分段，分段由 `message-segments.ts` 从透传字段算」。本切片不改任何呈现。
  验证：5.3 全绿；`stream.ts` ≤ 790、`session-contract.ts` ≤ 710 行。
- [ ] 5.6 补键（通用纪律第 4 种改法，逐条列进偏离记录），按 5.1 的清单分两项、各自可单独核对：
  - **5.6a 服务端**：键集常量、事件负载断言、整快照断言（`session-rest.test.ts` 改用共享助手视图常量，见预算表）、`approvalsOf` 加列；验证 `npm test --workspace server` 全绿，`session-rest.test.ts` ≤ 800、`session-thinking.test.ts` ≤ 800 行。
  - **5.6b web**：快照夹具取 `bodyOffset: null`、`stepId: null`、`thinkingSegments: []`；事件里 `step.start` 的 `bodyOffset` 取此刻已收到正文的长度、`approvalId` 取 `null`；`approval.request` 的 `stepId` 取 `null`；`thinking.end` 的 `segment` 取该段在用例事件下的真实取值——快照起头、快照里已有思考的用例（`chat-thinking-smooth.test.tsx`、`chat-thinking-preview.test.tsx` 等），`segment.thinkingOffset` 取快照思考的长度，与客户端临时段一致，使消息保持旧布局（design D14 的判定）；验证 `npm test --workspace web` 全绿，且 D14「不需要改写」清单里的断言一条未改。
- [ ] 5.7 冒烟：`smoke/session-meta.hurl` 的 `WORKBUDDY_THINK` 用例加 chat-harness「冒烟断言分段位置」的断言。
  验证：`make smoke` 全绿；把 `stepId` 断言改成期望 `null` 时判红（证明断言在跑）。
- [ ] 5.8 变异证据：服务端漏发 `step.start.approvalId` → web 解码用例与 5.2 判红；web 归约不在 `thinking.end` 取代临时段 → 「分段位置归约」判红；快照漏输出审批 `stepId` → 键数用例与冒烟判红；`thinking.end.segment` 取自内存而非库行（例如不含截断标记）→ 「Ordered publication」判红（如实记录）；`approval.request` 恒发 `stepId: null` → 「步骤先于审批 select 到达」的事件断言判红。
- [ ] 5.9 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；`WORKBUDDY_OMP_TEST=1` 下 3.10 与 4.4 的两个文件全绿。PR 写明部署须服务端与 web 同一版本，以及部署时已打开的旧标签页会关流提示刷新（design Migration Plan）；PR 请求白盒审查（`approvals.ts` 的 request 负载，design D18）。
Suggested fixture level: expanded - 公开快照键、REST 形状与事件负载（严格键集），旧解析器重新同步后关流报错。
Minimal mergeable slice: atomic - 服务端事件字段、快照键与 web 的解析、归约必须同一 PR（design D8）；任一侧先合，会话页整体拒收快照、关流报错。

## 6. chat-web / thinking-fold — 分段呈现

- [ ] 6.1 开工核对：
  - 重读 `message-thread.tsx:230-258` 的 `AssistantMessage`、`thinking-fold.tsx`、`message-waiting.tsx`、正文逐字展开的组件与 `MessageBody`；
  - 对 design D14 清单项 3（块次序）逐条确认：表外列出的「不需要改写」的块次序断言（`chat-page-file-changes.test.tsx:685-700`、`:717-724`，`chat-thinking.test.tsx:655-680`，`chat-page-artifact-card.test.tsx:555-575`）的夹具在 5.6 之后确为旧布局（步骤 `bodyOffset: null` 或有思考而无段）。不是的停下更新 D14；
  - 对 D14 清单项 5、6（B12、B5）逐条确认：D14 表里两行 `chat-thinking-title.test.tsx` 之外，「不需要改写」列出的思考用例与走查步骤（`chat-thinking.test.tsx` T8 与其余（T6 已移入 D14 改写表）、`chat-thinking-preview.test.tsx`、`chat-thinking-smooth.test.tsx`、`chat-thinking-title.test.tsx:171-257`、`ui-walk-thinking-preview.ts`、`ui-walk-sessions.spec.ts:320-340`）按 D14 的判定确为旧布局，或为分段布局而断言与 B12 一致。

  验证：核对结果写进 PR。
- [ ] 6.2 先写测试：
  - `web/test/message-segments.test.ts`（纯）：chat-web「助手消息分段」四个场景全部 WHEN；
  - jsdom `Thread`：chat-web「消息线程」的「分段布局的块次序」（只断言分段区的块与次序、操作行与 `复制`；同一场景里「消息内没有兜底确认记录」与「`bash` 步骤卡带 `超时自动允许` 小标记」两条依赖切片 8，留给 8.2）「分段布局下的小圆点」（含分段区一个块也没有时小圆点的位置、`（已停止生成）` 占位是 `message-body`、只有思考时没有空的 `message-body`）「助手块次序」（旧布局）「正文逐字展开」（分段下只有最后一个正文段增长）、「实时与快照切段一致」（事件归约出的视图与快照视图经切段函数逐块相等）；
  - thinking-fold「深度思考折叠块呈现」改写后的「流式展开、终态收起」（分段一例：`thinking.end` 即收起；旧布局一例：展开到终态）「标题三态与多段思考」（任何时刻至多一个折叠块展开）「用户手动切换保留」（含分段布局下展开已结束的段后跨过其它事件与终态保持展开）「分段布局下只展开进行中的一段」（`data-running` 与流式预览只在进行中那一段）「终态消息主体限高」的 running 例、「快照中的思考与截断标记」；
  - chat-web「工具段摘要与折叠」「展开态只随用户点击变化」的双工具段部分（两个工具段互不影响、块键保留展开态；先思考后正文的消息里块键互不相同）；
  - turn-control「拷贝分段位置」与 message-undo「撤回连带删除分段数据」里「经 chat-web『助手消息分段』得到逐块相等的分段」的子句：用 3.9 的服务端测试读出的源与副本（撤回前与撤回后）两组值作夹具，经切段函数断言输出逐块相等（服务端测试调不到 web 函数，这一半在这里做）。

  验证：在未改动的代码上判红。
- [ ] 6.3 实现：新模块 `web/src/features/chat/message-segments.ts`（纯切段函数）与 `message-segments-view.tsx`（按块渲染：`MessageBody`、`ThinkingFold`、`ToolCallGroup`，React key 取块键）；`message-thread.tsx` 只判布局并把其后各部件排在分段区之后；`thinking-fold.tsx` 的标题取段数据，开合、`data-running` 与预览的依据由消息的 `running` 换成传入的「进行中」（旧布局传消息 running，行为与 #910 相同；分段布局传该段的进行中，design D10）。拷入层零改动。
  验证：6.2 全绿；`message-thread.tsx` ≤ 425 行；knip 无未用导出。
- [ ] 6.3a 按 design D14 表改写标「6」的全部行（`chat-thinking.test.tsx:422-427`、`:443` 的 T6，清单项 3；`chat-thinking-title.test.tsx:107-139`、`:145-169`，清单项 5、6；通用纪律第 3 种改法，引用 issue 需求 1、B12、B5），逐条列进偏离记录；表外的思考用例只补键（5.6），不改断言。
- [ ] 6.4 对话内搜索（design D13）：jsdom 用例覆盖 chat-web「工具段摘要与折叠」的「对话内搜索不改变段的展开态」；conversation-search 的既有用例不改、全绿。
- [ ] 6.5 验收清单：按 design D15 改写 CH-14、CH-117（先调用工具的回答，小圆点在工具段之下）、CH-118（含 B12：一段思考结束即收起），新增「分段交替显示与刷新后一致」一行（受控上游带 `WORKBUDDY_INTERLEAVE`），结论 `待签`。
- [ ] 6.6 变异证据：块键去掉种类前缀 → 「先思考后正文的消息里块键互不相同」判红（并在控制台出现 React 同级重复键警告）；分段区没有块时不渲染小圆点 → 「分段区没有块时的小圆点」判红；切段函数忽略 `stepsBefore`（思考段一律排在同偏移的步骤之后）→ 「交替切段」第二个 WHEN 判红；旧布局判定漏掉条件 2 → 「旧布局判定」判红；只含空白的正文段照常输出 → 「空白与空思考不分隔工具段」判红；工具段的 React key 改用数组下标并在前面插入一段 → 双工具段展开态用例判红；折叠块共用一个开合状态 → 「用户手动切换保留」判红；分段布局下折叠块仍按消息 running 开合（不在段结束时收起）→ 「分段布局下只展开进行中的一段」与改写后的「流式展开、终态收起」判红；旧布局也改成按段开合 → 「流式展开、终态收起」的旧布局例判红。
- [ ] 6.7 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿（走查此时看到的真 omp 消息已是分段布局；走查里若有表外的块次序断言变红，停下更新 D14）。
Suggested fixture level: expanded - 旧消息兼容（045 之前的消息走旧布局）是本切片的核心判定；渲染次序波及全部助手消息。
Minimal mergeable slice: atomic - 切段函数与渲染器必须一起合入（knip 禁止未用导出），且不能出现半分段的呈现。

## 7. chat-web — 工具段摘要与默认收起

- [ ] 7.1 开工核对：重读 `tool-call-group.tsx`（`:37-44` 自动展开、`:58-60` 摘要）与 ui-foundation「组件分层」的定制清单；按 design D14 表对清单项 1、4 重跑 `grep -rn "个步骤\|aria-expanded" web/test web/e2e`，与表逐条对照；表外命中的停下更新 D14。
  验证：对照结果写进 PR。
- [ ] 7.2 先写测试：
  - `web/test/tool-summary.test.ts`（纯）：chat-web「工具段摘要与折叠」的「归类计数与次序」「失败与进行中后缀」（转圈图标随 `running` 出现与消失）；颜色在 jsdom 里量不到（`web/vitest.config.ts:7-8` 不加载 Tailwind），「不着色」在 `chat-tool-group.test.tsx` 里按结构断言：`，1 步失败` 与其余摘要文字在同一个文本元素里、不单独成元素，该元素的 `className` 不含任何 `text-*` 颜色类（同文件 `:192` 的类名断言先例）；
  - `web/test/chat-tool-group.test.tsx`：「展开态只随用户点击变化」的单工具段部分（新失败步骤不展开、手动展开在新步骤并入与快照原地重装后保留）；chat-web「消息线程」改写后的「工具调用组默认收起与失败自动展开」。

  验证：在未改动的代码上判红。
- [ ] 7.3 实现：新模块 `web/src/features/chat/tool-summary.ts`；`tool-call-group.tsx` 去掉 `failedCount` 比较与自动展开、摘要改用 `summarizeTools`，转圈与流光保留。拷入层零改动。
- [ ] 7.4 按 design D14 表改写清单项 1、4 中标「7」的全部断言（通用纪律第 3 种改法，引用 B6、B7），逐条列进偏离记录；其中 `web/e2e/ui-walk-approval.ts:110` 按 chat-harness「UI 走查对话步骤」改为 `执行 1 条命令，进行中`，`ui-walk-todo.ts:90` 改为 `其它 1 步`。
- [ ] 7.5 验收清单：按 design D15 改写 CH-15、CH-19，结论 `待签`。
- [ ] 7.6 变异证据：恢复失败自动展开 → 「展开态只随用户点击变化」与改写后的消息线程场景判红；按文件数而非步骤数计 `读取` → 「归类计数与次序」判红；类的次序按出现次序 → 同上判红；失败后缀单独成一个 `span` 并加 `text-destructive` → 「不着色」的结构断言判红；去掉 `，进行中` → 「失败与进行中后缀」判红。
- [ ] 7.7 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。
Suggested fixture level: compact - 一个组件的显示与折叠规则加一个纯函数，不碰数据与协议。
Minimal mergeable slice: atomic - 摘要与折叠规则同属 B7；拆开会让同一组件在一刀里摘要已新、折叠仍旧，验收行无法改写。

## 8. chat-web / tool-approval — 步骤卡的确认标记与兜底记录

- [ ] 8.1 开工核对：重读 `approval-card.tsx:166-228` 的 `ApprovalRecords`、`step-card.tsx` 卡头、`message-waiting.tsx` 的判据；按 design D14 表对清单项 2 重跑 `grep -rn "已允许执行\|已拒绝执行\|超时自动允许\|approval-record" web/test web/e2e`，与表逐条对照；表外命中的停下更新 D14。
  验证：对照结果写进 PR。
- [ ] 8.2 先写测试：chat-web「步骤卡的确认标记」；tool-approval「web 审批条」的「已配对的已结算确认不渲染记录」；兜底记录位于分段区之后、错误文本之前；接手 6.2 留下的 chat-web「分段布局的块次序」两条断言（消息内没有兜底确认记录、展开第二个工具段后 `bash` 步骤卡带 `超时自动允许`）；「web 审批条」既有记录场景在未配对夹具下照旧通过；chat-web「等待指示」不变。
  验证：在未改动的代码上判红。
- [ ] 8.3 实现：`step-card.tsx` 卡头加 `span[data-slot="step-approval-mark"]`（状态徽章之前、纯文本、不进徽章可访问名）；`ApprovalRecords` 只渲染 `stepId` 不指向本消息步骤的已结算审批；`message-thread.tsx` 把兜底记录排在分段区之后。文案与样式不变；拷入层零改动。
  验证：8.2 全绿；`message-thread.tsx` ≤ 430 行。
- [ ] 8.4 按 design D14 表改写清单项 2 中标「8」的断言：`web/e2e/ui-walk-approval.ts:12` 及其使用处、`web/e2e/ui-walk-upstream-failure.ts:91`，按 chat-harness「UI 走查对话步骤」改为「消息里没有记录卡，展开工具段后步骤卡无标记（允许）」；逐条列进偏离记录。
- [ ] 8.5 验收清单：按 design D15 改写 CH-20、CH-21、CH-22、CH-23、CH-24、CH-50、CH-56，结论 `待签`。CH-20、CH-22、CH-24、CH-50 里「被拒绝之后看到什么」一律取切片 4 的实测（任务 4.4）所取的分支——4.5 取了就写「展开工具段后该步骤卡标 `已拒绝`」，4.6 取了就写「消息末尾 `已拒绝执行`」；不写两可的措辞。开工前先读 4.4 的结果表与 design D6 里记下的结论。
- [ ] 8.6 变异证据：`allow` 也显示标记 → 「超时、拒绝与正常允许」判红；不按 `stepId` 过滤记录 → 「已配对的已结算确认不渲染记录」与走查判红；标记放进状态徽章 → 徽章可访问名断言判红；兜底记录挪回分段区之前 → 块次序用例判红；`timeout` 不显示标记 → 「分段布局的块次序」的标记断言判红。
- [ ] 8.7 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。
Suggested fixture level: compact - 两个组件的显示规则，数据与协议已在 5 就位。
Minimal mergeable slice: atomic - 去掉已配对的记录卡与加上步骤卡标记必须同刀：只去不加，超时与拒绝在消息里就没有痕迹了（B4）。

## 9. chat-harness — 分段走查集成

- [ ] 9.1 开工核对：重读 `web/e2e/ui-walk.spec.ts` 主旅程的末段（分叉步骤导航到新会话之后、清理之前）与受闸会话的 id 来源；确认 `ui-walk-layout.ts`（789 行）不需要改。
  验证：核对结果写进 PR。
- [ ] 9.2 新建 `web/e2e/ui-walk-segments.ts`，按 chat-harness「分段呈现的冒烟与走查」实现三步（工具段在正文之前、交错、刷新一致），在 `ui-walk.spec.ts` 主旅程末段调用；只打受控假上游与官方 omp。本组只做集成，不改产品代码。
  验证：两个 project 下通过；`ui-walk.spec.ts` ≤ 700 行；PR 写明新步骤时长与主旅程总时长（`globalTimeout` 300s）。
- [ ] 9.3 变异证据（对产品代码临时变异，逐条撤销）：`message-segments-view.tsx` 按旧次序（思考 → 全部正文 → 工具段）渲染 → 第 1、2 步判红；`chatStateFromSnapshot` 丢掉 `thinkingSegments` → 第 3 步判红（刷新后变旧布局）；去掉开段前冲刷（3.11 的次序改回）→ 第 2 步正文段文本判红或第 3 步快照偏移判红（如实记录）。
- [ ] 9.4 验收核对：`grep -n "个步骤\|已允许执行\|正文上方" docs/acceptance/functional-checklist.md` 不再命中 design D15 表里改写过的行；D15 表每一行都已在其切片里改写。
- [ ] 9.5 整刀验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。
Suggested fixture level: none - 只加走查步骤与验收核对，不改产品行为。
Minimal mergeable slice: atomic - 一个走查文件及其接线。
