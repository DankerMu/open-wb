# Tasks: chat-thinking-status-stream

> 跟踪：#910 为父 issue，Stage 5 按下面的切片（2a、2b、3a…）在其下建子 issue，一个子 issue 一个 PR。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - 1 与 2a 互不依赖；2b ← 1（节奏标记）、2b ← 2a。
> - 3a 无依赖；3b ← 2b（闭段先冲刷合并器；3.3 要往 2.5 新建的官方 omp 用例里追加断言；supervisor 行数预算链 2a → 2b → 3b）、3b ← 3a（写 `thinking_ms`）；3c ← 3b。
> - 4a 无依赖；4b ← 4a（同改 `holdFinal`）。
> - 5a 无依赖；5b ← 5a（同改 `message-thread.tsx`）、5b ← 4a（零内容停点）。
> - 6a ← 3c（视图字段）、6a ← 5b（同改 `message-thread.tsx:226` 的 `ThinkingFold` 调用）；6b ← 6a、6b ← 4b（思考停点与长思考）。
> - 7a ← 5b（同改 `message-thread.tsx`）；7b ← 6b、7b ← 7a（共用 `smooth-text.tsx`）。
>
> 通用纪律：
> - **合入门槛。** 每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿，主干可运行。凡改到或新增官方 omp 用例的 PR，另跑 `WORKBUDDY_OMP_TEST=1 OMP_BIN=<repo>/var/omp/omp` 下相关的 `server/test/omp-official-*.test.ts`；omp 用 `make omp-fetch` 拉到的 v18.0.10，不用 brew 装的版本。
> - **永远不打真实模型端点。** 单测、官方 omp 用例、冒烟与走查一律打假上游。
> - **新逻辑进新模块，行数有预算。** `scripts/size-guard.sh` 是硬门槛，不调阈值。
>   - 当前行数：`server/src/sessions/supervisor.ts` 791、`server/src/sessions/store.ts` 788、`web/src/features/chat/stream.ts` 773、`web/src/lib/session-contract.ts` 685。
>   - 每个切片在 PR 里写明这几个文件改动前后的行数。
> - **行号核对。** 任务里的 `文件:行` 是在 `963ab348`（本 change 起草时的 master）上读的。每组开工先重跑该组第一个任务的核对；有出入，先改本 change 的 design 与该组任务，再继续。
> - **既有断言不删不削弱。** 因本 change 而变化的既有断言，在 PR 的偏离记录里逐条列出旧 → 新。只允许三种改法：
>   1. 改为「拼接逐字相等」；
>   2. 在注入时钟下改为确定条数；
>   3. 如果断言钉住的正是被 owner 裁定推翻的旧行为，改写为钉住新行为的反向断言，并在偏离记录里引用该裁定。目前这样的旧行为有三条：「正文不落后于已到达的数据」（O2/O6）、「折叠块标题恒为 `深度思考过程`」（O1）、「运行中的折叠块主体不限高」（O4，Q15）。实现中发现别的，先停下更新本条，不自行扩大。
> - **拷入层不改**（design D8）。`web/src/components/ui/` 与 `web/src/components/assistant-ui/` 零改动；非改不可时停下报告。
> - **不实现 design 的 Non-Goals。** 不把 `thinking_start` / `thinking_end` 当内容来源，不回填时长，不给其它事件做合并，不在首块之后再显示等待指示。
> - **验收清单。** 每个切片改到的呈现，同步改写 `docs/acceptance/functional-checklist.md` 的对应行或新增行；结论一律 `待签`，agent 不代签。
> - **CI 文件。** 改了 `.github/**` 或 `scripts/test-ci-harness.sh` 的切片，在 PR 里单列一节说明。
> - `Suggested fixture level` 只用 `none | compact | expanded`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Public API / CLI / script entry | 选中：新事件 `thinking.end`；快照消息新键 `thinkingMs`（严格键集，须服务端与 web 同刀） | 3b、3c |
| Schema / columns / units / field names | 选中：迁移 044 | 3a |
| Concurrency / shared state / ordering | 选中：合并器的冲刷次序、快照前缀与重连不重复、闭段先于触发事件、`thinking_end` 闭段 | 2a、2b、3b |
| Error handling / rollback / partial outputs | 选中：合并缓冲在崩溃 / infra fault / 停止 / 本地完成时的去留；开段与闭段写库失败 | 2a、2b、3b |
| Resource limits / large input / discovery | 选中：取消思考字节阈值后单条事件的大小；32768 码点上限不变 | 2a |
| Legacy compatibility / examples | 选中：旧消息 `thinking_ms` 为 NULL；旧前端忽略 `thinking.end` | 3b、3c |
| Release / packaging / dependency compatibility | 选中：依赖 `@assistant-ui/react` 0.x 的 `useSmooth` 内部分支与 `aui.part` 引用稳定性 | 7a |
| Documentation / migration notes | 选中：验收清单、ADR-0013 增补、CI 列表 | 2b、3c、5、6、7 |
| Config / File IO / Auth | 未选：不涉及配置、文件路径与鉴权 | — |

## 1. omp-test-harness — 受控上游节奏标记 `WORKBUDDY_PACE`

- [x] 1.1 开工核对：
  - 重读 `server/test/support/fake-upstream.mjs` 的标记查找（`lastUserTextFrom`）、答复轮判定、`textFrames` / `thinkFrames` 与 `writeSse`，以及闸门路径 `serveFinal`（`:181-198`）；
  - 确认 `WORKBUDDY_PACE` 遇到已武装闸门时可以走「忽略」分支，不碰 `holdFinal`。

  验证：核对结果写进 PR。
- [x] 1.2 实现 `WORKBUDDY_PACE`（omp-test-harness「受控上游节奏与闸门停点标记」的第一项）：
  - 答复轮按 25ms 间隔逐个写出：角色帧、三个思考分片、40 个 `字`、finish、`[DONE]`；
  - 同带 `WORKBUDDY_THINK` 时，不重复发思考分片；
  - 带已武装闸门时忽略本标记；
  - 连接中途关闭时停止写出，不抛未处理异常；
  - `mjs` 同样受 800 行上限约束，节奏写出放进新模块 `server/test/support/fake-upstream-pace.mjs`。

  验证：`server/test/fake-upstream-pace.test.ts` 覆盖：
  - 规格「节奏标记」两例；
  - 无标记请求与改动前逐字节相同；
  - 中途断开不留未处理拒绝。

  分片间隔断言只用宽松下限（≥20ms），不设上限。
Suggested fixture level: compact - 只动测试夹具，不碰产品代码；行为由单测直接钉住。
Minimal mergeable slice: atomic - 一个标记加它的单测；再切就是半个标记，无法独立验证。

## 2. chat-stream / thinking-fold — 正文与思考共用的 250ms 合并器

- [x] 2.1 开工核对（2a）：
  - 重读 `server/src/sessions/supervisor.ts`：`#commit`（`:672-715`）、`#publish`（`:721-735`）、`#retireSlot`，以及 pump 读帧处（`:610-625`）；
  - 重读 `thinking-buffer.ts` 全文、`turn-control.ts:236-244` 的 `persistEvent`、`store.ts:522-542` 的 `appendDelta`；
  - 用 `grep -rn '"text.delta"\|"thinking.delta"\|thinking-buffer' server/test` 找出所有断言条数或逐条内容的既有用例，按思考、正文两类分列，作为 2.4a 与 2.4b 的改写清单。

  验证：清单与核对结果写进 PR。
- [x] 2.2 新建 `server/src/sessions/delta-coalescer.ts`，实现 chat-stream「正文与思考增量的时间窗合并」：
  - **规则**：前沿发布、250ms 时间窗、一次只缓冲一类、换类时冲刷、非增量事件前冲刷、终态前冲刷、注入时钟。
  - **对外接口**：增量分派、`flush`、`discard`、`clearTimer`。
  - **发布端口**：按类别分两条。
    - 思考：先 `append` 再 `publish`，沿用 `thinking-buffer.ts` 的端口；
    - 正文：先 `persistEvent`（`appendDelta`）再 `publish`。
  - **删除** `thinking-buffer.ts`。
  - **范围**：本切片（2a）只接思考，正文仍走今天的逐帧路径。
  - **行数预算**：把 `#commit` 里的分派逻辑（增量交给合并器、其它事件先冲刷）整体移进 `delta-coalescer.ts`，supervisor 里只留一次调用。2a 合入后 `supervisor.ts` ≤ 775 行，给 2b、3b 留余量。

  验证：`server/test/delta-coalescer.test.ts` 用注入时钟和假端口，只断言合并器层看得到的切分与次序；`thinking.end` 和快照相关的部分归 2.4a、3.3。覆盖：
  - chat-stream「首段立即、之后按时间窗」「两类交错保持次序」「非增量事件前冲刷」中增量的切分与先后；
  - thinking-fold「字节阈值与时钟阈值」，以及「上限与截断标记」的落库前缀；
  - 发布失败返回 false 且不推进；`discard` 之后不再发布。
- [x] 2.4a 改写 2.1 清单里**思考类**的既有用例：
  - 原 `thinking-buffer.test.ts` 的 M1–M7 逐条迁移到 2.2 的测试文件。M1 字节阈值改为「不设字节阈值」，其余各条按「通用纪律」三种改法之一处理。
  - `server/test/session-thinking.test.ts` 等 supervisor 级用例按新节奏改写，并覆盖 thinking-fold「合并与落库」「回放与刷新」：
    - 前沿发一条，其余在下一个非思考事件（正文到达）前冲刷为一条（2a 尚无 `thinking_end` 闭段，3b 起冲刷时刻提前到 `thinking_end`）；
    - 缓冲期间读到的快照不含该段，续流不重复。
  - `thinking.end` 的断言留给 3.3。

  验证：`make check` 全绿；偏离记录逐条列出旧 → 新。
Suggested fixture level（2a）: expanded - 改的是发布次序与落库的交界（并发 / 次序 / 部分输出风险包），回归面是全部思考事件。
Minimal mergeable slice（2a）: 2.1、2.2、2.4a。合并器只接思考，正文仍逐帧发布；单独合入后思考按新节奏发布、正文不变，全部测试保绿。

- [x] 2.3 接入正文（2b）：`#commit` 把 `text.delta`（含 `command_output` 映射出的）交给合并器；发布时在同一同步段内 `persistEvent` 并入 ring。2b 合入后 `supervisor.ts` ≤ 780 行。
  验证：`server/test/session-delta-coalescing.test.ts`（fake-omp + 注入时钟）覆盖：
  - chat-stream「首段立即、之后按时间窗」：快照与发布内容逐字相同；
  - 「非增量事件前冲刷」：store pending 含 `xy`；
  - 「快照与重连不重复」；
  - 「崩溃时的缓冲」两例；
  - 「本地完成路径的冲刷」：fake-omp `slash` 场景下的两段 `command_output`；
  - 停止路径：`turn.end stopped` 之前冲刷。
- [x] 2.4b 改写 2.1 清单里**正文类**的既有用例。chat-sessions 的 `Normal actual-child turn`、`Crash with unflushed residual`、`Local command output…` 等场景照旧成立，原断言保留。
  验证：`make check` 全绿；偏离记录逐条列出旧 → 新。
- [x] 2.5 官方 omp 取证：
  - 新增 `server/test/omp-official-delta-coalescing.test.ts`，经 `server/test/support/omp-official-proxied.ts` 的代理夹具发送含 `WORKBUDDY_PACE` 的 prompt。
  - 断言 omp-test-harness「官方 omp 上的合并取证」里关于 `text.delta` 与 `thinking.delta` 的部分：少于 40 条、首条恰为一个 `字`、拼接逐字相等。`thinking.end` 与 `thinkingMs` 在 3b、3c 追加。
  - 实测 `text.delta` 的实际条数与时长，贴进 PR，不写进断言。
  - 把该文件加进 `.github/scripts/ci-uid-isolation.sh:292` 的官方 omp 用例列表，并同步改 `scripts/test-ci-harness.sh` 里钉住该命令的断言。
  - PR 写明 uid-isolation job 的实测总时长（上限 15 分钟）。

  验证：`WORKBUDDY_OMP_TEST=1` 下该文件通过；`make test-guardrails` 通过；CI 的 uid-isolation job 绿。
Suggested fixture level（2b）: expanded - 正文发布节奏变化波及全部会话事件、快照前缀与 CI 用例列表。
Minimal mergeable slice（2b）: atomic - 2.3、2.4b、2.5 是同一个行为变化（正文进合并器）的实现、旧断言改写与真链路证据。拆开会让某一刀里正文已合并而旧断言仍红，或者证据落后于行为。

## 3. thinking-fold / chat-sessions / chat-web — 思考时长

- [ ] 3.1 开工核对：
  - 重读 043 迁移与它的测试；
  - 重读四处精确列清单夹具：`server/test/core-db-message-error.test.ts:96-98`、`core-db-chat-schema.test.ts:304-316`、`core-db-session-fixture.ts:69-81`、`migration-034.test.ts:120-132`；
  - 重读 `store.ts` 的 `MESSAGE_COLUMNS` / `getMessages`、`store-branch.ts:43,231` 的拷贝列清单、`rest.ts` 的快照形状；
  - 重读服务端五处 `MESSAGE_KEYS`：`session-prompt-attachments.test.ts:56`、`session-approval-snapshot.test.ts:32`、`message-undo-state.test.ts:39`、`session-composer-align.test.ts:82`、`session-snapshot-metadata.test.ts:25`；
  - 重读 web 的 `session-contract.ts` 消息解码器、`stream.ts` 事件解码表、`stream-thinking.ts`。

  验证：核对结果写进 PR。
- [x] 3.2 **3a**：按 thinking-fold「迁移 044 思考时长列」实现迁移 `server/src/core/db/migrations/044_chat_message_thinking_ms.sql`，只加列，不读不写。上面四处精确列清单夹具同步加列，并列进偏离记录。
  验证：
  - 迁移测试覆盖规格两例：新库与存量库、中途失败可重试；
  - 受信迁移计数加一；
  - `make check` 全绿。
Suggested fixture level（3a）: compact - 只加一个可空列（expand），没有读写方；风险只在迁移账本与列清单夹具。
Minimal mergeable slice（3a）: atomic - 一个迁移文件及其测试。

- [x] 3.3 **3b**：新建 `server/src/sessions/thinking-span.ts`，按 thinking-fold「思考时长记录与下发」实现：
  - **开段**：按帧到达时刻开段，并同步把 `thinking_ms` 写为 NULL。
  - **闭段**：pump 读到原始 `thinking_end` 帧，或即将处理非思考事件，二者先到者触发。依次做四步：冲刷合并器、累计 `max(0, …)`、写列、在同一同步段内发布 `thinking.end`。
  - **终态**：终态之前先闭段。
  - **不补写**：infra fault 与宿主进程退出时不补写。
  - **其它改动点**：`events.ts` 的 `ChatEvent` 加 `thinking.end`；`store-thinking.ts` 加 `clearThinkingMs` / `setThinkingMs`；`store.ts` 只加一行接口声明，合入后 ≤ 790 行。
  - **行数**：`supervisor.ts` 只加两处对 `thinking-span.ts` 的调用：pump 读帧处一处，`#commit` / `#publish` 经 `delta-coalescer` 的分派一处。合入后 ≤ 795 行。
  - **本切片不加快照键。**

  验证分两层（design「Sketch seams under test」）：
  - **纯层** `server/test/thinking-span.test.ts`（注入时钟 + 假端口，仿 2.2 的写法；帧序列由测试直接喂给 `thinking-span.ts`）覆盖全部带毫秒值的场景：
    - thinking-fold「思考时长记录与下发」：「单段思考以 thinking_end 闭合」「工具参数的生成不计入」「没有 thinking_end 时以下一事件闭合」「多段思考累计」（含第二段开段时列被清空）「停止与失败」「中断后无法恢复」「墙钟回拨」「写库失败」；
    - 「上限与截断标记」中的计时例；
    - chat-stream「两类交错保持次序」里 `thinking.end` 的位置；
    - thinking-fold「其它事件前冲刷」两个 WHEN（未收到 `thinking_end` 时由 `step.start` 闭段；合并器未冲刷时以 `turn.end stopped` 结束）。
  - **集成层** `server/test/session-thinking-span.test.ts`（fake-omp，既有 `thinking` / `edit-write` / 无思考场景）只证次序与接线：
    - thinking-fold「合并与落库」：`thinking.end` 紧随 `thinking_end` 冲刷出的 `thinking.delta`，先于第一条 `text.delta`；
    - `edit-write` 场景下 `thinking.delta`、`thinking.end`、`step.start` 的相邻次序（该场景在工具前已发 `thinking_end`，这里只证接线）；
    - 启动对账不碰 `thinking_ms`：开段后（列已清空）关闭 store 并以 `reconcileOnStartup` 重开，该消息为 failed、`thinking_ms` 仍为 NULL（thinking-fold「中断后无法恢复」的对账一半）；
    - 「无 reasoning 的模型」：没有 `thinking.end`，列为 NULL；
    - `thinking_ms` 列在回合结束后为非负整数；
    - chat-stream 改写后的「Ordered publication after persistence」（含 `thinking.end`）。
  - 2.5 的官方 omp 用例追加断言：恰有一条 `thinking.end`，且位于第一条 `text.delta` 之前。
  - 夹具改换（3b 实施时确认，编排方 2026-10-15 记录）：fake-omp `--hold-after-thinking` 在 `thinking_end` 之后才挂起，3b 起 `thinking_end` 即冲刷并闭段，`session-thinking.test.ts` 中依赖「挂起时缓冲仍有思考」的用例改用受控子进程（只发思考帧、不发 `thinking_end`）；断言内容逐字保留，只插入 `thinking.end` 及由此带来的计数平移，并把子进程句柄改名（`spawned` → `children` / `child()`），不算削弱，在偏离记录逐条列出。
Suggested fixture level（3b）: expanded - 新的公开事件、开段 / 闭段写库与 pump 读帧，跨持久化与次序两类风险。
Minimal mergeable slice（3b）: atomic - 开段清空、闭段写列与发布 `thinking.end` 是同一段的生命周期。只做一端，要么列值永远是 NULL，要么残留旧值、违背 O3。

- [ ] 3.4 **3c**：服务端快照与 web 契约同刀。消息 DTO 是严格键集，见 chat-web「API 客户端扩展」#910 段。
  - **服务端**：
    - 快照的 `MessageView` 加 `thinkingMs`，按 chat-sessions「会话 REST」改写后的形状输出，`store.ts` ≤ 795 行；
    - fork 拷贝 `thinking_ms`（`store-branch.ts` 的列清单）；
    - 五处服务端 `MESSAGE_KEYS` 常量加键，列进偏离记录。
  - **web**：
    - `session-contract.ts` 的消息解码加 `thinkingMs`，事件解码加 `thinking.end`；
    - 视图加 `thinkingMs` / `thinkingActive` 及其归约，解码与归约写在 `stream-thinking.ts`；`stream.ts` 只加类型字段与分派，≤ 790 行；
    - `runtime-convert.ts` 透传这两个字段。
  - **本切片不改任何呈现**：标题仍为 `深度思考过程`，到 6a 才换。

  验证：
  - **服务端**：chat-sessions「会话 REST」的十二键与 fork 场景；thinking-fold「多段思考累计」里「第二段进行中快照 `thinkingMs` 为 `null`」；turn-control「从此处分叉 REST」改写后的拷贝断言。
  - **web 单测**：
    - chat-web「消息 thinkingMs 键严格解析」「思考结束事件经同一游标过滤并严格解码」「思考时长与进行中标记归约」的全部 WHEN；
    - 改写后的「convertMessage 映射」；
    - 既有快照夹具补 `thinkingMs` 键，列进偏离记录。
  - **证据**：
    - `smoke/session-meta.hurl` 加 `thinkingMs` 断言（chat-harness「等待与思考呈现的冒烟与走查」第一段）；
    - 2.5 的官方 omp 用例追加「快照 `thinkingMs` 为非负整数」；
    - 验收清单新增「刷新后思考时长不变」一行。
  - `make smoke`、`WORKBUDDY_OMP_TEST=1` 下 2.5 的文件、`make ui-walk` 全绿。
Suggested fixture level（3c）: expanded - 公开快照键（严格键集，服务端与 web 同刀）与 fork 拷贝。
Minimal mergeable slice（3c）: atomic - 快照键与 web 的严格解析必须在同一个 PR：任一侧先合入，会话页都会整体失效（#909 先例）。冒烟断言也依赖这个键。

## 4. omp-test-harness — 闸门停点 `WORKBUDDY_HOLD_AT` 与长思考 `WORKBUDDY_THINK_LONG`

- [ ] 4.1 开工核对：
  - 重读 `fake-upstream.mjs` 的 `holdFinal`（`:325-357`）、`releaseHeld`（`:297-323`）与 `thinkFrames`；
  - 确认停点只影响两件事：停住前写出哪些帧，`remaining` 里放哪些帧。

  验证：核对结果写进 PR。
- [ ] 4.2 **4a**：实现 `WORKBUDDY_HOLD_AT:empty`，并定好 `<point>` 的取值边界：
  - `<point>` 取到空白字符或文本末尾为止；
  - 取值非法、或请求没有已武装闸门时，输出逐字节不变；
  - 放行仍只能一次，TTL 与 409 规则不变。

  omp-test-harness 两条 MODIFIED 要求所指的既有用例如有注释，同步改写。
  验证：
  - `server/test/fake-upstream-hold-at.test.ts` 覆盖规格「闸门停点」里 `empty`、`middle`、`emptyX` 与「不带闸门」各例；
  - 既有闸门用例不改且全过。
Suggested fixture level（4a）: compact - 只动测试夹具；行为由单测直接钉住。
Minimal mergeable slice（4a）: atomic - 一个停点取值加上取值边界。

- [ ] 4.3 **4b**：
  - 实现 `WORKBUDDY_HOLD_AT:thinking`，不带思考标记时等同 `empty`；
  - 实现 `WORKBUDDY_THINK_LONG`：
    - 120 行，分三片发出；
    - 与 `WORKBUDDY_THINK` 同带时以它为准；
    - 在闸门下属于停住前的前缀。

  验证：同一测试文件覆盖：
  - 「闸门停点」里 `thinking` 带与不带思考标记两例；
  - 「长思考标记」两例；
  - 无标记请求逐字节不变。
Suggested fixture level（4b）: compact - 只动测试夹具。
Minimal mergeable slice（4b）: atomic - 两者只服务同一个走查步骤（6b 的「思考进行中与预览」）：短思考撑不满 12rem，思考停点单独合入时没有可用的断言。

## 5. chat-web — 小圆点与等待指示

- [ ] 5.1 开工核对：
  - 重读 `message-thread.tsx:166-183` 的光标、`MessageBody` 的调用处，以及构成「可见块」的各部分（思考、正文、工具调用组、已结算审批、错误 / 重试提示）的渲染条件；
  - `grep -rn 'message-caret' web/test web/e2e`，列出全部引用；
  - `grep -rn 'ByRole("status"\|ByRole(.status' web/test`，列出可能因新增 `role="status"` 受影响的断言。

  验证：核对结果写进 PR。
- [ ] 5.2 **5a**：小圆点。方块光标换成小圆点：
  - 沿用 `data-slot="message-caret"` 与 `aria-hidden`；
  - 圆形，带脉动动画，reduce 下无动画；
  - 显示条件暂不变：消息 running 就显示。

  验证：
  - jsdom 覆盖改写后的「消息呈现与流式光标」；
  - 光标相关的既有断言按新外观改写，列进偏离记录：`chat-messages.test.tsx:90-108`、`chat-stop-button.test.tsx:240,277`、`chat-thread-runtime.test.tsx:31`；
  - 走查覆盖 chat-harness「等待与思考呈现的冒烟与走查」第 1 步，既有 `ui-walk-layout.ts:361-390` 的光标断言并入这一步；
  - 改写验收清单 CH-03；
  - `make ui-walk` 两个 project 全绿。
Suggested fixture level（5a）: compact - 纯前端外观改动。
Minimal mergeable slice（5a）: atomic - 一个元素的外观与动画。

- [ ] 5.3 **5b**：等待指示。
  - 判据函数是纯函数，与等待指示组件一起放进新模块 `web/src/features/chat/message-waiting.tsx`；
  - 小圆点改为只在「已有可见块」时显示（chat-web「消息线程」的「等待指示与小圆点」段）。

  验证：
  - jsdom 覆盖规格「等待指示」的全部 WHEN；
  - 逐条确认 5.1 列出的 `role="status"` 断言，受影响的列进偏离记录；
  - 走查覆盖第 2 步（`HOLD_AT:empty`），宿主是主旅程既有步骤之后的受闸会话；PR 贴出新步骤时长与主旅程总时长（`globalTimeout` 300s）；
  - 验收清单新增等待指示一行。
Suggested fixture level（5b）: compact - 纯前端呈现，判据只读既有视图字段。
Minimal mergeable slice（5b）: atomic - 「等待指示」与「小圆点只在有可见块时显示」是同一个判据的两面。只做一半，会出现二者同时显示或同时不显示。

## 6. thinking-fold — 折叠块标题三态与流式预览

- [ ] 6.1 开工核对：
  - 重读 `thinking-fold.tsx` 全文与文件头注释；
  - 重读拷入的 `reasoning.tsx`：`ReasoningRoot`（受控时 `isPreview = streaming && open`）、`ReasoningText`（预览贴底）、`ReasoningContent`（渐隐层）；
  - 重读 `web/test/chat-thinking.test.tsx` 里按 `reasoning-trigger-*` slot 定位的用例，以及 `web/e2e/ui-walk-sessions.spec.ts:317-340`。

  验证：核对结果写进 PR。
- [ ] 6.2 **6a**：标题三态。
  - 在应用层用拷入的 `CollapsibleTrigger` 组合触发器，不用 `ReasoningTrigger`（design D8）；
  - 沿用 `reasoning-trigger`、`reasoning-trigger-label`、`reasoning-trigger-chevron` 三个 slot；
  - 文案规则见 thinking-fold「深度思考折叠块呈现」第二段；
  - `message-thread.tsx:226` 把 `thinkingMs` / `thinkingActive` 交给折叠块。

  验证：
  - jsdom 覆盖规格「流式展开、终态收起」「标题三态与多段思考」「用户手动切换保留」；
  - 既有的「`深度思考过程`」文案断言按通用纪律第 3 种改法改写；
  - 走查改写 chat-harness「UI 走查会话元数据」第 4 步：终态标题匹配 `已思考 N 秒`；
  - 验收清单改写描述 `深度思考过程` 的行，新增标题三态一行；
  - `make ui-walk` 全绿。
Suggested fixture level（6a）: compact - 前端呈现；契约由 3c 提供。
Minimal mergeable slice（6a）: atomic - 一个控件的文案规则及其走查改写。

- [ ] 6.3 **6b**：流式预览。
  - 传 `streaming={running}`；
  - 主体在两种状态下都用 `max-h-48 overflow-auto`；
  - 父类同时隐藏底部渐隐层；
  - 更新文件头注释，说明预览为何不再与贴底冲突（design D7）。

  web 测试按 `chat-scroll-follow.test.tsx` 的先例桩 `ResizeObserver`；页面级测试经 `radix-platform.ts` 已有空实现。
  验证：
  - jsdom 覆盖「终态消息主体限高」里在 jsdom 能观察的部分：`data-running`、类名、渐隐层隐藏，以及盒内上滚后不被拉回（手动触发桩 `ResizeObserver` 的回调）；
  - 走查覆盖 chat-harness「等待与思考呈现的冒烟与走查」第 3 步（`WORKBUDDY_THINK_LONG` 加 `HOLD_AT:thinking`）；
  - 验收清单改写 CH-14（运行中的折叠块：限高 12rem、盒内贴到最新行）；
  - 既有 `web/test/chat-thinking.test.tsx:689-703`「leaves a running one uncapped (#725)」（断言 `max-h-none`）按通用纪律第 3 种改法改写为「running 主体限高 12rem 且为预览」，列进偏离记录；6.1 的盘点同时 grep `max-h-none` 找同类用例。
Suggested fixture level（6b）: compact - 前端呈现。
Minimal mergeable slice（6b）: atomic - 预览开关、限高与渐隐处理是同一个呈现模式。缺任何一项，预览要么不限高，要么被渐隐层遮挡。

## 7. chat-web / thinking-fold — 正文与思考的逐字展开

- [ ] 7.1 开工核对：
  - 重读 `markdown-body.tsx:48-57`（含注释）与拷入的 `markdown-text.tsx` 的 `smooth` 透传；
  - 重读 `node_modules/@assistant-ui/react/dist/utils/smooth/useSmooth.js`；
  - 重读 `node_modules/@assistant-ui/react-markdown/dist/primitives/MarkdownText.js` 的 `data-status`，以及 `styles/dot.css`；
  - 确认 design D8 推出的分支仍然成立：
    - 挂载时显示全文；
    - 终态传 `false` 时立即显示全文；
    - reduce 下停用；
    - part 状态为「已完成」时，基元不置 `running`。
  - 实测 `TextMessagePartProvider` 在文本增长时 `aui.part` 是否保持同一引用；
  - 盘点在 running 消息增量之后同步断言正文或思考文本的既有用例：已知有 `web/test/chat-markdown.test.tsx:224-248`「流式正文不落后于数据」，另查 `chat-thinking.test.tsx` 的同类用例。

  验证：核对结果与盘点清单写进 PR；与 D8 不符时先改 design。
- [ ] 7.2 **7a**：正文平滑。
  - **新模块** `web/src/features/chat/smooth-text.tsx`：应用层的 `useSmooth` 包装，正文与思考共用。如果 7.1 发现 `aui.part` 引用不稳定，就在模块内保持一个稳定的 provider，只更新文本。
  - **接入**：助手正文经它把要显示的前缀交给 `MarkdownBody`，消息 running 时启用。
  - **不变的部分**：`markdown-body.tsx` 仍传 `smooth={false}`，只把注释改写为新理由；`复制` 与搜索的数据源不变。
  - **既有用例**：`chat-markdown.test.tsx:224-248` 按通用纪律第 3 种改法，改写为反向钉子：展开期间显示的是前缀，进入终态立即全文。
  - **ADR**：ADR-0013 增补一条，记录正文逐字显现重新启用（owner 2026-10-06 / 2026-10-14，#910）：在应用层用 `useSmooth` 实现，取代「正文不能落后于已到达的数据」；基元的 `smooth` 仍关。

  验证：jsdom 用 `vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "Date", "setTimeout", "clearTimeout"] })`（以 7.1 实测可用的配置为准，写进测试注释）覆盖：
  - chat-web「消息线程」「正文逐字展开」的全部 WHEN，含用 `matchMedia` 桩出 reduce 的一例；
  - 展开期间容器没有 `data-status="running"`，只有一个小圆点；
  - 展开期间转录保持贴底（用 `chat-scroll-follow.test.tsx` 的桩法）；
  - 一条 `useSmooth` 行为钉子：用例名注明「依赖 @assistant-ui/react useSmooth 分支」；在同一 provider 下逐次增长文本，断言显示的文本逐帧变长。升级改了分支时，这条会先判红。
Suggested fixture level（7a）: compact - 前端呈现，复用已安装依赖的现成规则；依赖风险由钉子用例覆盖。
Minimal mergeable slice（7a）: atomic - 一个包装组件及其在正文上的接入；思考侧放在 7b。

- [ ] 7.3 **7b**：思考平滑。`thinking-fold.tsx` 经 `smooth-text.tsx` 取主体文本。
  验证：
  - jsdom 覆盖 thinking-fold「思考的逐字展开」的全部 WHEN；
  - 7.1 盘点出的思考侧同类用例，按第 3 种改法改写；
  - 验收清单新增「回答与思考逐字出现、结束时立即完整」一行。
Suggested fixture level（7b）: compact - 前端呈现。
Minimal mergeable slice（7b）: atomic - 只有一处接入。
