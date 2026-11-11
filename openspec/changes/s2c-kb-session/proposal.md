# Proposal: s2c-kb-session

> Issue type: feature（P2 第三刀前半：会话内知识库检索；S2c 拆成两个 change，本 change 为 A，可见范围四档为后续 change B）
> Fixture level: expanded（整个 change；各任务组的级别见 tasks.md 组尾声明）
> Blast radius: omp 子进程治理（白盒关键路径）：`OmpProcess` 收发 host tool 帧、派发前对齐新增第 3 步注册 `kb_search`、`kb_search` 的审批由传输层应答；kb 模块新增会话检索并给单轮检索加取消；新迁移 052（`chat_messages.knowledge_bases`）；prompt body 与消息快照各多一键 `knowledgeBases`（fork 与撤回应答不变）；第十四种会话事件 `kb.hits`（占序号、不落库）；web 的知识库引用入口、引用标签与会话检索卡
> Evidence floor: `npm test --workspace server`、`npm test --workspace web`、typecheck、size-guard、`make check`、`make ui-walk`；真实 omp 的 host tool 链路在 `WORKBUDDY_OMP_TEST=1` 门下的官方二进制用例里跑（本机，PR 附输出）；真实模型与真实 RAGFlow 只在 owner 验收走一轮
> 依赖：建在 `s2b-kb-retrieval` 归档后的主规格之上（knowledge-bases「单轮检索」「`kb_search` 工具契约」）；omp 事实来源是 `docs/reviews/2026-11-10-omp-host-tools.md`（2026-11-10，v18.12.3 实测）；方向见 ADR-0017。

## Why

`IMPLEMENTATION_PLAN.md` S2c 要求会话里的模型能检索知识库（F-CHAT-4 agentic 检索卡、F-CHAT-5b 知识库附件）。S2b 已经交付单轮检索，
并按 ADR-0017 把「要不要再查、怎么改写」交给模型；缺的是让模型调得到它的那条链路。这条链路在仓库里一行代码都没有：
`docs/architecture/system.md` 写着 `sessions` 有「`host_tool_call` 分派」，实际上不存在。

2026-11-10 对钉住的 omp v18.12.3 实测（记录 §2）定下了几条硬约束：
- 不带 `loadMode:"essential"` 的 host tool 对模型不可见。
- host tool 不随会话文件保存，每个新进程都要重新注册。
- 在默认档 `write` 下，每次调用都会弹审批。

可见范围四档、共享只读与跨账号检索审计依赖部门与项目组数据的来源，另开 change B。本 change 的「可见」仍是「自己拥有」。

## What Changes

- **host tool 协议**（`OmpProcess`，omp 子进程治理）：
  - 收 `host_tool_call`，交给注入的处理函数，回 `host_tool_result`。
  - 收 `host_tool_cancel` 时中止对应的处理；进程退出时中止全部；取消之后到的结果丢弃。
  - 不认识的工具名回 `isError`。
- **`kb_search` 的注册**（派发前对齐的第 3 步，在 `set_model` / `set_thinking_level` 之后、`prompt` 之前）：
  - 只给会话 slot 的进程注册，fork 与撤回的临时进程不注册。
  - 知识库开启且所有者至少有一个库时，每个新 generation 的首次派发前发 `set_host_tools`，带 `loadMode:"essential"`。
  - 每次派发前比较库清单（id 与名称），变了就重发；清单变空时发空集。注册失败与前两步失败同样处理。
  - 处理函数在构造进程时绑定为「以会话所有者执行」。
- **`kb_search` 的审批**：`write`、`yolo` 两档由传输层应答 `Approve`（与浏览器预载卡同一写法）；`always-ask` 照常交给所有者。
- **会话检索**（kb 模块，`kb_search` 的语义）：
  - 工具描述列出调用者全部库的 id 与名称。
  - 参数为问句加 1–5 个 kb_id。对每个库做一次单轮检索，各返回至多 6 条，用该库已存的检索参数，不写回、不审计。
  - 库不存在或不可见，统一回「未找到该知识库」；非 `ready` 的库跳过并注明；RAGFlow 失败的库注明「检索失败」。
  - 只有一个库都没成功时才回 `isError`。
  - 给模型的文本只有切片与出处（库、文档名、相似度）；结构化命中放在 `details`，omp 不把它交给模型。
- **结果过大**：`host_tool_result` 超过帧长上限时先去掉 `details`，仍超过就回 `isError`「工具结果过大」，每个调用恰有一帧应答。
- **单轮检索可取消**：`retrieveForBase` 与 RAGFlow 检索路由接受 `AbortSignal`，中止与期限到期同一写法。
- **检索结果事件** `kb.hits{messageId, stepId, intent, bases}`：
  - 由 `kb_search` 的 `tool_execution_end` 派生，`stepId` 映射成落库的步骤 id（先例 `files.changed`），占环形缓冲的一个序号，不落库（先例 `turn.retry`）。
  - 刷新或从快照恢复之后看不到命中切片，只剩各轮的步骤。
- **知识库引用**（F-CHAT-5b，只作提示）：
  - prompt body 可带 `knowledgeBases: string[]`（至多 5 个、须是调用者的库；不放宽空文本规则）。
  - 迁移 052 给 `chat_messages` 加 `knowledge_bases`，存 `{id,name}` 快照；fork 原样拷贝。
  - 交给 omp 的文本在附件后缀之后接一段固定的「知识库引用后缀」，与附件后缀同一处构造；分支对位按存下的快照重建。
  - 消息快照多 `knowledgeBases`。fork 与撤回的应答不回填引用（消融剪掉，见 design Non-Goals）。
- **web**：
  - 输入框「+」菜单加「引用知识库…」，引用标签与文件附件并列，欢迎态可暂存。
  - 用户气泡显示引用的库。
  - 助手消息里同一回合的 `kb_search` 步骤合成一张「知识库检索」卡：每次调用一行（第 N 轮、意图或问句、命中条数），展开看命中切片。
- **验证**：
  - 假 omp 加 host tool 场景（两轮 `kb_search`、并发与未知工具、取消、注册失败），帧形按实测记录写；宿主写出的帧经 stdin tee 观察。
  - 受控假上游加两轮 `kb_search` 标记，供官方 omp 门控用例端到端跑真实 omp。
  - ui-walk 新分支用 `page.route` 桩走查引用入口、引用标签、用户气泡与刷新形态的检索卡。
  - 验收清单 CK 节加四行 CK-15–CK-18（`待签`）：会话检索、检索卡、知识库引用、真实模型证据不足时自行第二次检索。
- **文档**：
  - `docs/architecture/system.md` 的 `sessions`、`kb` 两行与依赖规则。
  - `docs/architecture/knowledge-base.md` 加会话检索。
  - glossary「附件」「host tool」两条。

## Capabilities

### New Capabilities

无。

### Modified Capabilities
- `omp-runtime`：
  - 「RPC IO and child observation」：`kb_search` 的审批卡在 `write` / `yolo` 下由传输层应答，宿主可写的帧加 `host_tool_result`。
  - 新增「宿主工具协议」「`kb_search` 的注册」「host tool 的真实 omp 回归」。
- `tool-approval`：「审批请求识别」加 `kb_search` 在 `write` / `yolo` 下的传输层应答。
- `session-permission-tier`：「档位与 omp 审批模式」列出两种由宿主应答的请求（`kb_search` 的确认与浏览器预载卡）。
- `knowledge-bases`：
  - 「单轮检索」加取消。
  - 新增「会话检索 `kb_search`」（语义、文本格式、`details`、上限与失败），移除「`kb_search` 工具契约」。
- `ragflow-backend`：「RAGFlow 出站请求」的检索路由接受中止信号。
- `chat-stream`：「纯协议事件归约」加 `kb.hits` 的派生；新增「检索结果事件发布」（校验、`stepId` 映射、占序号、不落库）。
- `chat-sessions`：
  - 「会话 REST」：消息键集多 `knowledgeBases`，fork 拷贝该列。
  - 「REST prompt 受理与补偿」：body 键集与后缀。
  - 「Slash 命令白名单与命令目录」：对位候选含引用后缀。
  - 「派发前按会话设置对齐进程」：新增第 3 步宿主工具。
  - 「会话持久化与回合刷盘」：`acceptPrompt` 的签名。
- `message-attachments`：
  - 新增「迁移 052 知识库引用列」「prompt 引用知识库」「输入框知识库引用」「用户气泡中的知识库引用」。
  - 「交给 omp 的附件后缀」「重新生成与分叉中的附件」扩展到引用。
- `chat-web`：
  - 「API 客户端扩展」：prompt body 与快照的严格解析。
  - 「纯会话视图归约」「事件流消费与续流」：`kb.hits`。
  - 「助手消息分段」：`kb_search` 步骤合成检索块。
  - 「工具段摘要与折叠」：`kb_search` 不进工具段。
  - 新增「会话知识库检索卡」。
- `omp-test-harness`：「假 omp 进程契约」加 host tool 场景与 `set_host_tools` 的缺省应答；新增「假 omp host tool 场景」「受控上游知识库检索标记」。
- `chat-harness`：新增「UI 走查会话知识库引用与检索卡」（`page.route` 桩，CI 不配 RAGFlow）。

## Impact

- 服务端：
  - 新文件 `server/src/sessions/omp/host-tools.ts`（帧的收发、取消、退出与过大降级）、`server/src/sessions/host-tool-align.ts`（派发前对齐第 3 步）、`server/src/sessions/kb-hits.ts`（`kb.hits` 校验）、`server/src/sessions/store-knowledge-bases.ts`（引用的落库与读出）与 `server/src/kb/session-search.ts`（`kb_search` 的定义与执行）。
  - 改动 `omp/process.ts`、`omp/ui-requests.ts`、`omp/runtime.ts`（只透传）、`pool.ts`、`supervisor.ts`、`events.ts`、`turn-control.ts`、`store.ts`、`rest.ts`、`prompt-attachments.ts`、`slash-commands.ts`、`store-branch.ts`、`branching.ts`、`branch-temp.ts`、`kb/retrieval.ts`、`kb/ragflow-retrieval.ts`、`kb/index.ts`、`app.ts`。
  - 新迁移 `052_chat_message_knowledge_bases.sql`。
- 前端：
  - 新文件 `web/src/features/chat/kb-search-card.tsx`、`stream-kb-hits.ts`、`kb-refs-state.ts`、`kb-ref-picker.tsx`。
  - 改动 `session-contract.ts`、`api-sessions.ts`、`stream.ts`、`capability-bar.tsx`、`attachment-chips.tsx`、`turn-actions.ts`、`use-chat-session.ts`、`message-segments.ts`、`message-segments-view.tsx`、`tool-summary.ts`。
- 测试夹具：
  - 假 omp 加 `host-tool`、`host-tool-parallel`、`host-tool-abort`、`host-tool-register-fail` 场景（新文件 `fake-omp-host-tool.mjs`）。
  - 受控假上游加 `WORKBUDDY_KB_SEARCH:` 标记（新文件 `fake-upstream-kb.mjs`）。
  - 新官方 omp 门控用例 `server/test/omp-official-host-tools.test.ts`；`kb-retrieval-canonical.test.ts` 删去 `kb_search` 零出现的用例。
  - 新 ui-walk 分支 `web/e2e/ui-walk-chat-kb.ts`（`page.route` 桩知识库接口与消息快照）。
- 外部：无新依赖；CI 文件不动（smoke / ui-walk 的知识库仍为关闭）。
- 不动的东西：
  - 可见范围、共享与审计（change B）。
  - 检索测试端点与检索参数的写回。
  - RAGFlow 设置与重建。
  - 模型代理。
