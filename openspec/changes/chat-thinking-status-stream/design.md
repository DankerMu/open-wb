# Design: chat-thinking-status-stream

## Context

#910 的需求与 owner 裁定散在三个时间点：

- 2026-10-06：issue 正文四条——等待指示、思考标题与时长、250ms 合并加前端平滑、小圆点。
- 2026-10-13：grill。Q9 异常回合的时长按回合结束时刻计；Q15 启用流式预览。
- 2026-10-14：设计期四问——共用合并器且思考仍先落库后发布、平滑沿用 assistant-ui 规则、时长为累计毫秒加每段结束事件、等待指示在任何可见块出现时消失。

现状（读代码，2026-10-14）：

- **正文**：`events.ts:198-199` 每个 `text_delta` 帧映射为一条 `text.delta`。`supervisor.ts` `#commit`（`:672-715`）对每条事件先 `persistEvent`、再 `#publish`，不合并。
  - `persistEvent` 对正文调用 `store.appendDelta`（`turn-control.ts:242-244`），后者进内存 `pending`，满 2048 字节或 2000ms 才写库（`store.ts:522-542`、`:268`）。
  - 快照取「已落库 + 本回合 pending」（`store.ts:349`）。pending 里只有已发布的增量，所以快照恒等于已发布前缀；快照游标与之在同一同步段内读取（`rest.ts:195-199`）。
- **思考**：
  - `thinking-buffer.ts` 每个 slot 一个缓冲，满 2048 字节、自首段起 2000ms（注入时钟），或即将发布其它事件时冲刷。
  - 冲刷是一个同步段：`append`（`store-thinking.ts`，32768 码点上限与截断标记）后紧接 `publish`。所以 `chat_messages.thinking` 恒等于已发布片段之和。
  - `#commit` 对每条非思考事件先 `flush`，`#publish` 再冲刷一次，供审批发布用。
- **时间**：
  - 消息只有 `created_at`（受理时刻）。
  - omp v18.0.10 的 `thinking_start` / `thinking_end` 帧没有时间戳（`resource/oh-my-pi/packages/ai/src/types.ts:702-707`、`:1294-1296`）；本仓也按 thinking-fold 规格忽略这两种帧。
  - 所以时长只能用服务端自己的时钟量。
- **前端**：
  - 方块光标 `span[data-slot=message-caret]` 是 `MarkdownBody` 之后的兄弟元素（`message-thread.tsx:166-183`）。
  - `MarkdownBody` 显式传 `smooth={false}` 关掉逐字显现（`markdown-body.tsx:50-57`）。拷入的 `markdown-text` 已按「第六类修改」透传 `smooth`（ADR-0013）。
  - 折叠块 `thinking-fold.tsx` 用不带滚动锁的 `ReasoningRoot`，受控 `open`，不传 `streaming`。
  - 拷入的 `ReasoningTrigger` 把文案写死为 `深度思考过程`（`reasoning.tsx:186`）。
- **滚动**：`thread-viewport.tsx` 用自己的贴底跟随（容差 4px；`ResizeObserver` 观察视口与内容根；`onScroll` 只在 `scrollTop` 变小且离底 >4px 时解除贴底）。
- **文件行数**：`supervisor.ts` 791 行、`store.ts` 788 行、`stream.ts` 773 行，都贴近 800 行守卫。新逻辑必须进新模块。

## Goals / Non-Goals

**Goals**

- 回合开始到首块内容之间有文字状态；正文光标换成小圆点。
- 思考标题三态，时长服务端记录，刷新后不变。
- 正文与思考按同一条 250ms 规则合并发布，事件更少、首段立即；前端逐字展开，看起来连续。
- 启用思考的流式预览，不破坏转录区的贴底跟随与 `回到最新`。

**Non-Goals**

- 思考内容的 Markdown 渲染、思考内容的复制（#910 范围外）。
- 等待模型的其它时段（工具执行完、等下一轮响应）的指示（owner 2026-10-14：指示只在首块出现前）。
- 改正文落库节奏（仍 2048 字节 / 2000ms；owner 2026-10-14）。
- 把 omp 的 `thinking_start` / `thinking_end` 帧当作思考内容的来源（thinking-fold 现有「不作为来源」条文不变）。`thinking_end` 帧的**到达时刻**作为一段思考的结束信号使用（D3），不产生内容。
- 给 `step` 卡、审批、`files.changed` 等其它事件做合并。
- 旧消息的时长回填（迁移不回填，历史消息标题 `深度思考过程`）。

## Decisions

### owner 的裁定（已定，不是选项）

| # | 裁定 | 日期 |
|---|---|---|
| O1 | 等待指示文案统一 `正在思考…`；思考标题进行中 `正在思考…`、结束后 `已思考 N 秒`、无数据 `深度思考过程`；时长服务端记录 | 2026-10-06 |
| O2 | 正文与思考同一条 250ms 规则；前端逐字展开、回合结束立刻补齐；reduce 下不展开；复制与搜索以全文为准；正文光标换小圆点 | 2026-10-06 |
| O3 | 异常回合的时长按回合结束时刻计；无法恢复结束时刻的显示 `深度思考过程` | 2026-10-13 Q9 |
| O4 | 启用拷入组件的流式预览，先解决与贴底跟随的冲突 | 2026-10-13 Q15 |
| O5 | 一个合并器；正文落库照旧；思考仍先落库后发布（至多每 250ms 一次写库） | 2026-10-14 |
| O6 | 平滑沿用 assistant-ui `useSmooth` 的规则 | 2026-10-14 |
| O7 | 时长为可空累计毫秒数；每段思考结束时发布 `thinking.end{messageId, thinkingMs}`；快照带该字段 | 2026-10-14 |
| O8 | 等待指示在任何可见块出现时消失，同一回合不再出现 | 2026-10-14 |

### 起草者的技术决定

**D1 合并器：带前沿的节流，一次只缓冲一类。** 新模块 `server/src/sessions/delta-coalescer.ts` 取代 `thinking-buffer.ts`（删除旧文件，测试迁移）。每个 slot 一个合并器，状态为当前缓冲的类别（`text` 或 `thinking`）、消息 id、文本、定时器，外加每类最近一次发布时刻。规则如下：

- 到达一段 `kind` 类增量时：
  - 若缓冲里是另一类，先冲刷它。
  - 若缓冲为空，且该类本回合从未发布过或距上次发布已满 250ms，立即发布这一段（前沿）。
  - 否则并入缓冲，若未计时，则在「上次发布 + 250ms」到点时发布缓冲。
- 即将发布任何非增量事件（`step.*`、`files.changed`、`approval.*`、`todo.updated`、`turn.retry`、`thinking.end`、`error`、`turn.end`）之前，冲刷缓冲。
- 回合终态（含 `applyFailure` / `applyStop` 的退回、优雅关停）之前，冲刷缓冲。
- 每次发布都记为该类的「上次发布」。

这条规则满足 issue 的「首段立即、之后每 250ms 至多一条、其它事件前冲刷、保持次序」。「首段」按「空闲后的首段」解释：一段思考被工具调用打断后，新的一段同样立即发出。2048 字节阈值取消：时间窗已经限定了事件频率，单条事件的大小不设上限（上游突发时一条事件可能较大，与今天正文一帧一事件相比只会更少）。时钟为注入的 `SessionClock`（沿用 `thinking-buffer.ts`）。

放弃的方案：
- 纯尾沿节流（首段也等 250ms）——违背「首段立即」。
- 两类各自缓冲、可同时持有——两类交错时次序需要额外记账，而「冲刷另一类」天然保持到达次序。

**D2 合并器在落库之前；两类的发布仍各走原来的落库纪律。** 发布一条合并后的事件时：

- **正文**：在同一同步段内 `persistEvent`（即 `appendDelta`，进 store pending）并入 ring。
- **思考**：在同一同步段内 `append`（写列，返回实际保存的片段）并入 ring。片段为空（已达上限）时不发布。

store 只看到已发布的增量，所以：

- 「快照 = 已落库 + pending = 已发布前缀」不变，chat-sessions「Complete snapshot overlap boundary」不改。
- 「列值恒等于已发布片段」不变，32768 码点上限与截断标记的规则不改。
- 合并器里尚未发布的文本不在快照里、也不在 ring 里。重连客户端之后收到的合并事件是快照游标的后继，不会重复。

落库或发布失败照旧走 owned error-sink（slot 进 infraFaulted、退役）。退役时丢弃合并器缓冲，与今天丢弃思考缓冲一致。今天 store 的保留规则只覆盖已进 pending 的部分；合并器里未发布的那一截不在其中（store 是否 faulted 取决于退役原因，observer 违约经 `#faultSlot` 退役时 store 并未 fault，结论不变）。

**D3 时长：服务端时钟、按段累计、开段清空、闭段先落库再发布。** 新模块 `server/src/sessions/thinking-span.ts`。每个 slot 记 `spanStart: number | null` 与本消息本回合的累计毫秒 `total`：

- **开段**：`#commit` 处理到一条 `thinking.delta`（合并之前、按帧到达时刻）且 `spanStart` 为 null 时，记 `spanStart = clock.now()`，并把 `chat_messages.thinking_ms` 置为 NULL（同步写）。开段清空让「段开着」在库里可见：
  - 中途刷新时快照 `thinkingMs` 为 `null`，前端据此判断「思考进行中」（D5），不再需要近似；
  - 宿主进程在任一段开着时退出，重启后该消息的 `thinking_ms` 为 NULL，标题为 `深度思考过程`。这与 O3「无法恢复结束时刻 → `深度思考过程`」字面一致，第二段中途崩溃也不会显示只含第一段的残值。
- **闭段**：以下两者先到者触发。
  - (a) pump 读到该回合的原始 `message_update{assistantMessageEvent:{type:"thinking_end"}}` 帧。omp 在思考块结束、下一个块（正文或工具调用）开始时发它（`resource/oh-my-pi/packages/ai/src/providers/openai-completions.ts:893-902` `finishCurrentBlock`）。
  - (b) `#commit` 或 `#publish` 即将处理任何非思考事件。

  只用 (b) 会把模型流式生成工具参数的时间算进「已思考」：toolcall 帧被归约器当作噪声丢弃（chat-stream「纯协议事件归约」），段要等到 `step.start` 才闭。`thinking_end` 只用作时间信号，不作为内容来源。

  闭段时依次：
  1. 冲刷合并器；
  2. `total += max(0, now − spanStart)`（墙钟回拨时这一段记 0，不写负数——web 的严格解析会因负数拒收整个快照）；
  3. `UPDATE chat_messages SET thinking_ms = total`；
  4. 在同一同步段内发布 `thinking.end{messageId, thinkingMs: total}`；
  5. 置 `spanStart = null`；
  6. 再处理触发它的事件（(b) 时）。

  回合终态事件同样经 (b)，所以被停止、失败（含 omp 子进程崩溃经 `applyFailure` 的退回）的回合按回合结束时刻计（O3）。
- **宿主进程退出**：WorkBuddy 服务端进程在段开着时退出，开着的段无法闭合；开段时已清空，所以 `thinking_ms` 为 NULL。`reconcileOnStartup` 不碰 `thinking_ms`。
- **infra fault**：slot 退役，不补写；开段时已清空，同上。

整数毫秒，取 `Math.round`。达到思考上限后不再发布 `thinking.delta`，但段照常开、闭、计时，`thinking.end` 照常发布：时长量的是模型在想，与保存了多少无关。

放弃的方案：
- 起止时间戳两列——多段时把工具执行时间算进「已思考」。
- 只在 `turn.end` 下发——正文流式期间标题切不到 `已思考 N 秒`。
- 只以「下一非思考事件」闭段——工具参数的流式生成被计入（见上）。

**D4 迁移 044。** `044_chat_message_thinking_ms.sql`：`ALTER TABLE chat_messages ADD COLUMN thinking_ms INTEGER`，可空、无缺省、无 CHECK、无索引，不回填；写法与 043 先例一致。`MessageView` 加 `thinkingMs: number | null`。快照里 user 消息恒为 `null`，没有思考的助手消息为 `null`。regenerate 删除旧行时随行删除。新回合的助手行从 NULL 开始。

**D5 前端视图：`thinkingMs` 与 `thinkingActive`。** 消息视图加两个字段：

- `thinkingMs: number | null`：取快照原值；`thinking.end` 置为事件值。
- `thinkingActive: boolean`：
  - `thinking.delta` 置 `true`；
  - `thinking.end`、`turn.end`、`turn.start` 置 `false`；
  - 由快照生成时为 `status === "running" && thinking 非空 && thinkingMs === null`。

最后一条是精确的：开段时服务端把 `thinking_ms` 置空（D3），所以 running 消息的快照里 `thinkingMs === null` 且已有思考，就是「段开着」。

标题：
- `thinkingActive` 且消息 running → `正在思考…`（流光）；
- 否则 `thinkingMs` 非 null → `已思考 N 秒`，N = `max(1, round(thinkingMs / 1000))`，不出现 `已思考 0 秒`；
- 否则 → `深度思考过程`。

解码与归约放进 `stream-thinking.ts`（`stream.ts` 773 行）。旧客户端遇到未知的 `thinking.end` 保持原状态（既有规则），不破坏。

**D6 等待指示与小圆点：运行中二者恰好显示一个。** 判据「这条助手消息还没有可见块」：思考为 null 或空串、正文为空、没有步骤、没有已结算审批、`error` 为 null 且不在重试中（重试提示本身是可见块）。

- **等待指示**：消息 running 且无可见块时，在正文的位置渲染 `div[data-slot=message-waiting][role=status]`，文本 `正在思考…`，带 `shimmer`；reduce 下动画暂停，沿用折叠块标题的 `shimmer motion-reduce:animate-none`。读屏经 `role=status` 礼貌播报一次。
- **小圆点**：消息 running 且有可见块时，在正文末尾（与今天的光标同一位置，`MarkdownBody` 之后）渲染 `span[data-slot=message-caret][aria-hidden]`：小圆点（`size-2 rounded-[50%]`、品牌色；Tailwind 4 的 `rounded-full` 计算值不是 50%，5a 实测）加一个脉动动画；reduce 下 `animation-name` 为 `none`。保留 `data-slot=message-caret`，走查与单测的定位器不用换名，只换外观与动画断言。
- 终态时二者都不渲染。
- 「同一回合不再出现」由判据自然成立：可见块一旦出现就不会在 running 期间消失（`turn.start` 重置只发生在新回合）。

**D7 流式预览与贴底跟随：限高后两个滚动层互不干扰。** 折叠块传 `streaming={running}`，开合仍受控：拷入的 `ReasoningRoot` 在受控时 `isPreview = streaming && open`，不触发它的「首次手动切换后永久沿用」逻辑（那段只在非受控时生效）。主体类名改为两态都 `max-h-48 overflow-auto`（12rem），不再在 running 时 `max-h-none`。预览时拷入的 `ReasoningText` 用自己的 `ResizeObserver` 把盒内 `scrollTop` 贴到底，用户在盒内上滚则暂停。冲突为何消失：

- 今天 running 时主体不限高，思考增长直接撑高转录内容，由转录贴底跟随；改为限高后，思考增长只改变盒内 `scrollHeight`，折叠块外框高度达到 12rem 后不再变化。
- 盒内滚动事件不冒泡到转录视口（`scroll` 在元素上不冒泡），`thread-viewport.tsx` 的 `onScroll` 只看视口自己的 `scrollTop`。
- 转录的 `ResizeObserver` 观察内容根：折叠块长到 12rem 之前照常触发贴底，之后不再触发；这正是想要的。

仍用不带滚动锁的 Root（锁滚动 200ms 与贴底冲突的理由不变）。拷入 `ReasoningContent` 预览时多渲染一个底部渐隐（`reasoning-fade`，z-10）。它与今天隐藏的顶部渐隐是同一个元素类，现有的父类 `[&>[data-slot=reasoning-fade]]:hidden` 一并隐藏它：它会盖住 `回到最新` 并在搜索高亮上露出页面底色，理由同顶部那条。jsdom 没有 `ResizeObserver`，预览路径会构造它；web 测试按 `chat-scroll-follow.test.tsx` 的先例桩它。

放弃的方案：
- 预览不限高——那就不是预览，回到今天。
- 用拷入默认的 16rem——与终态 12rem 不一致，展开 / 收起之间跳高度。

**D8 标题与平滑都在应用层，拷入层不改。**

- **标题**：`ReasoningTrigger` 的文案写死，而换文案不在六类修改里，所以 `thinking-fold.tsx` 不再用它。改用拷入的 `@/components/ui/collapsible` 的 `CollapsibleTrigger` 在应用层组合同样的结构（图标 `BrainIcon`、文案 span、`ChevronDownIcon`；类名照抄拷入 Trigger 的视觉类）。文案按 D5 三态，进行中带 `shimmer motion-reduce:animate-none`。可访问名等于可见文案。沿用拷入 Trigger 的三个 `data-slot`（`reasoning-trigger`、`reasoning-trigger-label`、`reasoning-trigger-chevron`），既有用例（`web/test/chat-thinking.test.tsx` 按 slot 定位流光与箭头）的 slot 定位不变；但按钮本身原先按可访问名 `深度思考过程` 查找，6a 把这个名字匹配换成三态正则，并改文案断言（6a 实测）。
- **正文平滑**：不打开 `MarkdownText` 的 `smooth`，`markdown-body.tsx` 仍传 `smooth={false}`。原因是基元在平滑追赶期间把容器的 `data-status` 置为 `running`，拷入样式 `@assistant-ui/react-markdown/styles/dot.css` 会因此在最后一块之后加一个脉动的 `●`（读 `node_modules/@assistant-ui/react-markdown/dist/primitives/MarkdownText.js:118-126` 与 `styles/dot.css`），与 D6 的小圆点叠成两个运行指示。

  改为在应用层调用同一个 `useSmooth`：新模块 `web/src/features/chat/smooth-text.tsx` 提供一个组件。它在 `TextMessagePartProvider text={原文}` 内以 `useSmooth(useMessagePartText(), running)` 取出要显示的前缀，再交给子渲染。`MarkdownBody` 收到的就是这个前缀；part 状态始终是「已完成」，所以基元的 `data-status` 不会变成 `running`，`●` 不出现。`useSmooth` 的分支因此如下：
  - 挂载时显示全文（打开或切换到运行中的会话不会从头打字）。原地重新安装快照（重连、gap 恢复）时消息组件不重新挂载，快照比当前多出的那一截按规则在 ≤250ms 内展开，这是可接受的；
  - 之后的增长按 `min(5ms, 250ms ÷ 积压)` 逐字展开；
  - 从空串开始的第一段直接提交；
  - 终态传 `false`：`useSmooth` 停用并立即返回原文，不拖尾；
  - reduce 下 `useSmooth` 自己停用。

  以上分支是读 `node_modules/@assistant-ui/react/dist/utils/smooth/useSmooth.js` 推出的，任务里先用单测钉住再依赖。其中一条未核实：`TextMessagePartProvider` 在文本增长时 `aui.part` 是否保持同一引用。若每次都换引用，`useSmooth` 会走 `partChanged` 分支，在「已完成」状态下直接提交全文，平滑完全不生效。任务 7.1 先钉住这一点；若不成立，在 `smooth-text.tsx` 内保持一个稳定的 provider，只更新文本。
- **与贴底跟随**：逐字展开逐帧改变正文高度。转录区的 `ResizeObserver` 观察内容根，每次高度变化都会调 `settle`，贴底时把视口滚到底；`onScroll` 只在 `scrollTop` 变小且离底 >4px 时解除贴底（`thread-viewport.tsx:79-93`、`:97-120`）。所以展开期间贴着底的转录继续贴底，用户上滚后不被拉回，`回到最新` 的判定不变。任务 7.2 用 jsdom 的滚动跟随用例（`chat-scroll-follow.test.tsx` 的桩法）钉住「展开期间保持贴底」。
- **思考平滑**：`thinking-fold.tsx` 用同一个 `smooth-text.tsx` 组件取主体文本。规则与正文是同一个函数，同一处实现。
- `复制` 与对话内搜索读消息视图的 `content`（`message-action-row.tsx`、`search-match.ts`），本来就不经平滑，不改。
- 撤销 ADR-0013 那条「正文不能落后于已到达的数据」需要 owner 授权；#910 的 owner 裁定就是授权。ADR-0013 补一条记录：逐字显现在应用层用 `useSmooth` 做，基元的 `smooth` 仍关（它压掉的运行指示点理由不变）。

**D9 受控假上游的节奏标记。** `server/test/support/fake-upstream.mjs` 增加标记 `WORKBUDDY_PACE`：最后一条 user 文本含它时，正文轮的发送节奏如下，其余不变。

1. 先发 3 个 `reasoning_content` 分片（与 `WORKBUDDY_THINK` 相同的三段），每片间隔 25ms；
2. 再发 40 个正文分片，每片 1 个 `字`（拼接恰为 40 个 `字`），间隔 25ms。

总时长约 1.1s，跨过 4 个时间窗。无标记请求逐字节不变。官方 omp 测试的断言只取在真实链路上稳定、可观察的量：

- 正文 `text.delta` 少于 40 条（合并确实发生）；
- 第一条 `text.delta` 的 `delta` 恰为一个 `字`（前沿只发布第一段，不等 250ms）；
- 拼接逐字为 40 个 `字`；
- `thinking.delta` 拼接为那三段；
- 恰有一条 `thinking.end`，位于第一条 `text.delta` 之前；
- 快照 `thinkingMs` 为非负整数。

不写条数上限：它取决于 CI 负载下 40 个分片的实际到达跨度，写死会误红。按 1 + ⌈1000/250⌉ + 1 推算约 6–7 条，任务实测后把条数与时长写进 PR，不进断言。

**D10 闸门停点与走查、冒烟。**

**闸门停点。** 既有 ui-walk 闸门（`WORKBUDDY_UI_WALK:<uuid>`，`fake-upstream.mjs` `holdFinal`）在停住之前放出三类帧：角色帧、思考帧（带 `WORKBUDDY_THINK` 时）与第一段正文。这样等待指示与思考进行中的标题只存在一瞬，走查量不到。为此在闸门上加一个停点标记 `WORKBUDDY_HOLD_AT:<point>`，与闸门标记同在最后一条 user 文本里时生效。`<point>` 取到下一个空白字符或文本末尾为止。

- `empty`：只放出角色帧就停住，思考帧与全部正文在放行时发出；
- `thinking`：放出角色帧与思考帧后停住，全部正文在放行时发出；不带 `WORKBUDDY_THINK` 时同 `empty`；
- 不带该标记：行为逐字节不变（今天的停点：第一段正文之后）。

停点标记没有已武装闸门时无效；取值不是这两者时（含 `emptyX` 这类粘连）按不带处理。

**长思考素材。** 规格要求「running 思考长到 120 行时盒内贴到最新行、转录仍贴底」。`WORKBUDDY_THINK` 的三段短思考撑不满 12rem：盒内 `scrollHeight <= clientHeight` 时拷入的 `isAtBottom` 恒真，断言在任何实现下都成立。为此加标记 `WORKBUDDY_THINK_LONG`，用法同 `WORKBUDDY_THINK`，但三个思考分片合起来是 120 行（`思考第 1 行\n…思考第 120 行`，三片各 40 行）。它可与 `HOLD_AT:thinking` 组合，走查据此做持久的贴底断言。

**冒烟。** `make smoke` 的 `smoke/session-meta.hurl` 在既有 `WORKBUDDY_THINK` 用例上加断言：助手消息 `thinkingMs` 为整数，user 消息为 null。

**ui-walk 的宿主。** ui-walk 的假上游以默认的 `toolRoundScope:"history"` 运行，新会话的第一个请求是 bash 工具轮（带审批），闸门只作用于答复轮。所以等待指示与思考进行中的步骤不能放在新会话里：工具步骤与审批会先成为可见块。宿主是主旅程 `web/e2e/ui-walk.spec.ts` 的受闸会话：在主旅程既有步骤全部完成之后、清理之前，于同一会话（历史已含 `tool` 消息，后续请求直接是答复轮）追加受闸 prompt。放在既有步骤之后，「恰两条 user、两条 assistant」之类的既有计数断言不受影响（先例：`web/e2e/ui-walk-stop.ts` 的同会话第二条受闸 prompt）。

**ui-walk 的步骤。**

- **小圆点**：两个 project 都断言 running 助手消息的小圆点计算 `border-radius` 为 50%、no-preference 下 `animation-name` 不为 `none`。reduce 下为 `none` 沿用既有切换，只在 desktop-light 跑（`ui-walk.spec.ts:407`、chat-harness「流式光标在减少动态效果下不闪烁」）。
- **等待指示**：用 `HOLD_AT:empty` 发一条，断言助手消息里 `正在思考…`（`role=status`）可见、没有小圆点、没有折叠块；放行后它消失、正文出现，回合结束后小圆点消失。
- **思考进行中与预览**：用 `WORKBUDDY_THINK_LONG` 加 `HOLD_AT:thinking` 发一条，断言：
  - 折叠块标题为 `正在思考…`，根元素带 `data-running`；
  - 主体计算 `max-height` 为 192px，`scrollHeight > clientHeight`，`scrollTop + clientHeight` 与 `scrollHeight` 相差 ≤1px（贴到最新行）；
  - 转录距底 ≤4px；
  - 放行后（含回合结束后）标题匹配 `已思考 \d+ 秒`。「闭段即切标题」的时刻由 jsdom 场景证明；放行时剩余帧一次发完，`thinking.end` 到 `turn.end` 之间只有毫秒，走查不量。
- **会话元数据步骤 4**：终态折叠块的标题从 `深度思考过程` 改为匹配 `已思考 \d+ 秒`。

## 规格影响

- **改**（MODIFIED）：
  - turn-control：「从此处分叉 REST」（拷贝断言加 `thinkingMs`）。
  - thinking-fold：「thinking.delta 合并发布与持久化」「深度思考折叠块呈现」「reasoning 前提与真运行时取证」（后者只改一处过时的合并说明）。
  - chat-stream：「思考与文件变更事件发布」。
  - chat-web：「API 客户端扩展」「纯会话视图归约」「事件流消费与续流」「会话页源码模块划分」「消息线程」。
  - chat-harness：「UI 走查会话元数据」。
  - chat-sessions：「会话 REST」（消息形状、严格键集与 fork 拷贝列表加 `thinkingMs` / `thinking_ms`；#909 加 `error` 的先例）。
  - omp-test-harness：「Isolated bounded upstream dialogue gate」「受控上游思考与写入标记」（各加一句：带 `WORKBUDDY_HOLD_AT` 时停点见新要求）。
- **加**（ADDED）：
  - thinking-fold：「思考时长记录与下发」「迁移 044 思考时长列」。
  - chat-stream：「正文与思考增量的时间窗合并」。
  - chat-harness：「等待与思考呈现的冒烟与走查」。
  - omp-test-harness：「受控上游节奏与闸门停点标记」。
- **仍成立、不改**：
  - chat-sessions「会话持久化与回合刷盘」：`appendDelta` 的 2048 / 2000ms 落库规则；合并器在它之前。
  - chat-sessions「Complete snapshot overlap boundary」（D2）。
  - chat-sessions「Supervisor ordered persistence and publication」：「text SHALL enter the existing store buffer unchanged」——合并后的事件文本原样进入 buffer；「at least three text deltas」说的是上游帧数，不是事件数。
  - chat-stream「纯协议事件归约」：帧到事件的映射不变，合并在 supervisor。
  - chat-harness「UI 走查对话步骤」：「流式光标在减少动态效果下不闪烁」对小圆点仍成立（同一 `data-slot`）。

## Risks / Trade-offs

- **[既有测试按「一帧一事件」断言]** → `server/test` 里断言 `text.delta` 条数或逐条内容的用例会因合并而变化。实现期逐个列出旧 → 新，只允许把「N 条」改为「拼接相等」或注入时钟后的确定条数，不删断言。
- **[思考写库变频]** → 思考期间每 250ms 至多一次小 `UPDATE`（O5 接受）；SQLite WAL 下可忽略（推算），不做基准。
- **[`useSmooth` 的行为依赖 0.x 内部分支]** → D8 读代码推出，任务先写单测钉住「挂载显示全文」「终态立即全文」「reduce 不展开」「展开期间基元的 `data-status` 不为 `running`」，assistant-ui 升级改了分支时先在这里判红。
- **[时长的服务端时钟]** → 量的是服务端看到思考增量与 `thinking_end` 的时间，包含网络与 omp 的转发延迟，不是模型真实思考时长；O1 接受「服务端记录」。墙钟回拨时该段记 0（D3）。
- **[开段清空 `thinking_ms`]** → 每段多一次小 `UPDATE`；换来中途刷新的精确标题与崩溃后符合 O3 的 `深度思考过程`。
- **[两类紧密交错时合并失效]** → 一次只缓冲一类，所以思考与正文逐帧交替时，每帧都要冲刷另一类，退化为一帧一事件，每次从思考切到正文还要多一条 `thinking.end`（chat-stream「两类交错保持次序」：5 帧 → 7 条事件）。接受：真实上游先连续发思考、再连续发正文，不按 token 交错（omp 的思考块与正文块是不同的 content 块）；退化时事件数也不会多于今天的逐帧发布加上每次切换的一条 `thinking.end`。
- **[事件拼接仍等于全文，但事件更大]** → 单条 SSE 帧变大，客户端每次重渲染的增量变大；平滑抵消了观感上的跳跃。
- **[预览盒内贴底与用户阅读]** → 用户在盒内上滚即暂停贴底（拷入行为），回到盒底恢复。
- **[stop 与合并缓冲]** → stop 不发事件，缓冲留到 `turn.end stopped` 前冲刷（D1 的终态冲刷）；被丢弃的只有 infra fault 路径（D2）。

## Migration Plan

- 迁移 044 只加列，不回填，回滚即不再读该列。
- 线协议只增不改：
  - 新 SSE 事件 `thinking.end`：旧前端按「未知事件保持原状态」忽略，服务端可以先于 web 发布它。
  - 快照新键 `thinkingMs`：web 的消息解码是严格键集，缺键或多键都整体拒绝。所以服务端快照加键与 web 解析器加键必须同一 PR 落地，不设兼容窗口（#909 `error` 键的先例；tasks 3.4，切片 3c）。
- 按 Stage 5 的子 issue 顺序合并：服务端合并器 → 时长 → web 契约与视图 → 呈现 → 走查。每一刀都保绿。

## Not yet specified

- **`已思考 N 秒` 的取整边界**：`round` 与 `max(1, …)` 已定，是否在 ≥60 秒时换算成「分秒」没有人提过；不做，等验收反馈。

## Sketch seams under test

- **`createDeltaCoalescer` + 注入时钟（新，纯）**：前沿、时间窗、换类冲刷、终态冲刷、发布失败。选它是因为规则全在这里，单测最便宜。
- **`createThinkingSpans` + 注入时钟 + 假端口（新，纯）**：开段清空、两种闭段信号、累计与钳位、多段、停止 / 失败 / 宿主退出 / 回拨的时长值。fake-omp 造不出「思考进行中尚未 `thinking_end`」「两段思考夹工具」「工具参数流式」这些帧序列（它的 `--hold-after-thinking` 在 `thinking_end` 之后才挂起），所以带毫秒值的场景都在这一层证。
- **`SessionSupervisor` + fake-omp（既有）**：ring 次序、快照前缀、`thinking.end` 紧随 `thinking_end` 发布且先于下一事件、`thinking_ms` 列有值、无 reasoning 时无 `thinking.end`。这是既有服务端集成测试的最高接缝，只证次序与接线，不证毫秒值。
- **官方 omp + 受控假上游（既有，`WORKBUDDY_OMP_TEST=1`）**：`WORKBUDDY_PACE` 下的事件数与首段即时。只有真 omp 的帧节奏能证明合并在真实链路上生效。
- **`Thread` + jsdom（既有）**：等待指示 / 小圆点互斥、标题三态、平滑的三条边界、复制与搜索读全文。
- **`make ui-walk` / `make smoke`（既有）**：计算样式（小圆点动画、预览限高）、终态标题、快照字段。

## Traceability

| 来源 | 落点 |
|---|---|
| 需求 1 等待指示 | O1、O8、D6；chat-web「消息线程」；tasks 组 5 |
| 需求 2 标题与时长 | O1、O3、O7、D3、D4、D5、D8；thinking-fold 两条新增要求与「深度思考折叠块呈现」；tasks 组 3、组 6 |
| 需求 3 250ms 合并 | O2、O5、D1、D2；chat-stream 新增要求、thinking-fold「合并发布与持久化」；tasks 组 2 |
| 需求 3 前端平滑 | O2、O6、D8；chat-web「消息线程」、thinking-fold「呈现」；tasks 组 7 |
| 需求 4 小圆点 | O2、D6；chat-web「消息线程」；tasks 组 5 |
| Q15 流式预览 | O4、D7；thinking-fold「呈现」；tasks 6.3 |
| 测试（注入时钟、节奏夹具、闸门停点、长思考素材、走查） | D9、D10；omp-test-harness、chat-harness；tasks 组 1、组 4 与各组的走查任务 |
