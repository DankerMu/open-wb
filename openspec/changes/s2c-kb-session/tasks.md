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
> 文件行数（size-guard 上限 800，含 `server/test`、`web/test`）：`supervisor.ts` 785（#1966 后 792）、`fake-upstream.mjs` 781、`web/src/features/chat/stream.ts` 771、
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
| 外部接口漂移（omp 的 `i` 字段、帧序） | 是 | 组 5 意图缺失时为 `intent:null`（服务端不读 `args.question`）；组 6 的检索卡对 `null` 退回问句（D10）；组 9 第二刀在真实 omp 上回归 |
| 中止的时序与错误映射（中止与期限同为 `kb_unavailable`；中止与重排降级重试的先后） | 是 | 组 1 的三个中止用例（`kb-retrieval-abort.test.ts`） |
| 旧调用方兼容（检索测试端点不传信号） | 是 | 组 1：`kb-retrieval`、`kb-ragflow-client-retrieval` 两组既有用例原样全绿；本组无 schema、权限或公共 API 变化，其余风险包不选 |
| 组 2：并发与中止（逐库并发检索；中止后执行立即结束） | 是 | 组 2「中止」与「两个库都命中」的并发证据（「组 2 约定」） |
| 组 2：部分输出（部分库失败、不可探测） | 是 | 组 2「部分失败与不可探测」 |
| 组 2：资源上限（5 库、每库 6 条、1000 码点） | 是 | 组 2「参数校验」；每库 6 条由单轮检索的 `page_size:6` 保证（S2b 既有用例） |
| 组 2：旧调用方兼容（检索测试端点、model 写入钩子、降级限频记录） | 是 | 组 2 回归命令（「组 2 约定」最后一条） |
| 组 3 首刀：并发与顺序（多个在途调用互不等待） | 是 | `omp-host-tools.test.ts`「并发」 |
| 组 3 首刀：资源上限（帧长） | 是 | 「结果过大」两例（「组 3 首刀约定」） |
| 组 3 首刀：错误外泄（处理函数错误原文） | 是 | 「未知工具与失败」的哨兵断言：`OmpProcess` 无 logger、`host-tools.ts` 不记日志；spy 测试进程的 `process.stderr.write` 与 `console.*`，`error` 事件不含哨兵 |
| 组 3 首刀：旧调用方兼容（既有帧路由与假 omp 场景） | 是 | 回归命令（「组 3 首刀约定」最后一条）原样全绿；权限、迁移与 schema、公共 API 不选：本刀只动传输层与假 omp，不碰账号、库表与 REST/SSE |
| 组 3 第二刀：审批语义越界（只认整体恰为 `Allow tool: kb_search` 的标题与闭合选项；`always-ask` 照旧） | 是 | 「组 3 第二刀约定」的正反例与两次变异 |
| 组 3 第二刀：白盒关键路径（放行帧由传输层写） | 是 | 继承 `#onFrame` 的 `!#writesClosed` 守卫；写失败与 prelude 同一处理（`#failIo`）；`omp-host-tools` 真子进程一例 |
| 组 3 第二刀：旧调用方兼容（既有审批与 prelude） | 是 | 回归命令原样全绿；权限、迁移与 schema、跨服务契约、公共 API 不选：不动库表、REST、SSE 形状，只在 `write` / `yolo` 下少一类审批事件 |
| 组 4：白盒关键路径（处理函数只在 `#onNewSlot` 注入） | 是 | 「临时进程不注册」用例 + PR 标注白盒审查 `branch-temp.ts` 的 per 参数无 `hostTools`（用例观测不到注入与否） |
| 组 4：共享装配入口（`app.ts` 迟绑定） | 是 | 4.5 `createApp` 用例；知识库关闭零帧（`session-composer-align` 的 `ALIGNED` 帧序原样） |
| 组 4：权限（以所有者执行） | 是 | 「只以所有者执行」两个账号同时存活、互指为 `not_found` 加正向对照 |
| 组 4：按代的注册状态（spawn、resume、空闲回收） | 是 | 「首次派发前注册」「库清单变化后重发」「空闲回收后重新注册」（兼作 resume 证据） |
| 组 4：失败退役与 502 | 是 | 「注册失败」与 `toolNames` 不符的单元用例 |
| 组 4：regenerate 事务前的帧序 | 是 | chat-sessions 两个帧序场景（`host-tool` 场景应答分支命令） |
| 组 4：旧调用方兼容（知识库关闭、所有者无库） | 是 | 回归命令原样全绿；`kb-omp-env` 零帧 |
| 组 5：公共 API 事件形状（`kb.hits{messageId, stepId, intent, bases}` 严格键集） | 是 | reducer 子例与校验器纯函数正反例表（「组 5 约定」） |
| 组 5：环形缓冲与库表的边界（占一个序号、零写库） | 是 | 「发布但不落库」的具名对照与 SSE id 连续断言 |
| 组 5：回放与快照 | 是 | 「回放与快照」 |
| 组 5：不合规即丢弃、日志不含切片 | 是 | 「不合规即丢弃」的唯一哨兵断言 |
| 组 5：旧 web 兼容 | 是 | web 只给 `stream.ts` 的 `DATA_EVENTS` 注册监听，未知类型忽略；组 6 才解码。无需用例，评审核对 |
| 组 5：资源上限（单事件大小） | 否 | 切片不截断；单事件大小受 host 帧上限约束（组 3 首刀：`host_tool_result` 超 1 MiB 先去 `details`），环形缓冲只按条数限 1000 |
| 组 6 首刀：公共事件解码的严格度（`bases` 深校验） | 是 | 「组 6 首刀约定」反例表，每行 `events` 为 `[]`、`loads` 为 2 |
| 组 6 首刀：非法负载触发重新同步 | 是 | 同上（`loads` 计数，先例 `chat-stream-failure.test.ts:43-86`） |
| 组 6 首刀：未知目标返回同一引用 | 是 | 未知步骤、不存在的消息、user 消息三例 `toBe(before)`（`deepFreeze`） |
| 组 6 首刀：快照恢复与回放 | 是 | `chatStateFromSnapshot` 的 `kbHits:null`；重复帧由既有游标过滤 |
| 组 6 首刀：旧事件与旧用例兼容 | 是 | 回归命令；旧用例只许原地加 `kbHits: null` |
| 组 6 首刀：行数上限 | 是 | `stream.ts` ≤ 780；`chat-page-file-changes.test.tsx` 先移出 `describe("summarizeChanges")` |

## 1. 单轮检索可取消（knowledge-bases「单轮检索」的中止；ragflow-backend「RAGFlow 出站请求」的检索中止）

- [x] 1.1 核对 Context：`server/src/kb/ragflow-retrieval.ts:69-84` 的 `retrieve` 与 `json(…)` 调用，`ragflow-client.ts:25`、`:85`、`:372-425` 的 `signal` 与放弃写法，`retrieval.ts` 的 `retrieveForBase` 与降级重试（`searchWithFallback`）
- [x] 1.2 测试先行：在新文件 `server/test/kb-retrieval-abort.test.ts` 覆盖两份规格的「中止」场景（挂起时中止、调用前已中止不发请求、降级重试前中止只有一次请求），对假 RAGFlow 跑
- [x] 1.3 实现：`RetrievalQuery` 加可选 `signal` 并传给 `json`；`retrieveForBase(deps, base, question, signal?)` 往下传，降级重试用同一个 signal；检索测试端点不传，既有用例原样全绿
  - 组 1 约定（#1962 fixture 审查补；1.2–1.3 照此实现与测试）：
    - 「观察到连接被放弃」的可观测量：假 RAGFlow 的请求记录加 `closed: boolean`——应答写完之前连接就关了为 `true`。实现放在既有兄弟文件 `server/test/support/fake-ragflow-wire.mjs` 的 `wireCounter`（`response` 的 `close` 早于 `finish`），`fake-ragflow.d.mts` 同加字段与注释，`fake-ragflow.mjs` 只在记录初值里加一键；夹具自身的契约用例（照 `aborted` 现有用例所在文件）加一例「挂起的应答被客户端放弃 → `closed:true`；正常应答 → `false`」。
    - 「挂起时中止」：配置了重排模型、`hold` 住检索应答，`controller.abort()` 后结果为 `kb_unavailable`，耗时远小于缺省总期限；检索路由请求恰一条、body 带 `rerank_id`、`closed:true`；`onRerankDegraded` 零次（证明 ragflow-backend「检索请求被中止」的「没有重试」）。
    - 「调用前已中止」：传入已中止的信号，结果 `kb_unavailable`，检索路由零请求。
    - 「降级重试前中止」：配置重排模型，`failRerank()` 让带重排的请求回 `code:102`；注入的 `onRerankDegraded` 回调里调用 `controller.abort()`；结果 `kb_unavailable`，检索路由请求恰一条（带 `rerank_id`），`onRerankDegraded` 恰一次（降级确已发生，按现有次序先记后重试，不改）。
    - `closed` 由服务端 `close` 事件异步置位，断言照 `aborted` 现有写法用 `expect.poll(() => fake.requests()[0]?.closed).toBe(true)`，不在 `await` 之后同步断言。
    - 回归命令：`npm run test:focus --workspace server -- kb-retrieval kb-ragflow-client-retrieval fake-ragflow`（`kb-ragflow-client-retrieval` 是 `RetrievalQuery` / `retrieve` 的直接用例；`fake-ragflow` 跑到夹具契约用例 `fake-ragflow-documents.test.ts` 及其余夹具用例）。

Suggested fixture level: compact - 在既有出站路由上传一个可选参数，没有公共 API、schema 或权限变化；检索测试的既有用例原样全绿即证明不变。
Minimal mergeable slice: atomic - 签名改动与它唯一的验证路径（中止用例）是同一个函数链，拆开后任何一半都没有可单独验证的行为。

## 2. 会话检索 `kb_search`（knowledge-bases「会话检索 `kb_search`」「单轮检索」的扫描用例）

- [x] 2.1 核对 Context：`kb/store.ts` 的 `listBases`（:323）、`getBase`（:320），`kb/bases.ts:89` 的 `ownedBase`，`retrieval.ts` 里检索测试端点的问句判定函数（复用它，不另写），`kb/index.ts` 的 `registerKb` 返回值与 `app.ts:383` 的调用点
- [x] 2.2 测试先行：新文件 `server/test/kb-session-search.test.ts` 覆盖「定义」「两个库都命中」「部分失败与不可探测」「参数校验」「中止」五个场景；断言文本逐字节、`details` 的键集与次序、假 RAGFlow 的请求计数、`knowledge_bases` 列与审计表不变
- [x] 2.3 实现新文件 `server/src/kb/session-search.ts` 的 `createKbSessionSearch(deps)`：
  - `definitionFor(ownerId)`、`execute(ownerId, args, signal)`（design D5）。
  - `resolveReferences(ownerId, ids)`：组 7 第二刀用，返回 `[{id,name}]` 或 `null`（任一不是该账号的库）。
- [x] 2.4 `registerKb` 在知识库开启时把它与既有的返回值一起交回给 `app.ts`，关闭时为 `null`；本组不接进会话（组 4 接）。knip 不报未用：`app.ts` 已读取返回对象，新成员由组 4 消费前先在 2.2 的用例里被调用
- [x] 2.5 扫描用例：在 `server/test/kb-retrieval-canonical.test.ts`（「只有一处检索实现」的权威用例文件）里：
  - 加一条，断言 `session-search.ts` 只经 `retrieveForBase` 检索。
  - 删掉「kb_search 在 server/src 里零出现」这条（它对应的「`kb_search` 工具契约」被本 change 的 knowledge-bases delta REMOVED），文件头注释同改；不另写替代的零出现断言。
  - 组 2 约定（#1963 fixture 审查补；2.2–2.5 照此实现与测试）：
    - 类型与位置：`session-search.ts` 自己声明结构类型，kb 不导入 sessions（组 3/4 在 sessions 侧各写同构类型，由 `app.ts` 接起来）。工具定义 `KbSearchTool` 键集与次序恰为 `{name, label, description, parameters, loadMode}`（`parameters` 取自 `docs/reviews/2026-11-10-omp-host-tools.md` §1）。`definitionFor(ownerId)` 返回 `{tool: KbSearchTool, bases: [{id, name}]} | null`——`bases` 即注册比较的库清单（D3），次序同描述。`execute` 返回 `{text, details?, isError}`。
    - 「该账号的库」只有一份读取：`definitionFor`、`execute`、`resolveReferences` 都经 `store.listBases(ownerId)` 一次读出、按 id 建表判定；不用 `ownedBase`（它抛 `HttpError`），也不逐个 `getBase`。不在表里即 `not_found`。
    - `registerKb` 返回类型改为 `{modelWriteGuard, sessionSearch} | null`：开启时两者都有，关闭时整个返回值为 `null`（D5 的「拿到的是 null」）。`app.ts` 改为 `const kb = registerKb(…); modelWriteGuard ??= kb?.modelWriteGuard;`，不解构出未用的 `sessionSearch`（组 4 才消费）。接线用例：`kb-disabled` 里 `registerKb(app, undefined)` 为 `null`；`kb-session-search.test.ts` 经开启的 `registerKb` 返回值取 `sessionSearch` 跑至少一例。
    - 降级限频记录只有一份：`registerKb` 里 `perMinute(now, () => log({event:"kb_rerank_degraded"}))` 提成一个常量，`createKbRetrieval` 与 `createKbSessionSearch` 共用（ragflow-backend「同一进程 60 秒内至多一行」）。
    - 扫描陷阱：既有断言只许 `\bretrieve\b` 出现在 `ragflow-retrieval.ts` 与 `retrieval.ts`。`session-search.ts` 的依赖类型写 `Parameters<typeof retrieveForBase>[0]`（或 `retrieval.ts` 原地导出的依赖类型），注释与代码里不出现独立的词 `retrieve`。
    - 2.5 新断言的谓词：扫描集合包含 `kb/session-search.ts`（防空过），且其内容匹配 `/\bretrieveForBase\(/`；PR 记录这条断言自己的变异（去掉 `session-search.ts` 的 `retrieveForBase` 调用后新断言变红），与 AC 里旧断言的变异各一次。
    - 问句判定：`retrieval.ts` 的 `isQuestion` 原地导出复用，不另写。
    - 库的次序：用例让建库时间次序与 id 字典序相反（建库后 `UPDATE knowledge_bases SET created_at = …`），断言描述末尾行与 `bases` 按建库时间升序。
    - 文本格式：行间 `\n`，库段之间 `\n\n`，末尾无换行。`[<序号>]` 每个库从 1 起。相似度 `toFixed(4)`，用例含一个需要进位的值（如 `0.123456` → `0.1235`）与一个补零的值（如 `0.5` → `0.5000`）。
    - 参数错误：结果不带 `details` 键（组 5 靠 `details.bases` 是否存在判定）。判定次序：键集 → `question` → `kb_ids`（数组、元素非空字符串）→ 去重后计数。只有「一次至多检索 5 个知识库」断言字节；其余六种只断言 `isError` 为真、无 `details`、零请求。
    - `resolveReferences(ownerId, ids)`：加一例——都是自己的库返回 `[{id, name}]`、次序同输入；任一不存在或属于别人都返回 `null`（两种情形结果相同）；非 `ready` 的库照样解析；重复 id 的校验归调用方（组 7 第二刀），这里按输入原样逐个解析；假 RAGFlow 零请求。
    - 并发与中止（照组 1 约定）：「两个库都命中」两条请求按集合比较 `dataset_ids` 与参数，不按到达次序；并发证据：`hold` 住检索后两个库的请求都已到达，再放行。「中止」：`hold` 住后 `abort`，结果为该库 `failed` 一行、`isError:true`；检索请求恰一条；`expect.poll(…closed).toBe(true)`；耗时 < 3 s。
    - 切片不进日志：命中内容里放哨兵（照 `kb-ingest-helpers.ts` 的写法），断言注入的 `log` 与 stdout/stderr 都看不到它。
    - 回归命令：`npm run test:focus --workspace server -- kb-session-search kb-retrieval kb-models-guard kb-disabled server-assembly-modules`（`kb-retrieval` 覆盖 `-endpoint`、`-rerank`、`-abort`、`-canonical`）。

Suggested fixture level: expanded - 权限判定（别人的库不可探测）与发给模型的内容契约（不变量 2）。
Minimal mergeable slice: atomic - 定义、执行与引用解析共用同一份「该账号的库」读取与同一组用例，拆开只会让两个 PR 改同一个新文件。

## 3. 宿主工具协议与 `kb_search` 的审批放行（omp-runtime「宿主工具协议」；tool-approval「审批请求识别」；omp-test-harness「假 omp host tool 场景」）

- [x] 3.1 核对 Context：`process.ts` 的 `#onFrame`（:561）、`#onUiRequest`（:584）、`#write`（:346）、`#writesClosed`、退出观测；`ui-requests.ts` 的 `approvalRequest` / `isPreludeCard` / `answerFrame`；假 omp 的场景选择与入站帧记录（omp-test-harness「假 omp 入站帧记录」）
- [x] 3.2 假 omp：新文件 `server/test/support/fake-omp-host-tool.mjs` 实现 `host-tool`、`host-tool-parallel`、`host-tool-abort` 三个场景（`yolo` 帧序、三个并发调用含未知工具名、中止），以及其余场景对 `set_host_tools` 回按 `id` 关联的 `success:false`；`fake-omp.mjs` 只加场景分派的几行；场景的契约用例放新文件 `server/test/fake-omp-host-tool.test.ts`
- [x] 3.3 测试先行：新文件 `server/test/omp-host-tools.test.ts`，对真实子进程（假 omp）覆盖「调用与应答」「并发」「取消与迟到的结果」「未知工具与失败」「结果过大」；宿主写出的帧经 stdin tee 观察（`server/test/support/omp-runtime.ts` 的 `capturePromptWrites` 同一手法），断言 `id`、文本、`details` 与 `isError`
- [x] 3.4 实现新文件 `server/src/sessions/omp/host-tools.ts`（在途表、取消、退出中止、应答写帧、过大降级、错误不外泄）；`OmpProcessOpts` 加可选 `hostTools`，`#onFrame` 只加分流的一行；源码与注释里不写 `kb_search`
  - 组 3 首刀约定（#1964 fixture 审查补；3.2–3.4 照此实现与测试）：
    - 3.1 锚点更正：`#onFrame` 在 `process.ts:559`（`:561` 是 `#applyLimits`）。「只加分流的一行」改为允许的改动点：import；`OmpProcessOpts.hostTools`；构造函数解构（`:197`）把 `hostTools` 拆出 `#opts`，不随 `SpawnOmpOpts` 交给 `spawnOmp`；`#onFrame` 的分流（与 `extension_ui_request` 同样带 `!this.#writesClosed` 守卫）；四处中止挂点。合计约 15 行，`process.ts` ≤ 780 行。`fake-omp.mjs` 只加分派（`set_host_tools`、`host_tool_result`、三个场景的 prompt 分派、`abortable`），≤ 770 行。
    - 类型：`host-tools.ts` 导出 `HostToolHandler` 与结果类型 `HostToolResult = {text, details?, isError}`。`call(toolName, args, signal)` resolve `undefined` 表示「这个工具不归我」→ 回 `未知工具`；未注入 `hostTools` 同样回 `未知工具`。`未知工具`、`工具执行失败`、`工具结果过大` 三个常量只在 `host-tools.ts` 出现一次。
    - 错误：处理函数同步 `throw` 与异步 reject 都回 `isError`「工具执行失败」（同步抛错不得逃到 `#onLine` 的 try/catch 成为 `invalid rpc chunk`）；cancel 之后才 reject 的不写帧。错误原文不进帧、不进日志、不进 `error` 事件。
    - 写帧守卫：与 `respondApproval`（`:245`）相同——`stdin.writableEnded || destroyed || #writesClosed` 时不写。`host_tool_result` 的写失败（含帧长超限的拒绝）一律吞掉，不进 `#failIo`、不 emit `error`（否则 `runtime.ts:579-585` 在回合里退役进程）。
    - 中止全部在途：挂在与 `#approvals.clear()` 同位的三处——`#forbidCommands`（`:625`）、`#terminateTransport`（`:641`）、`#failStartup`（`:672`）。第四个挂点：写端关闭——`closeInput()` 在 `end()` 之后同步 `close()`（`commands.ts` 的 `closeStdin` 经它走），`#onFrame` 见 `stdin.writableEnded` 即 `close()` 而不分发，stdin 的 `finish` / `close` 兜底其余 `end()`；写端一关即中止全部在途（omp-runtime「写端关闭：中止全部在途处理」字面；退役的 TERM 宽限期内不再跑 RAGFlow 请求）。中止后放行的结果不写帧。
    - 帧长：量法只有 `#write` 一份（`JSON.stringify(frame)+"\n"` 的 UTF-8 字节数对 `ready` 协商后的 `#maxPhysical`，`:357`）。降级复用 `#write` 的 `OmpProtocolError("outbound frame exceeds physical limit")` 拒绝或同一谓词，不另写量法：先写带 `details` 的帧；被拒则去掉 `details` 再写；仍被拒则写 `isError`「工具结果过大」。
    - 生产行为：不注入 `hostTools` 时回 `未知工具` 是新增的写帧，但今天到达不了（从不发 `set_host_tools`，omp 不会发 `host_tool_call`），组 4 才可达——这是「不可达的新行为」，不写成「行为不变」。`host_tool_call` / `host_tool_cancel` 仍照常作为 `frame` 事件发出（`events.ts` 的 default 分支忽略）。
    - 假 omp：
      - `id` 依次 `h1`、`h2`、`h3`，`toolCallId` 依次 `c1`、`c2`、`c3`。用例 prompt 为 `查一下 KB:k1`（parallel 用 `查一下 KB:k1 KB:k2`），断言 `arguments` 为 `{question:"查一下 KB:k1", kb_ids:["k1"]}`；`host-tool` 一个回合两次调用，「恰一帧」按 `id` 计。
      - 首刀里 `host-tool` 与 `host-tool-abort` 不论 `--approval-mode` 都按 `yolo` 帧序（`write` / `always-ask` 分支与 `Deny` 属于 3.5）；3.3 的用例一律以 `--approval-mode yolo` 起进程；`host-tool-abort` 的 `host_tool_call` 同样先于 `tool_execution_start`。
      - 入站帧经同一个串行 queue（`fake-omp.mjs:149-152`）：场景发出调用后立即返回，用状态表在 `host_tool_result` 到达时推进（`openSelects` 同一先例），不在 handler 里 `await` 结果。`host-tool-abort` 加进 `abortable`；abort 之后接受下一个 prompt，按 normal 回合处理。
      - 其余场景对 `set_host_tools` 的缺省应答钉死为 `{id, type:"response", command:"set_host_tools", success:false, error:"unsupported"}`（今天的应答不带 `id`，`request` 会挂住；全仓无既有用例用到它）。`host-tool-register-fail` 属于 4.2，不在本刀。
    - 用例证据（`omp-host-tools.test.ts`，真实子进程）：
      - 「调用与应答」：处理函数返回 `{text:"r", details:{bases:[]}, isError:false}`，tee 截获 `h1` 恰一帧 `{type:"host_tool_result", id:"h1", result:{content:[{type:"text", text:"r"}], details:{bases:[]}}}`，没有 `isError` 键。
      - 「并发」：处理函数对 `h1` 挂起、对 `h2` 立即返回；放行前处理函数的调用记录已有 `h1`、`h2`；写出次序 `h2` 先于 `h1`；`h3`（`other`，回 `未知工具`）的位置不约束。
      - 「取消与迟到的结果」：`await proc.request({type:"abort"})` 返回即同步点（`host_tool_cancel` 先于 abort 的应答）；此时断言信号已中止，再放行处理函数、让出一个 macrotask；再走 abort 之后那个 normal 回合的 probe prompt（读它的 `frames=`，入站帧记录只经它暴露），断言 tee 没有 `h1` 的 `host_tool_result`，入站帧记录也没有。
      - 「退出」与「写端关闭」各一例：处理函数挂起 `h1`，一例 `proc.kill("SIGKILL")` 后等 `exit`，一例 `proc.child.stdin.end()` 并 `await once(proc.child.stdin, "finish")`（或 `expect.poll(() => signal.aborted)`）；随后放行、让出一个 macrotask；断言信号已中止、tee 自观测点起写入数不变、`proc` 没有新的 `error` 事件。
      - 「未知工具与失败」：未注入、resolve `undefined`、同步 `throw`、异步 reject 各一例（错误信息含哨兵）；cancel 之后才 reject 一例不写帧。
      - 「结果过大」：例一 ASCII `text` 约 100 KiB、`details` 约 1 MiB → 帧无 `details`、`isError` 无；例二 `text` 本身超过 1 MiB（另一 CJK 变体：字符数小于上限、字节数超过）→ `isError`「工具结果过大」。假 omp 会把 `result` 回显进 `tool_execution_end`，所以另断言收到了这次调用的 `tool_execution_end` 且 `proc` 零 `error` 事件（防回显帧超入站上限而假绿）。
    - 回归命令：`npm run test:focus --workspace server -- omp-host-tools fake-omp omp-process omp-rpc omp-runtime omp-approval-requests`，全部原样全绿；`grep -rn kb_search server/src/sessions` 无输出。
- [x] 3.5 假 omp 场景补 `write` / `always-ask` 帧序（`Allow tool: kb_search` 的 select 与 `Deny` 分支），并在 3.2 的契约用例里加对应断言
- [x] 3.6 测试先行后实现：`ui-requests.ts` 的纯判定函数 `isKbSearchApproval`（`ui-requests.ts` 保持无状态，`OmpProcess` 仍是唯一写帧的地方），`#onUiRequest` 在审批识别之前按这一代的 `approvalMode` 判定；覆盖 tool-approval 的新场景与 session-permission-tier「kb_search 的确认只在 always-ask 档出卡」，以及 omp-runtime「RPC IO and child observation」的「kb_search card by approval mode」，既有审批用例原样全绿
  - 组 3 第二刀约定（#1965 fixture 审查补；3.5–3.6 照此实现与测试）：
    - 档位来源：`#onUiRequest` 读 `this.#opts.approvalMode`（`SpawnOmpOpts`，构造时定、整代不变，即写进 argv 的那个值）；不加 `OmpProcessOpts` 字段，`runtime.ts` 不改。
    - `process.ts` 预算 ≤ 782 行（估计值，全局上限 800）。允许的改动点只有：import 加 `isKbSearchApproval`；`#onUiRequest` 里 `const kb = this.#opts.approvalMode !== "always-ask" && isKbSearchApproval(frame);`；`approval` 原地改为 `kb ? undefined : approvalRequest(frame, id)`，`answer` 原地改为 `prelude || kb ? answerFrame(id, "allow") : cancelFrame(id)`；`kb` 为真时不发 `preludeApproval`。放行帧继承 `#onFrame` 的 `!#writesClosed` 守卫，写失败与 prelude 同样进 `#failIo`。
    - Code Canonicality：`isKbSearchApproval(frame)` 判 `method === "select"` 且 `title === "Allow tool: kb_search"`，选项复用 `ui-requests.ts` 既有的 `isApprovalOptions`（两种闭合形状：`["Approve","Deny"]`，与恰三项 `["Approve", /^Approve .+ for this session$/, "Deny"]`），不另写选项判定；文件头注释同改。`server/src/sessions` 自此允许出现 `kb_search`（首刀的 grep 断言不再列入回归）。
    - 假 omp 拿档位：`fake-omp.mjs:137` 改为 `hostToolScenario(scenario, approvalMode, {...})`（净增 0 行，≤ 770）；叶子模块保持无 import、不读 argv（`fake-omp-host-tool.test.ts` 的结构断言原样绿），文件头「首刀不论档位按 yolo」改写。只有 `host-tool` 在 `write` / `always-ask` 下往 handlers 加 `extension_ui_response`（展开在后，盖过 `handleUi`）；`host-tool-parallel`、`host-tool-abort` 不论档位都按 `yolo`。
    - 假 omp `write` / `always-ask` 帧序：每次调用依次 `tool_execution_start{toolCallId:"c<n>", intent:"第 <n> 轮"}`、`extension_ui_request{id:"r<n>", method:"select", title:"Allow tool: kb_search", options:["Approve","Approve kb_search for this session","Deny"]}`；收到 `value:"Approve"` 才发 `host_tool_call{id:"h<n>"}`。`r` / `c` / `h` 序号在调用开始时分配（第 1 次被 Deny 后，第 2 次仍是 `r2` / `c2` / `h2`）。
    - Deny 分支（review 记录 §2.4 未实测，是假 omp 的选择，文件里如此标注）：`value` 不是 `Approve`（`Deny` 或 `cancelled`）时写 `tool_execution_end{toolCallId, toolName:"kb_search", result:{content:[{type:"text", text:"Tool call denied by user: kb_search"}]}, isError:true}`（文本照 `fake-omp-composer.mjs:126` 内联），这次不发 `host_tool_call`、处理函数零调用；回合接着走第 2 次调用，两次都结束后照常发正文与终态 `agent_end`。
    - 3.5 契约用例（`fake-omp-host-tool.test.ts`）：`write` 下 Approve 两次（每个 `host_tool_call` 之前都有 `r<n>` 的 select；作答之前输出与入站帧记录都没有 `host_tool_call`）；`always-ask` 同一帧序一例；Deny 一例（失败 end 字面量与之后的 `r2` 调用）。
    - id 分配：tool-approval 场景用 `r1`（假 omp `host-tool`），omp-runtime「kb_search card by approval mode」用 `k1`，走 FakeChild 合成帧，放在 `omp-process-prelude.test.ts`；先给 `support/omp-rpc.ts` 的 `startFakeProcess` / `openFakeProcess` 加可选 `approvalMode`，覆盖 `tempOpts` 写死的 `"write"`（`:76`），缺省不变（`yolo` 只能用合成帧测：假 omp 在 `yolo` 下不发 select）。
    - 合成帧正反例（oracle：stdin 记录 + `approval` + `preludeApproval` 事件）：
      - `write` 与 `yolo` 下，三项与两项选项都立即收到 `{type:"extension_ui_response", id, value:"Approve"}`；没有 `approval`、没有 `preludeApproval`；之后 `respondApproval(id, "deny")` 什么也不写（「未登记」的观测量，先例同在 `omp-process-prelude.test.ts`）。
      - `always-ask` 下三项照常上抛 `{id, tool:"kb_search", title:"Allow tool: kb_search"}`，作答之前 stdin 没有应答；`allow` 恰写一帧 `Approve`。
      - `write` 与 `yolo` 下，`Allow tool: kb_search\nReason: x`、`Allow tool: kb_search_extra`、`Allow tool: kb_search `（尾随空格）都按审批上抛，`tool` 分别为 `kb_search`、`kb_search_extra`、`kb_search`。
      - 恰好的标题配非闭合选项（`["Approve","Approve kb_search","Deny"]`）与 `method:"confirm"`：收到 `cancelled:true`，不放行、不上抛。
    - 纯函数表格用例放进 `omp-approval-requests.test.ts`：`isKbSearchApproval` 对上面正反例逐个给出真 / 假，不读档位。
    - 真子进程（`omp-host-tools.test.ts`，`start()` 加档位参数，缺省 `yolo`）：`write` 跑 `host-tool`、注入处理函数——tee 截获 `r1` 的 `Approve` 在 `h1` 的 `host_tool_result` 之前，零 `approval`，回合到 `agent_end`；`always-ask` 一例——`r1` 上抛，未作答之前没有 `host_tool_call`。
    - session-permission-tier「kb_search 的确认只在 always-ask 档出卡」：新文件 `server/test/session-kb-search-approval.test.ts`，走生产装配（`createApp` → `registerSessions`，先例 `session-prelude-card.test.ts`；`approvalMaxMode` 缺省 `yolo`，三档可选）。组 4 之前 slot 不注入 `hostTools`，两次调用都回 `未知工具`：「照常完成」在此指两个 `kb_search` 步骤都以 isError 结束、回合以 done 收尾（生产可达要到组 4）。断言：`write` / `yolo` 下 `chat_approvals` 零行、零 `approval.request` 事件、零 `session.approval` 审计；`always-ask` 下两次调用各一条 `approval.request`（`tool:"kb_search"`），与 `kb_search` 步骤配对，作答 allow 后才出现下一次。
    - 变异（PR 各记一次）：去掉档位判断 → `always-ask` 用例红；标题放宽为前缀或首行匹配 → 近似标题用例红。
    - 回归命令：`npm run test:focus --workspace server -- approval omp-host-tools fake-omp omp-process omp-rpc omp-runtime session-prelude-card`，全部原样全绿；AC 的 `make check` 本地可跑（不需要已运行的服务），PR 附命令与退出码。

Suggested fixture level: expanded - omp 子进程治理（白盒关键路径）、并发与取消、审批语义。
Minimal mergeable slice: 3.1–3.4 为首刀：协议在 `yolo` 帧序下独立可测，`hostTools` 为可选参数，生产路径不注入时行为不变；3.5–3.6（审批放行）依赖首刀的假 omp 场景与组 2（扫描用例已放开 `kb_search` 字样）。

## 4. `kb_search` 的注册与装配（omp-runtime「`kb_search` 的注册」；chat-sessions「派发前按会话设置对齐进程」）

- [x] 4.1 核对 Context：`composer-align.ts` 的 `alignModel` / `alignmentOf` 与 `slot.generation.applied`（:136-154）、`pool.ts` 的 `commandOn`（:380）与 `buildSessionRuntime`（:296）、`supervisor.ts` `#onNewSlot`（:474）与派发前对齐的调用点、`runtime.ts` 的 `SessionRuntimeOpts` 与 `#openProcess`（:436）、`branch-temp.ts:107` 的 `branchAt`
- [x] 4.2 假 omp：在 `server/test/support/fake-omp-host-tool.mjs` 加 `host-tool-register-fail` 场景（`set_host_tools` 回 `success:false`），契约用例加在 `server/test/fake-omp-host-tool.test.ts`
- [x] 4.3 测试先行：新文件 `server/test/session-host-tool-align.test.ts`，在 slot 层以假 omp 与注入的定义源覆盖 omp-runtime「`kb_search` 的注册」的「首次派发前注册」「不注册」「库清单变化后重发」「空闲回收后重新注册」「注册失败」「临时进程不注册」「只以所有者执行」（两个账号各一个会话，`kb_ids` 互指对方的库，结果为 `not_found`），以及 chat-sessions「派发前按会话设置对齐进程」的「宿主工具对齐在模型命令之后、在 regenerate 事务之前」「宿主工具对齐失败时 regenerate 不动分支」
- [x] 4.4 实现：
  - 先 grep 既有用例里「知识库开启且所有者有库、又跑会话回合」的组合：假 omp 的缺省场景对 `set_host_tools` 回 `success:false`，这类用例改用 `host-tool` 场景，不改缺省应答。
  - 新文件 `server/src/sessions/host-tool-align.ts`：派发前对齐的第 3 步（每代所记的库清单、比较、`set_host_tools`、应答校验），经 `commandOn` 与 `slot.generation`；`supervisor.ts` 在第 2 步之后只加一处调用，失败与第 1、2 步同一处理。
  - 处理函数在 `pool.ts` `buildSessionRuntime` 绑定为「以 slot 的所有者执行」，经 `SessionRuntimeOpts` 透传到 `OmpProcessOpts.hostTools`；只有 `#onNewSlot` 这条路径传，`branch-temp.ts` 不传。`runtime.ts` 只加透传。
  - 组 4 约定（#1966 fixture 审查补；4.2–4.5 照此实现与测试）：
    - 4.1 锚点更正：`alignModel` 在 `composer-align.ts:141-157`；派发前对齐的唯一调用点是 `supervisor.ts:405`（`alignModel(slot, effective).then(() => use(slot))`）；`#onNewSlot` 在 `:430`，`:474` 是其中的 `buildSessionRuntime` 调用。其余锚点准确。
    - 改动面（超出原 PR Boundary 的写明）：`omp/commands.ts` 的 `RuntimeCommandFrame` 加 `{type:"set_host_tools"; tools: readonly object[]}`；`pool.ts` 的 `Generation` 加 `hostTools: readonly {id,name}[] | undefined`，在 `generationTokens.issue` 与 `applied: undefined` 同处初值 `undefined`（`undefined` = 尚未注册，`[]` = 已撤下，二者区分）；`supervisor-options.ts` 加可选定义源，`sessions/index.ts` 的 `RegisterSessionsOptions` 透传。
    - `supervisor.ts` 允许的改动点：import、私有字段、构造函数赋值、`#onNewSlot` 的 per 参数一行、`:405` 原地改为 `alignModel(...).then(() => alignHostTools(slot, <定义源>?.definitionFor(<所有者>) ?? null)).then(() => use(slot))`。定义在第 2 步之后的闭包里读（不在 `:404` 的 `alignmentOf` 里读——那时还没经过退役与准入等待）。regenerate 也经 `#onSlot` 进来，这一处同时覆盖 prompt 与 regenerate。预算 `supervisor.ts` ≤ 792 行。
    - 处理函数的通道：放在 `PerRuntime` 上，可选的未绑定 `hostTools?: <定义源>`；只有 `#onNewSlot` 传，`buildSessionRuntime` 用 `per.ownerId` 绑成 `HostToolHandler` 放进 `SessionRuntimeOpts.hostTools`。SHALL NOT 放进 `SessionSupervisorRuntime` 或 `SpawnShared`（`branch-temp.ts:107` 与正常 slot 共用这两者，否则临时进程也被注入）。`runtime.ts` 只加 opts 字段、私有字段、构造函数赋值、`#openProcess` 的展开，≤ 745 行。
    - sessions 侧类型与工具名：`host-tool-align.ts` 声明结构类型的定义源 `{definitionFor(ownerId) → {tool: {name: string} & object, bases: readonly {id, name}[]} | null; execute(ownerId, args, signal) → Promise<HostToolResult>}`（`HostToolResult` 取自 `omp/host-tools.ts`）。为免 `pool ↔ host-tool-align` 运行期成环：常量 `KB_SEARCH = "kb_search"` 与适配器（`toolName !== KB_SEARCH` 时 resolve `undefined`，否则调 `execute(ownerId, args, signal)`）放在 `pool.ts`；`host-tool-align.ts` 从 `pool.ts` 导入 `commandOn` 与 `KB_SEARCH`（单向），`pool.ts` 对定义源类型只 `import type`。适配器不加 try/catch：`execute` 同步抛错或 reject 已由 `host-tools.ts` 的 `#run` 兜成「工具执行失败」。
    - 失败映射：`#runCommand`（`runtime.ts:296-304`）已把 `success:false` 转成 `AgentUnavailableError`、成功时返回 `response.data`；第 3 步只校验 `data.toolNames` 与 `[KB_SEARCH]`（撤下时 `[]`）深相等，不符自己抛 `AgentUnavailableError`（`translateSupervisorError` 只把这一类映射为 `agent_unavailable`）。`definitionFor` 同步抛错（DB 错误）照 `managedMcpJson` 先例包成 `AgentUnavailableError` 并带 `cause`。成功后才在命令所在的 `slot.generation` 上记清单，与 `alignModel` 同一写法。
    - 4.2：`host-tool-register-fail` 不进 `fake-omp-host-tool.mjs` 的 `SCENARIOS`（否则接管 prompt）；`onRegister` 的非 active 分支原地按场景取 `error`（`"host tools rejected"` 或 `"unsupported"`），`fake-omp.mjs` 净增 0 行（≤ 770），文件头「其余场景」一句同改。契约用例断言 `{id:"r1", type:"response", command:"set_host_tools", success:false, error:"host tools rejected"}` 恰一帧，之后普通 probe 回合照常完成。
    - regenerate 世界：`fake-omp.mjs:229` 的分支命令应答条件原地改为 `scenario === "branch" || scenario === "host-tool"`（净增 0 行），契约用例加一例；用 `openRegenWorld` 的 `entries` 对齐用户消息。首次派发单独断言 `negotiate_protocol,get_state,set_model,set_thinking_level,set_host_tools,prompt`；之后新建一个库、在同一代进程上 regenerate（规格 SHALL NOT 为对齐而重新 spawn，`alignModel` 见模型与强度未变不发命令）：regenerate 之前记下 `spawnedAt(world, 0).stdin.length`，202 之后增量的 `types()` 恰为 `["set_host_tools","get_branch_messages","branch","get_state","prompt"]`（先例 `session-composer-align.test.ts:630-641` 的 `first.stdin.slice(sent)`），且这帧 `set_host_tools` 的描述列出两个库；「对齐失败时 regenerate 不动分支」用 `host-tool-register-fail`：502、stdin 无 `get_branch_messages` / `branch`、分支行不变。
    - 帧序观测：`host-tool` 场景接管每条 prompt，`frames=` probe 到不了；注册失败两例 slot 已退役。所以七个 omp-runtime 场景与两个 chat-sessions 场景一律用 `spawnedAt(world, n).stdin`（`session-approval-helpers.ts:284`）加 `types()`（先例 `session-composer-align.test.ts:619-660`），断言写到 `prompt` 为止的前缀；`tools` 恰一项、`loadMode:"essential"`、描述列出两个库，都从同一份 stdin 帧读。
    - 「空闲回收后重新注册」：复用 `session-composer-align.test.ts:116` 的 `reclaimed()`，原地移进共享 helper（不复制，jscpd）；断言第二次 spawn 的 argv 含 `--resume <第一回合会话文件>`，且 `spawnedAt(world, 1)` 在 `prompt` 之前有 `set_host_tools`。兼作 §2.8 resume 证据，不另写 resume 用例。
    - 「只以所有者执行」加正向对照：两个账号的 slot 同时存活（先建 A、再建 B、再让 A 派发——「最后一个所有者生效」的错法会变红）。A 用 `KB:kB` 得 `知识库 kB：未找到该知识库`、`isError:true`；B 用 `KB:kA` 对称一例；A 用 `KB:kA` 得假 RAGFlow 切片的文本。前两例假 RAGFlow 检索请求为零。用真实 `createKbSessionSearch`，第二个账号用 `zhaoliu`（`session-db-helpers.ts` 的 `PRINCIPAL_ZHAOLIU`）建会话。
    - 未知工具名一例：注入定义源的 slot 上跑 `host-tool-parallel`，第三个调用（`other`）回 `未知工具`，`execute` 零次收到它（适配器 resolve `undefined` 的证据）。
    - `toolNames` 不符一例（假 omp 原样回显，造不出）：`session-host-tool-align.test.ts` 单元用例桩 `runtime.command` resolve `{toolNames:["other"]}`（mock 依赖，不 mock 被测），断言抛 `AgentUnavailableError`、所记清单不变。
    - 桩与真实：首次注册、不注册、清单变化、空闲回收、注册失败、临时进程、两个 regenerate 例用桩定义源；「只以所有者执行」与 4.5 用真实 kb 与假 RAGFlow。原地扩展既有构造器（`openRegenWorld` / `openForkWorld` / `openRecordingSession`）的 assembly 透传，不另写新构造器；库行照 `kb-settings-helpers.ts` 用 store 或 SQL 直接插入。
    - 4.4 保持不变清单：按「知识库开启、所有者有库、又跑会话回合」grep，没有既有用例会坏（`kb-omp-env.test.ts` 开知识库但账号无库，`definitionFor` 为 `null`，零帧）。`session-kb-search-approval.test.ts` 的装配知识库关闭、不注入处理函数，照旧 `未知工具`；其文件头「Before group 4 the slot injects no host tool handler」原地改为「这个装配知识库关闭」。
    - 4.5 迟绑定：`registerSessions`（`app.ts:314`）早于 `registerKb`（`:383`），而 `registerKb` 要读 `app.workspaces`（`:342` 才 decorate），不能前移。照 `() => modelWriteGuard` 先例：是否注入在 `:314` 以 `assembly?.kb !== undefined` 判定（与 `registerKb` 返回 `null` 等价），定义源是闭包、派发时才读 `kb.sessionSearch`。预算 `app.ts` ≤ 766 行。4.5 用例 oracle：stdin 里 `host_tool_result.result.content[0].text` 含假 RAGFlow 切片的哨兵。
    - CK-15：照 CK-11–CK-14 写法（「由 owner 执行（agent 不得代签）。」开头），结论 `待签`，接在 CK-14 之后；`web/test/functional-checklist.test.ts` 全过。
    - 回归命令：`npm run test:focus --workspace server -- session-host-tool-align fake-omp-host-tool omp-host-tools session-kb-search-approval session-composer session-regenerate session-fork session-undo kb-session-search kb-omp-env kb-disabled server-assembly-modules`，全部原样全绿；外加 `npm run test:focus --workspace web -- functional-checklist`。
- [x] 4.5 装配：`app.ts` 把组 2 的 `definitionFor` / `execute` 注入 supervisor 与 pool，知识库关闭时不注入；`createApp` 级用例（假 omp `host-tool` 场景 + 假 RAGFlow）断言一个回合里 `host_tool_result` 的文本来自假 RAGFlow 的切片
- [x] 4.6 `docs/architecture/system.md`：`sessions` 行写 host tool 的注册与分派（经注入），`kb` 行写会话检索，§4 依赖规则的 `sessions → kb` 改为「经 `app.ts` 注入，不导入」
- [x] 4.7 验收清单 `docs/acceptance/functional-checklist.md` 的 CK 节新增 CK-15（在接上真实 RAGFlow 与真实模型的会话里问库里才有的事实，回答用到库里的切片，且助手消息里有这次检索：组 6 第二刀合入前是名为 `kb_search` 的步骤卡，之后是「知识库检索」卡），结论 `待签`，由 owner 执行（agent 不得代签）

Suggested fixture level: expanded - omp 子进程治理（白盒关键路径）与共享装配入口（`app.ts`、supervisor）。
Minimal mergeable slice: atomic - 注册逻辑与装配是同一条验证路径（4.5 的 `createApp` 用例要两者都在）；只合注册而不装配，生产里没有任何定义源，等于死代码。

## 5. `kb.hits` 事件（chat-stream「纯协议事件归约」的 `kb_search` 派生、「检索结果事件发布」）

- [x] 5.1 核对 Context：`events.ts` 的运行中工具条目与 `applyToolStart` / `applyToolEnd`、`todo.updated` 的派生写法；`turn-control.ts:261` 的 `turn.retry` 分支；supervisor 的 `todo.updated` 校验与发布；合并窗口的冲刷清单
- [x] 5.2 测试先行：reducer 用例（「kb_search result yields a raw candidate」）放进 reducer 的权威用例文件；发布用例放新文件 `server/test/session-kb-hits.test.ts`，以假 omp `host-tool` 场景覆盖「发布但不落库」「回放与快照」「不合规即丢弃」
- [x] 5.3 实现：reducer 记下 `intent` 并在 `step.end` 前发 `kb.hits`；校验与 stderr 记录放新文件 `server/src/sessions/kb-hits.ts`，supervisor 只加调用；`persistEvent` 与 `step.end`、`files.changed` 同样经 `steps.toolIds`（`turn-control.ts:297`、`:319`）把 `stepId` 映射成落库的步骤 id，映射不到即丢弃，映射后与 `turn.retry` 同样原样返回、不写库；用例断言 `kb.hits.stepId` 等于同一步骤 `step.start` 的 `stepId`；事件种类计数断言原地加一
  - 组 5 约定（#1967 fixture 审查补；5.2–5.3 照此实现与测试）：
    - 5.1 锚点更正：supervisor 里没有 `todo.updated` 的校验——它在 `turn-control.ts:327` 的 `store.storeTodo` 与 `session-todo.ts` 的 `normalizeTodo`；stderr 记录的先例是 `upstream-failure-log.ts` 的 `reportUpstreamFailure`（调用点 `supervisor.ts:710`，经 `log` 端口，外包 try/catch 与 `consumeThenable`）；「合并窗口的冲刷清单」指 `delta-coalescer.test.ts:467-485`，源码不改（`route` 对任何非增量事件先 flush，`delta-coalescer.ts:96`）；`turn-control.ts:261` 是注释，`case` 在 `:263`。
    - 「事件种类计数断言原地加一」：仓库里没有事件种类计数断言，改为把 `kb.hits` 原地加进 `delta-coalescer.test.ts:469` 的冲刷事件清单（「every non-delta event of the turn flushes held thinking first」）。
    - 意图：服务端只读 `tool_execution_start` 顶层 `intent`（review 记录 §2.2）；非空字符串照用，缺失、`""` 或非字符串为 `null`；不读 `args.question`（退回问句是组 6 检索卡的事，D10）。
    - 改动面：`omp/spawn-gate.ts:76` 的 `SpawnLog` 封闭联合原地并入 `kb-hits.ts` 声明的 `KbHitsInvalidRecord{event:"kb_hits_invalid", messageId}`（恰两键）。`ChatEvent` 加 `kb.hits` 变体，照 `todo.updated` 写法 `bases: StepId extends number ? KbHitBase[] : unknown`；校验后的有类型 `bases` 交给 `persistEvent` 的 `kb.hits` 分支，不用 `as`。
    - 接缝：supervisor 的一处调用放在 `#commit` 循环里 `route` 之前，校验先于映射；`#commit` 复杂度仍 ≤ 15。两种丢弃分开：不合规丢弃写一条 `kb_hits_invalid`；映射不到丢弃不写记录。
    - 预算：`supervisor.ts` ≤ 795（只许 import 与那一处调用）；`events.ts` ≤ 600；`turn-control.ts` ≤ 380。
    - 校验器规则：照 chat-stream「检索结果事件发布」（`specs/chat-stream/spec.md:117-123`）逐条——`bases` 为 1–5 项的数组；每项精确自有键集 `{kbId, name, status, hits}`；`kbId` 为非空字符串；`status ∈ {ok, not_found, not_ready, failed}`；`name` 在 `not_found` 时为 `null`、其余为非空字符串；`hits` 为至多 6 项的数组，`status` 不是 `ok` 时为 `[]`；每个命中精确自有键集 `{documentId, name, similarity, content}`，`documentId`、`name`、`content` 为字符串，`similarity` 为有限数（`NaN`、`Infinity` 不合规）；`intent` 为 `null` 或非空字符串。另：任何一层多键少键、稀疏数组都不合规。纯函数正反例表给每个分支至少一个反例（至少含：0 库、6 库、空 `kbId`、未知 `status`、`ok` 配 `null` 名、`not_found` 配非 `null` 名、空名、7 条命中、非 `ok` 带命中、命中多键、`similarity` 为 `NaN` / `Infinity` / 字符串、`content` 非字符串、稀疏数组、`intent` 为 `""`）。输出照 `normalizeTodo` 先例新建对象、键序固定，不原样转发。复用 `file-changes.ts:87/:92` 的 `own` / `asPlain`；`session-todo.ts` 私有的 `validItems` 若可复用则原地导出，不复制（jscpd）。
    - reducer 用例放新兄弟文件 `server/test/session-events-kb-hits.test.ts`（照 `session-events-todo.test.ts` 先例；PR Boundary 因此为两个新用例文件）。规格四例之外补：帧 `isError:false` 而 `result.isError:true` → 无 `kb.hits`（现有 `applyToolEnd` 只读帧级 `isError`，`events.ts:260`，须另判 `result.isError`）；`bases` 只在 `details` 的原型上 → 无 `kb.hits`；`intent` 为 `""` 或非字符串 → `null`。
    - 发布用例输入：`session-host-tool-align.test.ts:66` 私有的 `stubSearch` 原地移进共享 helper 并参数化 `execute` 的结果（不复制）；世界用 `openRegenWorld({scenario:"host-tool", assembly:{sessionSearch, log}})`；合规 `bases` 字面量覆盖 `ok`（含 6 条命中）、`not_found`（`name:null`、`hits:[]`）、`failed`；期望意图 `第 1 轮` / `第 2 轮`（`fake-omp-host-tool.mjs:41`）。
    - 「发布但不落库」：具名对照——同一个桩只去掉 `details` 跑第二个会话；比较 `chat_messages` / `chat_steps` 时排除 id、外键、时间戳，其余逐列相等。会话显式定档 `yolo`（`always-ask` 下 `step.start` 与 `kb.hits` 之间插 `approval.request`）；序号用 SSE id 连续断言（`step.start` 为 n、`kb.hits` 为 n+1、`step.end` 为 n+2）；`kb.hits.stepId` 等于同一调用 `step.start.stepId` 的断言放在这里。
    - 回放：`supervisor.subscribe(session, <第一个 step.start 的 id>)`（先例 `session-turn-retry.test.ts:169-173`），断言 `mode:"replay"` 里恰有两条 `kb.hits`。快照：回合结束后快照 JSON 里找不到切片哨兵，也找不到键名 `bases`。（回合进行中不带 `Last-Event-ID` 的连接经 `ring-buffer.ts` 的 `#activeTurn` 会回放本回合的 `kb.hits`，与 `turn.retry` 一致；组 6 知悉。）
    - 映射不到即丢弃（假 omp 端到端不可达）：`session-kb-hits.test.ts` 里一个 `persistEvent` 单元用例——`steps.toolIds` 没有该 id 返回 `undefined`、有则返回数字 `stepId`；桩 store 的任何方法零调用（mock 依赖，不 mock 被测）；注入的 `log` 零记录。
    - 不合规即丢弃：唯一哨兵串作 `content`；断言注入的 `log` 恰收到 `[{event:"kb_hits_invalid", messageId:<assistantId>}]`，所有记录序列化后与 spy 到的 `process.stderr` 都不含哨兵；另加一张纯函数正反例表，逐条覆盖上面每条校验规则。
    - 回归命令：`npm run test:focus --workspace server -- session-kb-hits session-events delta-coalescer session-host-tool-align session-turn-retry session-composer`，全部原样全绿；`make lint`、`make typecheck`、`make anti-drift`。

Suggested fixture level: expanded - 会话事件流是公共 API（public API），且涉及环形缓冲与持久化的边界（persisted / shared state）。
Minimal mergeable slice: atomic - reducer 派生与 supervisor 校验发布是同一个事件的两半：只派生不发布，事件出不了 supervisor；只发布不派生，没有事件可发。

## 6. web：`kb.hits` 与检索卡（chat-web「纯会话视图归约」「事件流消费与续流」「助手消息分段」「工具段摘要与折叠」「会话知识库检索卡」）

- [x] 6.1 核对 Context：`stream.ts` 的事件名表（:121）与归约、`stream-failure.ts` 的 `turn.retry` 严格解码先例、`message-segments.ts`、`tool-summary.ts:9-24`、`tool-call-group.tsx` / `message-segments-view.tsx` 的分流、`step-card.tsx`
- [x] 6.2 测试先行（新文件 `web/test/chat-stream-kb-hits.test.ts`）后实现：新文件 `web/src/features/chat/stream-kb-hits.ts`（严格解码与把 `kbHits` 挂到步骤上），`stream.ts` 只加事件名与分派的几行；用例覆盖「检索结果归约」「检索结果事件严格解码」（键集不符触发重新同步、未知步骤保持同一引用）
  - 组 6 首刀约定（#1968 fixture 审查补；6.2 照此实现与测试）：
    - 形状：每个步骤一个 `kbHits: {intent: string | null, bases} | null`，同一步骤后到者胜（D10「挂到消息上」以规格「挂到步骤上」为准；组 6 第二刀按行读取）。类型 `ChatKbHits` 与校验规则都在 `stream-kb-hits.ts`，`stream-steps.ts` 只 `import type`（免与 `updateStep` 运行时成环）；只导出 `stream.ts` 与 `stream-steps.ts` 实际用到的符号（knip）。
    - PR Boundary 补 `web/src/features/chat/stream-steps.ts`：`ChatStepView` 加必填 `kbHits: ChatKbHits | null`；`startStep` 置 `null`；`endStep`（`stream-steps.ts:42-56` 逐字段重建）必须加 `kbHits: current.kbHits`——kb.hits 恒先于同一调用的 step.end，不加则命中被 step.end 抹掉。`stream.ts:136-144` 的快照步骤映射加 `kbHits: null`。
    - 解码深度：照 chat-web「事件流消费与续流」逐条校验，规则同 chat-stream「检索结果事件发布」——`stepId` 为安全整数；`intent` 为 `null` 或非空字符串；`bases` 1–5 项，每项严格键集 `{kbId, name, status, hits}`，`kbId` 非空，`status ∈ {ok, not_found, not_ready, failed}`，`name` 在 `not_found` 时为 `null`、其余非空字符串，`hits` 至多 6 项且非 `ok` 时为 `[]`，每条命中严格键集 `{documentId, name, similarity, content}`、`similarity` 为有限数。用 `web/src/lib/api-json.ts` 的 `hasExactlyKeys` / `parseJsonArray`；web 侧规则只写在 `stream-kb-hits.ts` 一处，不照抄 `server/src/sessions/kb-hits.ts`（jscpd 同扫两棵树）。
    - 重新同步观测（先例 `chat-stream-failure.test.ts:43-86`）：用 `chat-stream-support.ts` 的 `connectChat` / `chatSnapshot` / `settle`，先装 `1:2` 快照，再 `emitData("kb.hits", "1:3", …)`。正例断言 `connector.events` 用 `toStrictEqual` 逐值保留（两条，第二条 `intent:null`），`loads` 仍为 1；反例断言 `events` 为 `[]`、`loads` 为 2。本地 `installed()` 已有 4 份副本，新文件复用或就近导出，不贴第五份。
    - 反例表（每行 `events` 为 `[]`、`loads` 为 2）：缺键 / 多键、`stepId` 为字符串或 `1.5`、`intent` 类型错、`intent:""`、`bases:[]`、6 个库、某库或某命中缺键 / 多键、非法 `status`、`not_found` 带字符串 `name`、`ok` 的 `name` 为 `null`、非 `ok` 的库带命中、`ok` 带 7 条命中、`similarity` 为字符串。
    - 「检索结果归约」补：完整一串 step.start(5, `kb_search`) → kb.hits → step.end → turn.end 后步骤 5 的 `kbHits` 仍是 kb.hits 的值；`chatStateFromSnapshot` 对含 `kb_search` 步骤的快照给出 `kbHits: null`（「刷新后只剩各轮」的数据前提）；未知步骤（99）、不存在的消息、指向 user 消息的 kb.hits 在 `deepFreeze` 的状态上都 `toBe(before)`。
    - 回放与续流：重复帧由既有游标过滤（`isSuccessor`）丢弃，后到者胜本身幂等，不加新代码；经完整快照恢复后所有 `kbHits` 回到 `null`（含组 5 所述 `#activeTurn` 无 `Last-Event-ID` 回放里游标不大于快照游标的 kb.hits）；kb.hits 不清 `retrying`。
    - 旧用例唯一许可改动：在既有视图步骤字面量与构造 helper 里原地加 `kbHits: null`，不改任何断言（必填字段会让 `tool-summary.test.ts:10`、`message-segments.test.ts:25`、`chat-tool-group.test.tsx:27`、`chat-page-file-changes.test.tsx:377-381` 等 typecheck 失败，精确 `toEqual` / `toStrictEqual` 在 `chat-stream.test.ts`、`chat-stream-recovery.test.ts`、`chat-runtime-convert.test.ts` 等运行时失败）；实施时 grep 出完整清单写进 PR。`web/test/chat-page-file-changes.test.tsx`（793 行）先把 `describe("summarizeChanges")` 原地移到兄弟文件，再加字段（size-guard）。
    - 行数预算：`stream.ts` 771 → ≤ 780（import、`ChatEvent` 联合、`DATA_EVENTS`、`applyChatEvent` 的 case、`decodeEvent` 的 case、快照步骤 `kbHits: null`）；`use-chat-session.ts` 零改动。
    - 回归命令：`npm run test:focus --workspace web -- stream-kb-hits chat-stream chat-page-file-changes tool-summary message-segments chat-tool-group chat-runtime-convert`（再加 grep 清单里其余改到的文件），外加 `make lint`、`make typecheck`、`make anti-drift`。
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
