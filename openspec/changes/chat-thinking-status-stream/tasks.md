# Tasks: chat-thinking-status-stream

> 跟踪：#910 为父 issue，Stage 5 按下面各组的「Minimal mergeable slice」在其下建子 issue，一个子 issue 一个 PR。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：
> - 组 2 ← 组 1：官方 omp 的合并取证要用节奏标记。
> - 组 3 ← 组 2：闭段要先冲刷合并器。
> - 组 5 ← 组 4：走查的零内容停点。
> - 组 6 ← 组 3（视图字段 `thinkingMs` / `thinkingActive`）；组 6 ← 组 4（预览走查的思考停点）。
> - 组 7 ← 组 5（同改 `message-thread.tsx`）；组 7 ← 组 6（思考平滑改 `thinking-fold.tsx`）。
> - 组 1、组 4 与产品代码无依赖；组 5 只依赖组 4。
>
> 通用纪律：
> - **合入门槛**：每个 PR 合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿、主干可运行。凡改到或新增官方 omp 用例的 PR，另跑 `WORKBUDDY_OMP_TEST=1 OMP_BIN=<repo>/var/omp/omp` 的相关 `server/test/omp-official-*.test.ts`（`make omp-fetch` 拉到的 v18.0.10，不是 brew 装的版本）。
> - **永远不打真实模型端点。** 单测、官方 omp 用例、冒烟与走查一律打假上游。
> - **新逻辑进新模块。** `server/src/sessions/supervisor.ts`（791 行）、`server/src/sessions/store.ts`（788）、`web/src/features/chat/stream.ts`（773）、`web/src/lib/session-contract.ts`（685）离 800 行上限很近；`scripts/size-guard.sh` 是硬门槛，不调阈值。
> - **行号核对。** 任务里的 `文件:行` 是在 `963ab348`（本 change 起草时的 master）上读的。每组开工先重跑该组第一个任务的核对；有出入先改本 change 的 design 与该组任务，再继续。
> - **既有断言不删不削弱。** 因合并而变化的既有断言（「N 条 `text.delta`」「一条 `thinking.delta`」之类），在 PR 的偏离记录里逐条列出旧 → 新。只允许两种改法：改为「拼接逐字相等」，或在注入时钟下改为确定条数。
> - **拷入层不改**（design D8）。`web/src/components/ui/` 与 `web/src/components/assistant-ui/` 零改动；非改不可时停下报告。
> - **不实现 design 的 Non-Goals**：不消费 `thinking_start` / `thinking_end` 帧，不回填时长，不给其它事件做合并，不在首块之后再显示等待指示。
> - **验收清单**：每组改到的呈现同步改写 `docs/acceptance/functional-checklist.md` 的对应行或新增行，结论一律 `待签`，agent 不代签。
> - `Suggested fixture level` 只用 `none | compact | expanded`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Public API / CLI / script entry | 选中：新事件 `thinking.end`；快照消息新键 `thinkingMs`（严格键集，须服务端与 web 同刀） | 组 3 |
| Schema / columns / units / field names | 选中：迁移 044 | 组 3（首刀） |
| Concurrency / shared state / ordering | 选中：合并器的冲刷次序、快照前缀与重连不重复、闭段先于触发事件 | 组 2、组 3 |
| Error handling / rollback / partial outputs | 选中：合并缓冲在崩溃 / infra fault / 停止时的去留；闭段写库失败 | 组 2、组 3 |
| Resource limits / large input / discovery | 选中：取消思考字节阈值后单条事件的大小；32768 码点上限不变 | 组 2 |
| Legacy compatibility / examples | 选中：旧消息 `thinking_ms` 为 NULL；旧前端忽略 `thinking.end` | 组 3 |
| Release / packaging / dependency compatibility | 选中：依赖 `@assistant-ui/react` 0.x 的 `useSmooth` 内部分支 | 组 7 |
| Documentation / migration notes | 选中：验收清单、ADR-0013 增补 | 组 5、6、7 |
| Config / File IO / Auth | 未选：不涉及配置、文件路径与鉴权 | — |

## 1. omp-test-harness — 受控上游节奏标记 `WORKBUDDY_PACE`

- [ ] 1.1 开工核对：重读 `server/test/support/fake-upstream.mjs` 的标记查找（`lastUserTextFrom`）、答复轮判定、`textFrames` / `thinkFrames` 与 `writeSse`，以及闸门路径 `serveFinal`（`:181-198`）。确认 `WORKBUDDY_PACE` 遇到已武装闸门时可以走「忽略」分支，不碰 `holdFinal`。
  验证：核对结果写进 PR。
- [ ] 1.2 实现 `WORKBUDDY_PACE`（omp-test-harness「受控上游节奏与闸门停点标记」的第一项）：
  - 答复轮按 25ms 间隔逐个写出角色帧、三个思考分片、40 个 `字`、finish、`[DONE]`；
  - 同带 `WORKBUDDY_THINK` 不重复思考分片；
  - 带已武装闸门时忽略；
  - 连接中途关闭时停止写出、不抛未处理异常。

  `mjs` 文件同样受 800 行上限约束，必要时把节奏写出拆进新模块 `server/test/support/fake-upstream-pace.mjs`。
  验证：`server/test/fake-upstream-pace.test.ts` 覆盖规格「节奏标记」两例。另加两例：无标记请求与改动前逐字节相同；中途断开不留未处理拒绝。分片间隔断言用宽松下限（≥20ms），不用上限。
Suggested fixture level: compact - 只动测试夹具，不碰产品代码；行为由单测直接钉住。
Minimal mergeable slice: atomic - 只有一个标记与它的单测，再切就是半个标记，无法独立验证。

## 2. chat-stream / thinking-fold — 正文与思考共用的 250ms 合并器

- [ ] 2.1 开工核对：
  - 重读 `server/src/sessions/supervisor.ts` 的 `#commit`（`:672-715`）、`#publish`（`:721-735`）、`#retireSlot`；
  - 重读 `thinking-buffer.ts` 全文、`turn-control.ts:236-244` 的 `persistEvent`、`store.ts:522-542` 的 `appendDelta`；
  - 列出 `server/test` 中断言 `text.delta` / `thinking.delta` 条数或逐条内容的全部用例（`grep -rn '"text.delta"\|"thinking.delta"' server/test`），作为 2.4 的改写清单。
  验证：清单与核对结果写进 PR。
- [ ] 2.2 新建 `server/src/sessions/delta-coalescer.ts`，实现 chat-stream「正文与思考增量的时间窗合并」：
  - 规则：前沿、250ms 时间窗、一次只缓冲一类、换类冲刷、非增量事件前冲刷、终态冲刷、注入时钟；
  - 对外接口：`add(slot, generation, messageId, kind, delta)`、`flush(slot)`、`discard(slot)`、`clearTimer(slot)`；
  - 发布端口按类别分两条：
    - 思考：`append` 后 `publish`，沿用 `thinking-buffer.ts` 的端口；
    - 正文：`persistEvent` / `appendDelta` 后 `publish`。
  - 删除 `thinking-buffer.ts`，`supervisor.ts` 改用新模块。`supervisor.ts` 行数不得增加超过它删掉的行数（总数 ≤800）。

  **本组的首刀（2a）只接思考**：正文仍走今天的逐帧路径。后继（2b）再把 `text.delta` 接入合并器。
  验证：`server/test/delta-coalescer.test.ts` 以注入时钟覆盖：
  - 规格「首段立即、之后按时间窗」「两类交错保持次序」「非增量事件前冲刷」三例；
  - thinking-fold 改写后的「合并与落库」「字节阈值与时钟阈值」「其它事件前冲刷」「上限与截断标记」「回放与刷新」；
  - 发布失败返回 false 且不推进；`discard` 后不发布。

  原 `thinking-buffer.test.ts` 的 M1–M7 逐条迁移或改写；M1 字节阈值改为「不设字节阈值」。改写写进偏离记录。
- [ ] 2.3 接入正文（2b）：`#commit` 把 `text.delta`（含 `command_output` 映射的）交给合并器，发布时在同一同步段内 `persistEvent` 并入 ring。验证：`server/test/session-delta-coalescing.test.ts`（fake-omp + 注入时钟）覆盖以下四例：
  - 规格「快照与重连不重复」：合并器缓冲期间读快照，再续流；
  - 「崩溃时的缓冲」两例；
  - 停止路径：`turn.end stopped` 前冲刷。
- [ ] 2.4 改写 2.1 清单里因合并而变化的既有用例，只按「通用纪律」允许的两种改法；chat-sessions 的 `Normal actual-child turn`、`Crash with unflushed residual`、`Local command output…` 等场景照旧成立，原断言保留。验证：`make check` 全绿；偏离记录逐条列出旧 → 新。
- [ ] 2.5 官方 omp 取证：新增 `server/test/omp-official-delta-coalescing.test.ts`，经 `server/test/support/omp-official-proxied.ts` 的代理夹具发送含 `WORKBUDDY_PACE` 的 prompt，断言规格「官方 omp 上的合并取证」里关于 `text.delta` 与 `thinking.delta` 的部分（`thinking.end` 与 `thinkingMs` 在组 3 追加）。上限 7 先实测：贴出实际条数与时长；若实测超过 7，先改 design D9 的推算与规格数字，再写断言。验证：`WORKBUDDY_OMP_TEST=1` 下该文件通过，贴出时长。
Suggested fixture level: expanded - 改发布次序、快照前缀与落库的交界（并发 / 次序 / 部分输出三个风险包），回归面是全部会话事件。
Minimal mergeable slice: 2.2 只接思考（替换 `thinking-buffer.ts` 的阈值逻辑，正文仍逐帧发布），配 2.2 的单测与思考相关既有用例的改写——它独立合入后思考按新节奏发布、正文不变，全部测试保绿；2.3–2.5 是后继。

## 3. thinking-fold / chat-web — 思考时长：迁移 044、`thinking.end`、快照与 web 契约

- [ ] 3.1 开工核对：
  - 重读 043 迁移与其测试（`server/test/` 中 `migration-043` 相关文件）；
  - 重读 `store.ts` 的 `MESSAGE_COLUMNS` / `getMessages`、`store-branch.ts` 的 fork 拷贝列清单、`rest.ts` 的快照形状；
  - 重读 `web/src/lib/session-contract.ts` 的消息解码器（严格键集）、`web/src/features/chat/stream.ts` 的事件解码表与 `stream-thinking.ts`。
  验证：核对结果写进 PR。
- [ ] 3.2 **首刀（3a）**：迁移 `server/src/core/db/migrations/044_chat_message_thinking_ms.sql`，按 thinking-fold「迁移 044 思考时长列」实现。只加列，不读不写。验证：迁移测试覆盖规格两例（新库与存量库、中途失败可重试），受信迁移计数加一。
- [ ] 3.3 新建 `server/src/sessions/thinking-span.ts`，按 thinking-fold「思考时长记录与下发」实现：
  - 开段：按帧到达时刻；
  - 闭段：先冲刷合并器，再累计、写 `thinking_ms`，然后同一同步段发布 `thinking.end`；
  - 终态前闭段；
  - infra fault 与崩溃不补写。

  `supervisor.ts` 只加对 `thinking-span.ts` 的调用，行数 ≤800；放不下时先把 `#commit` 的增量分派搬进 `delta-coalescer.ts` 或 `thinking-span.ts`，不调阈值。
  `events.ts` 的 `ChatEvent` 加 `thinking.end`。`store-thinking.ts` 加 `setThinkingMs`。fork 拷贝 `thinking_ms`，regenerate 随行删除。快照 `MessageView` 加 `thinkingMs`。
  验证：`server/test/session-thinking-span.test.ts`（fake-omp + 注入时钟）覆盖规格「单段思考」「多段思考累计」「停止与失败」「中断后无法恢复」「写库失败」，以及 chat-stream 改写后的「Ordered publication after persistence」（含 `thinking.end`）。fork 与 regenerate 各一例（turn-control「从此处分叉 REST」改写后的拷贝断言含 `thinkingMs`）。
- [ ] 3.4 web 契约（与 3.3 同一 PR，严格键集要求同刀）：
  - `session-contract.ts` 消息解码加 `thinkingMs`（chat-web「API 客户端扩展」#910 段）；
  - 事件解码加 `thinking.end`（「事件流消费与续流」）；
  - 视图加 `thinkingMs` / `thinkingActive` 与归约（「纯会话视图归约」），解码与归约写在 `stream-thinking.ts`；
  - `runtime-convert.ts` 透传两字段（「会话页源码模块划分」）。

  本组不改任何呈现：标题仍为 `深度思考过程`，组 6 才换。
  验证：web 单测覆盖规格「消息 thinkingMs 键严格解析」「思考结束事件经同一游标过滤并严格解码」「思考时长与进行中标记归约」三个场景的全部 WHEN；既有快照夹具补 `thinkingMs` 键，改写列进偏离记录。
- [ ] 3.5 证据：
  - `smoke/session-meta.hurl` 加 `thinkingMs` 断言（chat-harness「等待与思考呈现的冒烟与走查」第一段）；
  - 2.5 的官方 omp 用例追加 `thinking.end` 与快照 `thinkingMs` 断言；
  - 验收清单新增「刷新后思考时长不变」一行。

  验证：`make smoke`、`WORKBUDDY_OMP_TEST=1` 下 2.5 的文件、`make ui-walk` 全绿。
Suggested fixture level: expanded - 新增公开事件与快照键（严格键集须服务端与 web 同刀）、新列、闭段次序，跨持久化与公开契约。
Minimal mergeable slice: 3.2 迁移 044 单独合入（expand：只加列，无读写方，全部测试保绿）；3.3–3.5 是后继，三者必须同一 PR（快照新键与 web 严格解析同刀，见 chat-web「API 客户端扩展」）。

## 4. omp-test-harness — 闸门停点标记 `WORKBUDDY_HOLD_AT`

- [ ] 4.1 开工核对：重读 `fake-upstream.mjs` 的 `holdFinal`（`:331-360`）、`releaseHeld`（`:287-308`）与 `thinkFrames`；确认停点只改「停住前写出哪些帧、`remaining` 里放哪些帧」。验证：核对结果写进 PR。
- [ ] 4.2 实现 `WORKBUDDY_HOLD_AT:empty|thinking`（omp-test-harness「受控上游节奏与闸门停点标记」第二项）：取值非法或无已武装闸门时逐字节不变；放行仍单次、TTL 与 409 规则不变。验证：`server/test/fake-upstream-hold-at.test.ts` 覆盖规格「闸门停点」全部 WHEN；既有闸门用例不改且全过。
Suggested fixture level: compact - 只动测试夹具；行为由单测直接钉住。
Minimal mergeable slice: atomic - 一个标记、两个取值共享同一处 `remaining` 构造，单个取值不能独立服务任何走查步骤（组 5 用 `empty`，组 6 用 `thinking`，两者同一 PR 内的差别只有一行条件）。

## 5. chat-web — 等待指示与小圆点

- [ ] 5.1 开工核对：重读 `message-thread.tsx:166-183`（光标）、`MessageBody` 的调用处与「可见块」各部分的渲染条件（思考、正文、工具调用组、已结算审批、错误 / 重试提示）；`grep -rn 'message-caret' web/test web/e2e` 列出全部引用。验证：核对结果写进 PR。
- [ ] 5.2 实现 chat-web「消息线程」的「等待与小圆点」段：
  - 判据函数是纯函数，放进新模块 `web/src/features/chat/message-waiting.tsx`（含等待指示组件）；
  - 小圆点沿用 `data-slot="message-caret"`，外观为圆形，带脉动动画；
  - 两者的 reduce 处理见 design D6。

  验证：jsdom 覆盖规格「等待指示」全部 WHEN，以及改写后的「消息呈现与流式光标」。光标相关既有断言（`chat-messages.test.tsx:90-108`、`chat-stop-button.test.tsx:240,277`、`chat-thread-runtime.test.tsx:31`）按新外观改写，列进偏离记录。
- [ ] 5.3 走查：chat-harness「等待与思考呈现的冒烟与走查」第 1、2 步（小圆点形状与动画；`HOLD_AT:empty` 下的等待指示）。既有 `ui-walk-layout.ts:361-390` 的光标断言并入第 1 步。改写验收清单 CH-03（「生成中正文末尾有一个闪烁的光标」），新增等待指示一行。验证：`make ui-walk` 两个 project 全绿，新增步骤的时长贴进 PR。
Suggested fixture level: compact - 纯前端呈现，判据只读既有视图字段，不改契约。
Minimal mergeable slice: atomic - 规格要求运行中二者恰显示一个，同一判据的两面；只做一半会出现「二者都在」或「二者都不在」的中间态。

## 6. thinking-fold — 折叠块标题三态与流式预览

- [ ] 6.1 开工核对：重读 `thinking-fold.tsx` 全文与文件头注释；拷入 `reasoning.tsx` 的 `ReasoningRoot`（受控时 `isPreview = streaming && open`）、`ReasoningText`（预览贴底）、`ReasoningContent`（渐隐层）；`web/test/chat-thinking.test.tsx` 与 `web/e2e/ui-walk-sessions.spec.ts:317-340`。验证：核对结果写进 PR。
- [ ] 6.2 **首刀（6a）**：标题三态。在应用层用拷入的 `CollapsibleTrigger` 组合触发器，不用 `ReasoningTrigger`（design D8）。文案规则见 thinking-fold「深度思考折叠块呈现」第二段。验证：
  - jsdom 覆盖规格「流式展开、终态收起」「标题三态与多段思考」「用户手动切换保留」；
  - 走查改写 chat-harness「UI 走查会话元数据」第 4 步（终态标题匹配 `已思考 N 秒`）；
  - 验收清单改写描述 `深度思考过程` 的行，新增标题三态一行；
  - `make ui-walk` 全绿。
- [ ] 6.3 流式预览（6b）：
  - 传 `streaming={running}`；
  - 主体两态都 `max-h-48 overflow-auto`；
  - 父类同时隐藏底部渐隐层；
  - 更新文件头注释（为何预览不再与贴底冲突，design D7）。

  web 测试按 `chat-scroll-follow.test.tsx` 的先例桩 `ResizeObserver`。
  验证：
  - jsdom 覆盖「终态消息主体限高」中可在 jsdom 观察的部分：`data-running`、类名、渐隐层不渲染或隐藏；
  - 走查覆盖 chat-harness「等待与思考呈现的冒烟与走查」第 3 步（`HOLD_AT:thinking`）；
  - 实测：120 行思考贴底时转录保持贴底、盒内上滚后不被拉回（走查或一次性脚本，输出贴进 PR）。
Suggested fixture level: compact - 前端呈现；契约由组 3 提供。
Minimal mergeable slice: 6.2 标题三态单独合入（只换触发器文案，主体与预览不变，走查第 4 步同刀改写，全部保绿）；6.3 预览是后继。

## 7. chat-web / thinking-fold — 正文与思考的逐字展开

- [ ] 7.1 开工核对：重读 `markdown-body.tsx:50-57`、拷入 `markdown-text.tsx` 的 `smooth` 透传、`node_modules/@assistant-ui/react/dist/utils/smooth/useSmooth.js`、`node_modules/@assistant-ui/react-markdown/dist/primitives/MarkdownText.js` 的 `data-status` 与 `styles/dot.css`。确认 design D8 推出的分支仍然成立：挂载显示全文；终态（`false`）立即全文；reduce 停用；part 状态为「已完成」时基元不置 `running`。验证：核对结果写进 PR；与 D8 不符时先改 design。
- [ ] 7.2 **首刀（7a）**：正文平滑。
  - 新模块 `web/src/features/chat/smooth-text.tsx`：应用层的 `useSmooth` 包装，正文与思考共用。
  - 助手正文经它把要显示的前缀交给 `MarkdownBody`；消息 running 时启用。
  - `markdown-body.tsx` 仍传 `smooth={false}`。
  - `复制` 与搜索的数据源不变。
  - ADR-0013 增补一条：正文逐字显现重新启用（owner 2026-10-06 / 2026-10-14，#910），在应用层用 `useSmooth` 实现，取代「正文不能落后于已到达的数据」；基元的 `smooth` 仍关。

  验证：jsdom（假定时器驱动 `requestAnimationFrame`）覆盖 chat-web「消息线程」「正文逐字展开」全部 WHEN，含 `matchMedia` 桩出 reduce 的一例，以及「展开期间容器无 `data-status=\"running\"`、只有一个小圆点」。另有一条 `useSmooth` 行为钉子：用例名注明「依赖 @assistant-ui/react useSmooth 分支」，升级改了分支时在这里判红。
- [ ] 7.3 思考平滑（7b）：`thinking-fold.tsx` 经 `smooth-text.tsx` 取主体文本。验证：jsdom 覆盖 thinking-fold「思考的逐字展开」全部 WHEN；验收清单新增「回答与思考逐字出现、结束时立即完整」一行。
Suggested fixture level: compact - 前端呈现，复用已安装依赖的现成规则。
Minimal mergeable slice: 7.2 正文平滑单独合入（思考仍收到即显示，全部保绿）；7.3 是后继。
