# Tasks: s2c-kb-session

> 跟踪：Stage 5 在 Epic 下建子 issue，每个任务组（或宽度门禁拆出的切片）一个子 issue、一个 PR。
>
> 没有外部前提：omp v18.12.3 的 host tool 实测已完成（`docs/reviews/2026-11-10-omp-host-tools.md`），假 omp 与受控上游只按该记录写。
> 官方 omp 门控用例（组 9）在本机以 `WORKBUDDY_OMP_TEST=1` 跑，PR 附命令与输出；真实模型与真实 RAGFlow 只在 owner 验收（CK-15–CK-18）。
>
> 依赖（真实依赖）：
> - 无前置：组 1、组 3 首刀（3.1–3.4）、组 7 首刀（7.1–7.2）、组 9 首刀（9.1–9.2）。
> - 组 2 ← 1。组 3 第二刀（3.5–3.6）← 3 首刀、2。组 4 ← 2、3 首刀。组 5 ← 3 首刀、4。
> - 组 6 首刀（6.1–6.2）← 5。组 6 第二刀（6.3–6.5）← 6 首刀。
> - 组 7 第二刀（7.3–7.5，服务端写入侧）← 7 首刀、2。组 7 第三刀（7.6–7.7，快照与 web 契约对）← 7 第二刀。组 8 ← 6 第二刀、7 第三刀。
> - 组 9 第二刀（9.3）← 3 第二刀、4、5、9 首刀。组 10 ← 6 第二刀、8。组 11 ← 1–10 全部。
>
> `kb_search` 字样：S2b 的扫描用例要求它在 `server/src` 里零出现（`server/test/kb-retrieval-canonical.test.ts:60-63`）。组 2 先改这条用例，
> 所以凡是在 `server/src` 里写出 `kb_search` 的组都 ← 2。组 3 首刀的 `host-tools.ts` 只认工具名参数，源码与注释里不写 `kb_search`。
>
> 跨服务的严格解析：web 按严格键集解析消息快照（chat-web「API 客户端扩展」），所以组 7 第三刀给消息快照加 `knowledgeBases` 时，
> web 的解析器 SHALL 在同一个 PR 里改，否则合入即让会话页 `requestFailed`。SSE 的未知事件类型被 web 忽略（chat-web「事件流消费与续流」），
> 所以组 5 的服务端 `kb.hits` 可以先于组 6 的 web 解码合入。
>
> 文件行数（size-guard 上限 800，含 `server/test`、`web/test`）：`supervisor.ts` 785、`fake-upstream.mjs` 781、`web/src/features/chat/stream.ts` 771、
> `web/src/features/chat/use-chat-session.ts` 796、`server/src/sessions/store.ts` 784、`omp/process.ts` 760、`turn-actions.ts` 760、`fake-omp.mjs` 758、`app.ts` 756、`omp/runtime.ts` 739、`session-contract.ts` 710。
> 本 change 的新逻辑一律放进下面点名的新兄弟文件，这些文件只加分流或调用的几行；放不下时先把相邻的既有逻辑原地移出，不加新的。
>
> 计数断言原地改：既有的计数与清单断言（事件种类数、迁移目录计数、消息键集）在它们的权威文件里改，SHALL NOT 在新文件里另写一份（Code Canonicality）。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| 白盒关键路径（omp 子进程治理：协议面挂死、写给已取消的调用、退出后写帧） | 是 | 组 3 在真实子进程上测取消、退出与并发；组 3、组 4 的 PR 标注请求白盒审查 |
| 权限（探测别人的库、引用别人的库） | 是 | 组 2 的 `not_found` 等同用例、组 7 第二刀的 404 等同用例 |
| 不变量 2（整篇文档进上下文；`details` 进模型） | 是 | 组 2 文本只有切片与出处；组 9 第二刀断言上游 tool 消息不含 `details` |
| 审批语义（`write` 档的放行例外越界） | 是 | 组 3 第二刀：只认恰好的标题，`always-ask` 照常 |
| 迁移与 DB 约束 | 是 | 组 7 首刀 |
| 跨服务契约（快照加键而 web 严格解析） | 是 | 组 7 第三刀同 PR 改两端 |
| 分支对位（后缀字节变化让存量会话的 regenerate / fork / 撤回 502） | 是 | 组 7 第二刀：无引用时后缀逐字节不变的用例、引用快照的对位用例 |
| 外部接口漂移（omp 的 `i` 字段、帧序） | 是 | 组 5 意图缺失时退回问句；组 9 第二刀在真实 omp 上回归 |

## 1. 单轮检索可取消（knowledge-bases「单轮检索」的中止；ragflow-backend「RAGFlow 出站请求」的检索中止）

- [ ] 1.1 核对 Context：`server/src/kb/ragflow-retrieval.ts:69-84` 的 `retrieve` 与 `json(…)` 调用，`ragflow-client.ts:25`、`:85`、`:372-425` 的 `signal` 与放弃写法，`retrieval.ts` 的 `retrieveForBase` 与降级重试（`searchWithFallback`）
- [ ] 1.2 测试先行：在新文件 `server/test/kb-retrieval-abort.test.ts` 覆盖两份规格的「中止」场景（挂起时中止、调用前已中止不发请求、降级重试前中止只有一次请求），对假 RAGFlow 跑
- [ ] 1.3 实现：`RetrievalQuery` 加可选 `signal` 并传给 `json`；`retrieveForBase(deps, base, question, signal?)` 往下传，降级重试用同一个 signal；检索测试端点不传，既有用例原样全绿

Suggested fixture level: compact - 在既有出站路由上传一个可选参数，没有公共 API、schema 或权限变化；检索测试的既有用例原样全绿即证明不变。
Minimal mergeable slice: atomic - 签名改动与它唯一的验证路径（中止用例）是同一个函数链，拆开后任何一半都没有可单独验证的行为。

## 2. 会话检索 `kb_search`（knowledge-bases「会话检索 `kb_search`」「单轮检索」的扫描用例）

- [ ] 2.1 核对 Context：`kb/store.ts` 的 `listBases`（:323）、`getBase`（:320），`kb/bases.ts:89` 的 `ownedBase`，`retrieval.ts` 里检索测试端点的问句判定函数（复用它，不另写），`kb/index.ts` 的 `registerKb` 返回值与 `app.ts:383` 的调用点
- [ ] 2.2 测试先行：新文件 `server/test/kb-session-search.test.ts` 覆盖「定义」「两个库都命中」「部分失败与不可探测」「参数校验」「中止」五个场景；断言文本逐字节、`details` 的键集与次序、假 RAGFlow 的请求计数、`knowledge_bases` 列与审计表不变
- [ ] 2.3 实现新文件 `server/src/kb/session-search.ts` 的 `createKbSessionSearch(deps)`：
  - `definitionFor(ownerId)`、`execute(ownerId, args, signal)`（design D5）。
  - `resolveReferences(ownerId, ids)`：组 7 第二刀用，返回 `[{id,name}]` 或 `null`（任一不是该账号的库）。
- [ ] 2.4 `registerKb` 在知识库开启时把它与既有的返回值一起交回给 `app.ts`，关闭时为 `null`；本组不接进会话（组 4 接）。knip 不报未用：`app.ts` 已读取返回对象，新成员由组 4 消费前先在 2.2 的用例里被调用
- [ ] 2.5 扫描用例：在 `server/test/kb-retrieval-canonical.test.ts`（「只有一处检索实现」的权威用例文件）里：
  - 加一条，断言 `session-search.ts` 只经 `retrieveForBase` 检索。
  - 删掉「kb_search 在 server/src 里零出现」这条（它对应的「`kb_search` 工具契约」被本 change 的 knowledge-bases delta REMOVED），文件头注释同改；不另写替代的零出现断言。

Suggested fixture level: expanded - 权限判定（别人的库不可探测）与发给模型的内容契约（不变量 2）。
Minimal mergeable slice: atomic - 定义、执行与引用解析共用同一份「该账号的库」读取与同一组用例，拆开只会让两个 PR 改同一个新文件。

## 3. 宿主工具协议与 `kb_search` 的审批放行（omp-runtime「宿主工具协议」；tool-approval「审批请求识别」；omp-test-harness「假 omp host tool 场景」）

- [ ] 3.1 核对 Context：`process.ts` 的 `#onFrame`（:561）、`#onUiRequest`（:584）、`#write`（:346）、`#writesClosed`、退出观测；`ui-requests.ts` 的 `approvalRequest` / `isPreludeCard` / `answerFrame`；假 omp 的场景选择与入站帧记录（omp-test-harness「假 omp 入站帧记录」）
- [ ] 3.2 假 omp：新文件 `server/test/support/fake-omp-host-tool.mjs` 实现 `host-tool`、`host-tool-parallel`、`host-tool-abort` 三个场景（`yolo` 帧序、三个并发调用含未知工具名、中止），以及其余场景对 `set_host_tools` 回按 `id` 关联的 `success:false`；`fake-omp.mjs` 只加场景分派的几行；场景的契约用例放新文件 `server/test/fake-omp-host-tool.test.ts`
- [ ] 3.3 测试先行：新文件 `server/test/omp-host-tools.test.ts`，对真实子进程（假 omp）覆盖「调用与应答」「并发」「取消与迟到的结果」「未知工具与失败」「结果过大」；宿主写出的帧经 stdin tee 观察（`server/test/support/omp-runtime.ts` 的 `capturePromptWrites` 同一手法），断言 `id`、文本、`details` 与 `isError`
- [ ] 3.4 实现新文件 `server/src/sessions/omp/host-tools.ts`（在途表、取消、退出中止、应答写帧、过大降级、错误不外泄）；`OmpProcessOpts` 加可选 `hostTools`，`#onFrame` 只加分流的一行；源码与注释里不写 `kb_search`
- [ ] 3.5 假 omp 场景补 `write` / `always-ask` 帧序（`Allow tool: kb_search` 的 select 与 `Deny` 分支），并在 3.2 的契约用例里加对应断言
- [ ] 3.6 测试先行后实现：`ui-requests.ts` 的纯判定函数 `isKbSearchApproval`（`ui-requests.ts` 保持无状态，`OmpProcess` 仍是唯一写帧的地方），`#onUiRequest` 在审批识别之前按这一代的 `approvalMode` 判定；覆盖 tool-approval 的新场景与 session-permission-tier「kb_search 的确认只在 always-ask 档出卡」，以及 omp-runtime「RPC IO and child observation」的「kb_search card by approval mode」，既有审批用例原样全绿

Suggested fixture level: expanded - omp 子进程治理（白盒关键路径）、并发与取消、审批语义。
Minimal mergeable slice: 3.1–3.4 为首刀：协议在 `yolo` 帧序下独立可测，`hostTools` 为可选参数，生产路径不注入时行为不变；3.5–3.6（审批放行）依赖首刀的假 omp 场景与组 2（扫描用例已放开 `kb_search` 字样）。

## 4. `kb_search` 的注册与装配（omp-runtime「`kb_search` 的注册」；chat-sessions「派发前按会话设置对齐进程」）

- [ ] 4.1 核对 Context：`composer-align.ts` 的 `alignModel` / `alignmentOf` 与 `slot.generation.applied`（:136-154）、`pool.ts` 的 `commandOn`（:380）与 `buildSessionRuntime`（:296）、`supervisor.ts` `#onNewSlot`（:474）与派发前对齐的调用点、`runtime.ts` 的 `SessionRuntimeOpts` 与 `#openProcess`（:436）、`branch-temp.ts:107` 的 `branchAt`
- [ ] 4.2 假 omp：在 `server/test/support/fake-omp-host-tool.mjs` 加 `host-tool-register-fail` 场景（`set_host_tools` 回 `success:false`），契约用例加在 `server/test/fake-omp-host-tool.test.ts`
- [ ] 4.3 测试先行：新文件 `server/test/session-host-tool-align.test.ts`，在 slot 层以假 omp 与注入的定义源覆盖 omp-runtime「`kb_search` 的注册」的「首次派发前注册」「不注册」「库清单变化后重发」「空闲回收后重新注册」「注册失败」「临时进程不注册」「只以所有者执行」（两个账号各一个会话，`kb_ids` 互指对方的库，结果为 `not_found`），以及 chat-sessions「派发前按会话设置对齐进程」的「宿主工具对齐在模型命令之后、在 regenerate 事务之前」「宿主工具对齐失败时 regenerate 不动分支」
- [ ] 4.4 实现：
  - 先 grep 既有用例里「知识库开启且所有者有库、又跑会话回合」的组合：假 omp 的缺省场景对 `set_host_tools` 回 `success:false`，这类用例改用 `host-tool` 场景，不改缺省应答。
  - 新文件 `server/src/sessions/host-tool-align.ts`：派发前对齐的第 3 步（每代所记的库清单、比较、`set_host_tools`、应答校验），经 `commandOn` 与 `slot.generation`；`supervisor.ts` 在第 2 步之后只加一处调用，失败与第 1、2 步同一处理。
  - 处理函数在 `pool.ts` `buildSessionRuntime` 绑定为「以 slot 的所有者执行」，经 `SessionRuntimeOpts` 透传到 `OmpProcessOpts.hostTools`；只有 `#onNewSlot` 这条路径传，`branch-temp.ts` 不传。`runtime.ts` 只加透传。
- [ ] 4.5 装配：`app.ts` 把组 2 的 `definitionFor` / `execute` 注入 supervisor 与 pool，知识库关闭时不注入；`createApp` 级用例（假 omp `host-tool` 场景 + 假 RAGFlow）断言一个回合里 `host_tool_result` 的文本来自假 RAGFlow 的切片
- [ ] 4.6 `docs/architecture/system.md`：`sessions` 行写 host tool 的注册与分派（经注入），`kb` 行写会话检索，§4 依赖规则的 `sessions → kb` 改为「经 `app.ts` 注入，不导入」
- [ ] 4.7 验收清单 `docs/acceptance/functional-checklist.md` 的 CK 节新增 CK-15（在接上真实 RAGFlow 与真实模型的会话里问库里才有的事实，回答用到库里的切片，且助手消息里有这次检索：组 6 第二刀合入前是名为 `kb_search` 的步骤卡，之后是「知识库检索」卡），结论 `待签`，由 owner 执行（agent 不得代签）

Suggested fixture level: expanded - omp 子进程治理（白盒关键路径）与共享装配入口（`app.ts`、supervisor）。
Minimal mergeable slice: atomic - 注册逻辑与装配是同一条验证路径（4.5 的 `createApp` 用例要两者都在）；只合注册而不装配，生产里没有任何定义源，等于死代码。

## 5. `kb.hits` 事件（chat-stream「纯协议事件归约」的 `kb_search` 派生、「检索结果事件发布」）

- [ ] 5.1 核对 Context：`events.ts` 的运行中工具条目与 `applyToolStart` / `applyToolEnd`、`todo.updated` 的派生写法；`turn-control.ts:261` 的 `turn.retry` 分支；supervisor 的 `todo.updated` 校验与发布；合并窗口的冲刷清单
- [ ] 5.2 测试先行：reducer 用例（「kb_search result yields a raw candidate」）放进 reducer 的权威用例文件；发布用例放新文件 `server/test/session-kb-hits.test.ts`，以假 omp `host-tool` 场景覆盖「发布但不落库」「回放与快照」「不合规即丢弃」
- [ ] 5.3 实现：reducer 记下 `intent` 并在 `step.end` 前发 `kb.hits`；校验与 stderr 记录放新文件 `server/src/sessions/kb-hits.ts`，supervisor 只加调用；`persistEvent` 与 `step.end`、`files.changed` 同样经 `steps.toolIds`（`turn-control.ts:297`、`:319`）把 `stepId` 映射成落库的步骤 id，映射不到即丢弃，映射后与 `turn.retry` 同样原样返回、不写库；用例断言 `kb.hits.stepId` 等于同一步骤 `step.start` 的 `stepId`；事件种类计数断言原地加一

Suggested fixture level: expanded - 会话事件流是公共 API（public API），且涉及环形缓冲与持久化的边界（persisted / shared state）。
Minimal mergeable slice: atomic - reducer 派生与 supervisor 校验发布是同一个事件的两半：只派生不发布，事件出不了 supervisor；只发布不派生，没有事件可发。

## 6. web：`kb.hits` 与检索卡（chat-web「纯会话视图归约」「事件流消费与续流」「助手消息分段」「工具段摘要与折叠」「会话知识库检索卡」）

- [ ] 6.1 核对 Context：`stream.ts` 的事件名表（:121）与归约、`stream-failure.ts` 的 `turn.retry` 严格解码先例、`message-segments.ts`、`tool-summary.ts:9-24`、`tool-call-group.tsx` / `message-segments-view.tsx` 的分流、`step-card.tsx`
- [ ] 6.2 测试先行（新文件 `web/test/chat-stream-kb-hits.test.ts`）后实现：新文件 `web/src/features/chat/stream-kb-hits.ts`（严格解码与把 `kbHits` 挂到步骤上），`stream.ts` 只加事件名与分派的几行；用例覆盖「检索结果归约」「检索结果事件严格解码」（键集不符触发重新同步、未知步骤保持同一引用）
- [ ] 6.3 测试先行后实现：`message-segments.ts` 的检索块（「kb_search 步骤合成一个检索块」场景）；`tool-summary.ts` 不计 `kb_search`，既有分段与摘要用例原样全绿
- [ ] 6.4 测试先行（新文件 `web/test/chat-kb-search-card.test.tsx`）后实现：新组件 `web/src/features/chat/kb-search-card.tsx`，覆盖「实时两轮」「刷新后只剩各轮」「检索行的确认标记」「部分失败与检索中」；展开态以块键保留
- [ ] 6.5 证据：本机对一个注入了 `kb.hits` 的会话截图（亮 / 暗），零新增控制台报错，附在 PR；验收清单 CK 节新增 CK-16（接 CK-15，模型检索两轮的回合里，助手消息只有一张「知识库检索」卡，逐轮列出意图与命中条数，展开看到切片；刷新后只剩各轮），结论 `待签`，由 owner 执行

Suggested fixture level: expanded - 前端改变公共事件流的解码与会话页呈现（public API、shared rendering）。
Minimal mergeable slice: 6.1–6.2 为首刀：解码与归约没有呈现，可独立合入保绿（还没有组件读 `kbHits`）；6.3–6.5 依赖它。

## 7. 知识库引用：迁移、受理、后缀与快照（message-attachments「迁移 052 知识库引用列」「prompt 引用知识库」「交给 omp 的附件后缀」「重新生成与分叉中的附件」；chat-sessions「会话 REST」「REST prompt 受理与补偿」「Slash 命令白名单与命令目录」；chat-web「API 客户端扩展」）

- [ ] 7.1 核对 Context：`042_chat_message_attachments.sql` 的写法、`server/test/core-db-helpers.ts` 的跟踪清单与受信任迁移目录计数、`051_kb_retrieval.sql` 的回执位置
- [ ] 7.2 测试先行后实现：迁移 `052_chat_message_knowledge_bases.sql`；在迁移的权威用例文件里覆盖「新库与存量库」「中途失败原子回滚」，目录计数原地加一
- [ ] 7.3 核对 Context：`prompt-attachments.ts:47` 的 `parsePromptBody`、`rest.ts` 的受理与后缀拼接（:315-349）、`store-attachments.ts`、`slash-commands.ts:324` 的 `attachmentSuffix`、`branch-temp.ts:191` 的 `matches`、`branching.ts:126/156/258`、`store-branch.ts` 的 fork 拷贝、`turn-control.ts` 的 `acceptPrompt`
- [ ] 7.4 测试先行：新文件 `server/test/prompt-knowledge-bases.test.ts` 覆盖「拒绝」、后缀的「带知识库引用的后缀」与「prompt 带知识库引用」、列的落库值，以及 `store-knowledge-bases.ts` 读出坏值整列为 `[]` 的单元用例；派发文本与 spec 场景同一写法用桩 supervisor 观察（不经假 omp：组 4 合入后，知识库开启且所有者有库时缺省假 omp 会让注册失败，需要假 omp 的用例改用 `host-tool` 场景）；分支对位的场景（「带知识库引用回合的对位」）放进 `message-attachments` 既有的对位用例文件；fork 拷贝在本刀只断言新会话消息行的 `knowledge_bases` 列原值（快照还没有这一键）；无引用时后缀逐字节不变的既有用例原样全绿
- [ ] 7.5 实现（服务端写入侧，快照不加键）：
  - body 四种键集与 `knowledgeBases` 的判定（经组 2 的 `resolveReferences`，由 `app.ts` 注入路由）。
  - 引用的落库与读出放新文件 `server/src/sessions/store-knowledge-bases.ts`；`store.ts`（784 行）里 `acceptPrompt` 只多一个参数与一处调用，消息视图类型的第十四键留给 7.7。
  - `attachmentSuffix` 原地改名为 `promptSuffix(paths, kbs)`，全部调用点同改，不留旧名。
  - 对位候选由落库快照重建；fork 拷贝列。
- [ ] 7.6 测试先行：快照的「受理与快照」「坏值」「分叉拷贝引用」场景（服务端；需要假 omp 时同 7.4 的场景选择）与 web 的「知识库引用的解析与发送」场景；消息键集的既有断言（服务端与 web 各自的权威文件）原地改为十四键
- [ ] 7.7 实现（跨服务契约对，同一 PR）：服务端消息视图第十四键 `knowledgeBases`；web `parseMessage` 十四键与 `ChatKnowledgeBaseRef`；`api-sessions.ts` 的 `prompt` 加 `knowledgeBases` 选项

Suggested fixture level: expanded - 迁移、公共 API 的请求与应答形状、权限与分支对位（migration、public API、auth、legacy compatibility）。
Minimal mergeable slice: 7.1–7.2 为首刀：只加可空列，既有代码不读它，可独立合入保绿。7.3–7.5 为第二刀：写入侧只改请求、落库与后缀，应答形状不变，web 不受影响。7.6–7.7 为第三刀：快照加键而 web 严格解析，两端必须同 PR。

## 8. web：引用入口、标签与气泡（message-attachments「输入框知识库引用」「用户气泡中的知识库引用」）

- [ ] 8.1 核对 Context：`capability-bar.tsx:169-260` 的 `CommandMenu`、`attachment-chips.tsx`、`attachments-state.ts`、`conversation-view.tsx:374`、`turn-actions.ts:289-296` 的发送、欢迎态首次发送的流程、`web/src/lib/api-kb.ts` 的 `listKnowledgeBases` 与 `getKbStatus`
- [ ] 8.2 测试先行（新文件 `web/test/chat-kb-refs-state.test.ts` 与 `web/test/chat-kb-ref-picker.test.tsx`）后实现：引用状态放新文件 `web/src/features/chat/kb-refs-state.ts`，选择列表与标签放新组件 `web/src/features/chat/kb-ref-picker.tsx`；`turn-actions.ts` 只加 body 的一个参数；`use-chat-session.ts`（796 行）只加引用状态的接线，放不下时先把欢迎态首次发送（既有逻辑）原地移进兄弟文件再加；覆盖「引用并发送」「关闭时没有入口」「空白草稿与上限」「欢迎态暂存」，以及分叉 / 撤回回填时清空引用
- [ ] 8.3 测试先行（新文件 `web/test/chat-kb-ref-bubble.test.tsx`）后实现：用户气泡的 `引用的知识库` 列表，覆盖「受理后与刷新后一致」
- [ ] 8.4 验收清单 `docs/acceptance/functional-checklist.md` 的 CK 节新增 CK-17（在输入框「+」里引用一个库再发送，用户气泡列出引用的库，刷新后仍在；欢迎态暂存的引用随首条消息发出），结论 `待签`，由 owner 执行（agent 不得代签）

Suggested fixture level: expanded - 前端呈现与输入框的发送流程（shared rendering、public API 的请求形状）。
Minimal mergeable slice: atomic - 入口、标签与发送是同一个用户动作的一条验证路径；气泡与它共用同一份引用数据，拆开后验收行 CK-17 无法在任一半上走通。

## 9. 夹具与真实 omp 回归（omp-test-harness「受控上游知识库检索标记」；omp-runtime「host tool 的真实 omp 回归」）

- [ ] 9.1 核对 Context：`fake-upstream.mjs:263-272` 的「是否已回答」判定与 `toolRoundCall`（:638-657）、`fake-upstream-pace.mjs` 的兄弟模块写法、`server/test/omp-official-*.test.ts` 的门控与 stdout tee
- [ ] 9.2 测试先行后实现：新文件 `server/test/support/fake-upstream-kb.mjs`（按本回合 tool 消息条数分三阶段，只在 `tools` 含 `kb_search` 时生效），`fake-upstream.mjs` 只加分派的几行；用例放新文件 `server/test/fake-upstream-kb.test.ts`（「标记的三个阶段」）
- [ ] 9.3 新文件 `server/test/omp-official-host-tools.test.ts`（`WORKBUDDY_OMP_TEST=1` 门下）实现「两轮检索」，断言第二、第三次上游请求的 tool 消息只含切片文本、不含 `details` 的任何内容；本机运行并在 PR 附命令、退出码与输出；验收清单 CK 节新增 CK-18（真实模型在构造的证据不足场景下自行第二次调用 `kb_search`），结论 `待签`，由 owner 执行

Suggested fixture level: expanded - 端到端证明白盒关键路径在真实二进制上成立（production-like runtime）。
Minimal mergeable slice: 9.1–9.2 为首刀：受控上游标记只有自己的用例消费，可独立合入保绿；9.3 依赖它与组 3 第二刀、组 4、组 5。

## 10. ui-walk 会话知识库分支（chat-harness「UI 走查会话知识库引用与检索卡」）

- [ ] 10.1 核对 Context：`web/e2e/ui-walk-center-kb.ts` 的 route 桩与键集纪律、`route-hold.ts`、`ui-walk-oracle.ts`、`ui-walk-cleanup.ts`、视口矩阵
- [ ] 10.2 实现新文件 `web/e2e/ui-walk-chat-kb.ts` 的三步，并在 `ui-walk.spec.ts` 接入；本机对已运行的服务跑 `make ui-walk`，PR 附退出码与截图

Suggested fixture level: expanded - 前端真实浏览器走查（视口矩阵 + error oracle）。
Minimal mergeable slice: atomic - 一个走查分支只有一条验证路径（`make ui-walk` 全绿）。

## 11. 收口

- [ ] 11.1 `docs/architecture/knowledge-base.md` 加会话检索（`kb_search` 的语义、上限、失败与审批放行）；`openspec/glossary.md` 的「附件」加知识库引用、「host tool」写注册与放行；若 4.6 之后 `system.md` 又有漂移，一并修正
- [ ] 11.2 `IMPLEMENTATION_PLAN.md`：S2c 一节标注 A（本 change）已交付、B 待启动；Next Step 记录 CK-15–CK-18 待签与 change B 的 grill 种子（design.md Non-Goals 列出的 B 开放项）
- [ ] 11.3 核对 design.md「Grill 结论」G1–G15 在代码与规格中的落点，逐条记录于收口 PR 描述

Suggested fixture level: none - 只改文档与计划，没有运行时行为。
Minimal mergeable slice: atomic - 收口只有一条验证路径（全部组合入后的状态核对），依赖组 1–10 全部。
