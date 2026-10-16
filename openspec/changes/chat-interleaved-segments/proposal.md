# Proposal: chat-interleaved-segments

## Why

#915（已并入 #911）：owner 在 2026-10-06 验收会话页时提出三件事。

1. 助手的一条回答要像 Claude Code 桌面端那样边说明边执行：一段文字，接着是这段文字之后发生的那几次工具调用（收成一行摘要，可展开），再接下一段文字，如此交替；思考也出现在它发生的位置。
2. 工具执行的步骤默认收起，失败也不再自动展开；摘要按动作归类计数。
3. 确认（审批）处理完之后不再作为独立的记录卡出现在消息里。

现状是按规格实现的：chat-web「消息线程」把块次序定为「思考 → 全部正文 → 一个工具调用组 → 已结算审批记录」，并规定组内有失败步骤时自动展开；服务端把正文、思考各存成一个字符串，步骤存在 `chat_steps`，都没有「发生在正文哪个位置」的信息，确认记录也没有指向步骤的关联键（`web/src/features/chat/runtime-convert.ts:44-48` 的注释写明了这一点）。实时事件按发生次序到达，但刷新后从快照恢复时次序就没有了。所以要改的是规格与数据。

## What Changes

- **位置信息（owner 2026-10-13 B1）**：
  - 步骤与每段思考记录它开始时助手正文已发布的长度（偏移，UTF-16 码元）；正文仍是一个字符串。
  - 一次迁移 045：`chat_steps.body_offset`（可空）、`chat_approvals.step_id`（可空）与新表 `chat_thinking_segments`（每段思考一行：正文偏移、在思考字符串里的起点与长度、此前已开始的步骤数、本段毫秒）。新列可空，不回填。
  - 记录偏移之前先冲刷 #910 的 250ms 合并器，使记录的偏移恰等于客户端已收到的正文长度（design D3）。
- **线协议与快照（行为变化，非破坏；但见「同刀」）**：
  - `step.start` 增加 `bodyOffset` 与 `approvalId`（该步骤配上的确认 id 或 `null`）；`thinking.end` 增加 `segment`（刚结束那一段的五个值）。不新增事件类型。
  - 快照（`GET /api/sessions/:id/messages`）步骤增加 `bodyOffset`、确认增加 `stepId`、消息增加 `thinkingSegments` 数组。
  - 这些都是对既有严格键集的增改：服务端事件字段、快照键与 web 的解析器 SHALL 同一 PR 合入（#909/#910 的同刀规则，本 change 把它扩到事件负载：web 对已知事件解析失败会触发整页重新同步，见 design D8）。
- **分段显示（issue 需求 1–3）**：
  - 一条助手消息按位置拆成正文段、思考段与工具段交替显示；相邻的工具调用（中间没有正文或思考）归入同一个工具段。
  - 每段思考一个折叠，各自显示自己的 `已思考 N 秒`（owner 2026-10-15 B5）；消息级累计 `thinkingMs` 保留。
  - 实时视图与快照恢复的视图用同一个纯函数切段，结果相同。
- **旧消息（issue 需求 4，B1）**：任一步骤或思考段缺位置信息的消息，按现在的布局呈现（思考在顶部、全部正文、一个工具组）；不回填，没有半分段的消息。
- **工具段（owner 2026-10-06 B7，2026-10-15 B6）**：
  - 一律默认收起，含失败步骤的也不再自动展开；手动展开的保留沿用现有做法。
  - 摘要按动作归类计数：执行命令（`bash`、`eval`）、读取（`read`）、新建（`write`）、修改（`edit`、`ast_edit`）、搜索（`grep`、`glob`、`ast_grep`、`web_search` 及别名 `search`、`find`），其余归「其它 N 步」；例「执行 3 条命令、读取 2 个文件、其它 1 步」。
  - 有失败步骤时末尾加不着色的 `，N 步失败`；有步骤在运行时显示进行中状态。
- **确认记录（owner 2026-10-15 B3、B4，2026-10-06 B9）**：
  - `step.start` 时按工具名先进先出，把同一消息内尚未配对的确认配给该步骤，落库 `chat_approvals.step_id`。配对只写这一列，不改作答、超时、停止结算与审计的任何路径。
  - 已配对的确认：超时自动允许在步骤卡上加 `超时自动允许` 小标记，拒绝加 `已拒绝`，正常允许不加；展开工具段才看得到。
  - 配不上步骤的已结算确认保留现有记录卡作兜底，显示在消息末尾。
  - 待决确认卡位置不变；确认仍落库、随快照返回、审计照旧。
  - 被拒绝的调用在官方 omp v18.0.10 上是否产生步骤：本 change 加一个实测任务；两种结果都是合法终态（没有步骤即不配对、走兜底记录卡）。
- **对话内搜索（B8）**：命中内容在收起的段里时的行为保持现状。现状是搜索只匹配正文 `content`，步骤与思考从不参与匹配，正文段从不收起，所以「命中在收起的段里」不会发生；本 change 用一条场景钉住这一点。
- **分叉、撤回、重新生成**：fork 拷贝思考段、步骤偏移，并把确认的 `step_id` 按步骤序号重新映射到新步骤；撤回与重新生成删除消息时新表行随外键级联删除。
- **证据**：
  - 合并器冲刷与偏移的次序用注入时钟的纯层测试与 fake-omp 集成测试证明。
  - 受控假上游新增标记 `WORKBUDDY_INTERLEAVE`（正文、思考、正文按 25ms 节奏交错），官方 omp 用例断言「思考段的正文偏移恰等于它之前已发布正文的长度」。现有标记都是先思考后正文、工具轮不带正文，开不出这个窗口（design D17）。
  - 被拒绝调用的实测见上。
  - ui-walk 断言工具段在正文之前（真 omp 的工具轮先于答复轮）、新摘要、默认收起、确认后消息里没有记录卡、刷新后分段不变。
- **验收清单**：改写 CH-14、CH-15、CH-19、CH-20、CH-21、CH-22、CH-23、CH-24、CH-50、CH-56、CH-118，新增分段显示与刷新一致的行，全部 `待签`。
- **不做**：步骤卡本身的内容（小标记除外）；待决确认卡的样式与交互；历史消息的回填；对话内搜索的行为改变（design Non-Goals）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `chat-web`：
  - 改写「消息线程」：块次序改为分段交替，旧布局的判定，工具段与兜底记录卡的位置，小圆点与等待指示的位置（判据不变）。
  - 改写「API 客户端扩展」「纯会话视图归约」「事件流消费与续流」「会话页源码模块划分」：三处新键、事件新字段、归约与透传。
  - 新增「助手消息分段」（纯切段函数与旧布局判定）、「工具段摘要与折叠」、「步骤卡的确认标记」。
- `chat-sessions`：改写「会话 REST」（快照键集、fork 拷贝列表）；新增「迁移 045 分段位置与确认关联」。
- `chat-stream`：改写「思考与文件变更事件发布」（`thinking.end` 负载）；新增「分段位置的记录与下发」（正文偏移计数、边界前冲刷、`step.start` 两个新字段）。
- `thinking-fold`：改写「深度思考折叠块呈现」（多段、各自位置与时长）与「思考时长记录与下发」（段行、段时长、开段前冲刷）。
- `tool-approval`：改写「审批快照」「web 审批条」；新增「确认与步骤配对」。
- `turn-control`：改写「从此处分叉 REST」（拷贝思考段、偏移与重新映射的 `step_id`）。
- `message-undo`：改写「对话原地回退」（级联删除列表加新表）。
- `chat-harness`：改写「UI 走查对话步骤」（确认后不再有记录卡、新摘要）；新增「分段呈现的冒烟与走查」。
- `omp-test-harness`：新增「受控上游交错标记」。
- `ui-foundation`：改写「组件分层」（应用层定制清单去掉「失败自动展开」）。

## Impact

- **服务端**：
  - 新迁移 `server/src/core/db/migrations/045_chat_interleaved_segments.sql`。
  - 新模块：`server/src/sessions/store-segments.ts`（思考段行、步骤插入与配对写入，从 `store.ts` 移出 `startStep`）、`server/src/sessions/approval-pairing.ts`（回合内按线上次序的确认队列）。
  - 改动：`store.ts`（回合的正文已发布长度计数）、`delta-coalescer.ts`（开段前冲刷）、`thinking-span.ts`（开段写行、闭段写段时长并在 `thinking.end` 带段）、`turn-control.ts`（`step.start` 带两个新字段）、`supervisor.ts`（pump 记下确认 select）、`events.ts`（事件类型）、`store-branch.ts`（fork 拷贝与映射）、`rest.ts`（快照形状）。
- **web**：
  - `web/src/lib/session-contract.ts` 及新模块（新键的严格解析）；`stream.ts` / `stream-thinking.ts` / `stream-steps.ts` / `stream-approvals.ts`（解码与归约，新模块 `stream-segments.ts`）。
  - 新模块：`message-segments.ts`（纯切段函数）、`tool-summary.ts`（纯摘要函数）、`message-segments-view.tsx`（分段渲染）。
  - 改动：`message-thread.tsx`、`runtime-convert.ts`（透传与注释）、`tool-call-group.tsx`（去掉失败自动展开、新摘要）、`thinking-fold.tsx`（按段标题）、`step-card.tsx`（小标记）、`approval-card.tsx`（只渲染未配对的记录）。
  - 拷入层（`web/src/components/ui/`、`web/src/components/assistant-ui/`）不改。
- **测试与夹具**：
  - `server/test/support/fake-upstream.mjs` 新标记（节奏写出复用 `fake-upstream-pace.mjs`）。
  - 新官方 omp 用例，加进 `.github/scripts/ci-uid-isolation.sh` 的列表，`scripts/test-ci-harness.sh` 的钉子同步改。
  - 既有快照与事件夹具补新键；被 owner 推翻的旧断言按 design D14 的封闭清单改写。
  - ui-walk 新文件 `web/e2e/ui-walk-segments.ts`（`ui-walk-layout.ts` 已 789 行）。
- **文档**：`docs/acceptance/functional-checklist.md`。
- **线协议**：两种既有事件加字段、快照三处加键；同刀合入，无兼容窗口（同仓同部署，无第三方消费者）。
- **依赖**：无新增。
- **CI**：同上，改 `.github/**` 与 `scripts/test-ci-harness.sh` 的切片在 PR 里单列说明。

## 流程记录

```text
Issue type: feature
Pipeline: stage-change-pipeline（owner 2026-10-13 Q11 = B2：#915 走完整流水线）；grill 已过，ledger B1–B10，开放项无
Order: #910 已合并并归档（B10），本 change 在其代码上设计
Tracking: #915 为父 issue，Stage 5 按 tasks.md 的切片在其下建子 issue；全部子 issue 合并后关闭 #915（不是 Epic）
```
