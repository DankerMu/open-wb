# Design: fix-upstream-failure-surfacing

## Context

动机见 proposal。证据标签：**实测** = 2026-10-13 红灯测量（官方 omp v18.0.10 二进制，`server/dist/server.js` 经真实模型代理，本地假上游，逐用例日志在测量 scratchpad，不入库）；**读代码推出** = 读本仓或 `resource/oh-my-pi`（v18.0.10，`33cc6b9`）源码得出、未运行；**推算** = 由实测数字推出、实现须实测。行号取自本分支基线 `09c9b5b7`。

**失败今天怎么走（实测）：**

| # | 上游行为 | 上游请求数 | 回合结束 | 代理给 omp 的 |
|---|---|---|---|---|
| 1 | 400 `text/plain` `400 Bad Request` | 1 | 2.9 s failed | 400 原样 |
| 2 / 3 / 4 | 401 / 403 / 404 `model_not_found` JSON | 1 | 2.1–2.2 s failed | 原样 |
| 5 | 429 额度（`insufficient_quota`，无 `Retry-After`） | 6 | 18.4 s failed | 429 原样 |
| 6 | 500 JSON | 132（11 轮 × 12） | 402.7 s failed | 502 `agent_unavailable` |
| 7 / 8 | 503 `text/plain` / 连接被拒 | 35 / 0（90 s 内） | 90 s 仍 running | 502 |
| 9 | 接受连接、永不回响应 | 1 | 90 s 内没有任何帧 | — |
| 10 | 200 SSE，两段 delta 后断开 | 1 | 2.3 s failed，正文「你好，半句」保留 | 200 后断流 |
| 11a / 11b | 密钥含 `\n` / 非 Latin-1 | 0 | 90 s 仍 running | 502（Node 同步抛 `ERR_INVALID_CHAR`，请求没发出） |
| 12 | 400 空正文 | 1 | 2.2 s failed（中途两次 `auto_compaction_*`） | 400 原样 |

- 所有 16 次运行中，服务在 prompt 与关停之间一行都没有输出（实测）。Fastify logger 是关的（`server/src/app.ts:178`）；既有的 application stderr 记录走 `server/src/server.ts:190-196` 的 `writeRecord`（受管 writer，`log`/`warn` 端口）。
- 失败文本只在 SSE `error` 事件里；`persistEvent` 对 `error` 不落库直接返回（`server/src/sessions/turn-control.ts:229-230`）；快照的失败助手消息是 `{"content":"","status":"failed",…}`，没有错误字段（实测）。
- omp 的 `errorMessage` 形如 `<status> <message>\n<message> (type=… param=… code=…)`（实测引文；拼装见 `packages/ai/src/utils/openai-http.ts:122-149`、`packages/ai/src/error/classes.ts:47-69`、`packages/ai/src/utils/http-inspector.ts:144-170`，读代码推出）。400 与 413 时 omp 另在状态目录写一份请求转储并在文本末尾加 `\nraw-http-request=<路径>`（`http-inspector.ts:49`、`:70`，读代码推出；case 1 / 12 实测出现该行）。
- `< 500` 时上游的状态码与正文已经原样到达 omp 的 `errorMessage`，`message_end.message.errorStatus` 也是上游状态（实测）。`≥ 500`、连接失败与非法头只有代理知道真实原因：状态码在 `sendUpstream` 的 `upstreamResponse.statusCode`，正文被 `resume()` + `destroy()` 丢弃；连接失败的原因在 `requestUpstream` 的 reject 里被吞（读代码推出）。
- `passthroughHeaders`（`index.ts:328-337`）只放行 `content-type`、`content-encoding`、`location`，`Retry-After` 到不了 omp（读代码推出）。

**omp 的三层重试（v18.0.10）：**

- 传输层：`DEFAULT_MAX_ATTEMPTS = 6`（`packages/ai/src/utils/openai-http.ts:33`），对 408、429、≥500 与瞬时网络错误重试（`packages/utils/src/fetch-retry.ts:350-351`），退避 0.5 / 1 / 2 / 4 / 8 s（实测）。
- provider 层：`maxProviderErrorRetries: 1`（`packages/ai/src/providers/openai-completions.ts:1461`），4xx（408、429 除外）不重放（`packages/ai/src/error/retryable.ts:55`）。两层合起来：一次 502 = 12 次请求 ≈ 31.6 s（实测）。
- 会话层：`retry.enabled`（默认 true）/ `retry.maxRetries`（默认 10）/ `retry.baseDelayMs`（500）/ `retry.maxDelayMs`（300000）（`packages/coding-agent/src/config/settings-schema.ts:1781-1802`），无 CLI 参数与环境变量；配置层级 默认 < 全局 < 项目 < `PI_CONFIG_FILES` < `--config` < 运行期覆盖。宿主 overlay 已经经 `--config` 与 `PI_CONFIG_FILES` 传给每次 spawn（`server/src/sessions/omp/host-overlay.ts`）。`maxRetries: 2` 重跑 case 6：3 轮 36 次请求，98.9 s failed（实测）；`maxDelayMs` 对 5xx 无可见作用，它只约束上游要求的等待（case 5：`Provider requested 1800000ms wait, exceeds retry.maxDelayMs` 后放弃，实测）。
- 会话层是否重试由 `isRetryableError`（`packages/coding-agent/src/session/turn-recovery.ts:1142-1170`）决定：它对 **文本** 跑分类器，与状态码无关——`TIMEOUT_PATTERN`（`packages/ai/src/error/flags.ts:154`）与 `TRANSIENT_TRANSPORT_PATTERN`（`:158-159`，含 `timeout`、`timed out`、`terminated`、`\b(429|500|502|503|504)\b`、`upstream connect`、`server error`、`internal error`、`rate limit` 等）命中即为可重试；`AUTH_FAILURE_PATTERN`（`:160-161`）只置鉴权位、不可重试。已有正文输出（committed text）的回合不重试（`turn-recovery.ts:1167`）。
- 重试帧：每轮 `message_end{stopReason:"error"}` → `turn_end` → `auto_retry_start{attempt,maxAttempts,delayMs,errorMessage,errorId}` → 新的 `agent_start`……最后一轮之后 `auto_retry_end{success:false,attempt,finalError,retryErrors}` → `agent_end{isTerminal:true}`（实测 c06r）。轮与轮之间 omp 不发 `agent_end`（实测）。字段名是 `retryErrors`，omp 文档写的 `recoveredErrors` 不对（实测）。
- 退避睡眠中收到 `abort`：`session.abort()` → `abortRetry()`（`packages/coding-agent/src/session/agent-session.ts:7118`、`turn-recovery.ts:2388-2392`）→ 睡眠被取消，发 `auto_retry_end{success:false,finalError:"Retry cancelled"}`（`turn-recovery.ts:2264-2281`）。之后是否还有 `agent_end`：读代码未能确定，未实测。

**我们这一侧今天的归约（读代码推出）：** `applyFrame` 的 `default` 分支丢掉 `auto_retry_*`（`server/src/sessions/events.ts:127-128`）；`message_end` 只记首个结局（`:266-286`），只有 `agent_end` 才发终态（`:288-302`）。推论：**重试成功的回合今天会被判成失败**——第一轮的 `message_end error` 已被记住，后续成功轮次改变不了它。红灯实测没有覆盖「重试后成功」，这一点由组 3 的测试先红后绿证明。

**web 侧约束：** 消息 DTO（`web/src/lib/session-contract.ts:365`）与 `error` 事件负载（`web/src/features/chat/stream.ts:718-721`）都是严格键集解析，多一个键整体拒绝——快照被拒即页面打不开，已知事件负载非法即触发重新同步。命名事件没有监听就收不到，连接器只按游标单调过滤、不要求连续（`stream.ts:494-500`；chat-web「思考与文件变更事件严格解码」场景：未知类型忽略且不重新同步）——所以**服务端先发新事件名是安全的，改既有键集不是**。先例：s1g 的附件列先落库（`567b46ae`），web 解析器先宽后严（`a5aa4f22`，#1025）。

**体量约束：** `stream.ts` 757 行、`supervisor.ts` 784、`store.ts` 780、`session-contract.ts` 678、`fake-omp.mjs` 797、`fake-upstream.mjs` 585；`scripts/size-guard.sh` 上限 800。新逻辑一律进新模块。

**迁移号：** 本分支与全部远端分支上 `server/src/core/db/migrations/` 最大为 `042`，`043` 未被占用（2026-10-14 逐分支核对）。

## Goals / Non-Goals

**Goals:**

- 每一种上游失败都在有界时间内以 `failed` 结束：4xx 约 2–3 s（实测）；连接被拒 / 重置与 504、524 以外的 5xx 约 64 s（推算，封顶一轮）；慢失败不重试（owner 2026-10-14 起草后裁决）——10 s 建连期限到期约 10 s + omp 开销，上游自己答 504 / 524 在它应答后约 2 s、最迟 120 s 首字节期限 + omp 开销，不回响应头约 120 s + 冷启动（均为推算，任务 1.7 实测）。
- 失败的助手消息显示一句分类说明与状态码，可展开看去密钥、截断后的原文；刷新后相同。
- 重试中可见「上游出错，正在重试…」；重试成功的回合以 `done` 收尾。
- 每个以上游原因失败的回合恰有一行服务日志。
- 显示给用户、写进库与日志的文本里不出现上游密钥、bearer 令牌、上游地址的敏感部分（userinfo、路径、查询串、完整 base URL）与服务器文件路径（OMP 状态目录、沙箱根，D9）。

**Non-Goals:**

- 自动重试策略与多上游切换（owner 2026-10-06）。omp 的传输层与 provider 层重试次数是硬编码，不改 omp。
- `Retry-After` 透传（登记为残余，见 Risks）。
- 已经开始流式输出之后的停顿期限（owner 2026-10-14 只限等待响应头）。
- 重连后恢复重试提示（提示不进快照，见 D11）。
- 服务启动对账置为 `failed` 的历史回合补错误文本（这些行的三列为 NULL）。
- omp 在状态目录写 `http-400-requests/*.json` 转储的磁盘增长（范围外发现，只登记）。

## Decisions

### owner 的裁定（已定，不是选项）

**D1（2026-10-06，#909「期望」）** 上游拒绝请求时回合在有限时间内结束为失败；错误显示在助手消息上，输入框解锁，可重发或重新生成；呈现为一句分类后的中文说明（鉴权失败、模型不存在、额度不足、请求被拒、上游超时等）加状态码，另可展开查看上游原文（截断、去密钥、纯文本）；每次失败一行服务日志。自动重试策略与多上游切换在范围外。

**D2（2026-10-13）重试封顶一轮并显示。** 保留 omp 的会话级重试，宿主 overlay 写 `retry.maxRetries: 1`；omp 的重试帧映射给用户，显示「上游出错，正在重试…」。记录在案的数字：传输层 6 次（`openai-http.ts:33`）× provider 整轮重放 1 次（`openai-completions.ts:1461`）→ 一轮 ≈ 32 s / 12 次请求（实测）；默认 11 轮 402.7 s（实测）；`maxRetries: 2` 为 98.9 s（实测）；`maxRetries: 1` 预计最坏 ≈ 64 s / 24 次（**推算，实现须实测**，任务 3.2）。`maxDelayMs` 对 5xx 无关。

**D3（2026-10-13）错误落库。** 消息上加可空列：失败分类、状态码、净化后截断到 ≤ 2000 字符的上游原文；一个迁移；快照带上它们，刷新看到同一条错误。

**D4（2026-10-14）非法密钥拒绝启动。** `MODEL_UPSTREAM_API_KEY` 不是合法 HTTP 头取值时服务拒绝启动，信息点名该变量、绝不打印取值。用 Node 自己的校验（`http.validateHeaderValue("authorization", "Bearer " + key)`，即代理实际发送的头形状，`index.ts:348-352`），不手写字符集。

**D5（2026-10-14）120 秒首字节期限。** 代理等待上游响应头最多 120 s；到期回合以「上游超时」失败，且 omp **不得**重试它（回合约 2 分钟结束）。只限等待响应头，已开始的流不限。返回给 omp 的状态与形状由 design 选（D7）。

### 起草者的技术决定（owner 已裁决的部分见文末「Owner 裁决」）

**D6 代理把失败摘要放进 omp 会保留的四个字段。** omp 只从错误信封里取 `error.message`、`error.type`、`error.param`、`error.code` 四个字符串（`classes.ts:47-69`、`http-inspector.ts:144-170`，读代码推出），其余字段丢弃。代理在五种情况下自己生成错误信封，分可重试（502）与不可重试（424，D7）两组：

| 情况 | 回给 omp 的状态 | `error.message`（人读，一行） | `error.type` | `error.param` |
|---|---|---|---|---|
| 上游 ≥500，504 与 524 除外 | 502 | `模型服务返回 HTTP <s>：<节选>`（节选为空时去掉冒号及其后） | `wb_upstream` | `status.<s>` |
| 连接被拒 / 重置 / DNS 失败等传输错误，或发请求时同步抛错 | 502 | `无法连接模型服务（<原因码>）` | `wb_upstream` | `connect.<原因码>` |
| 上游答 504 或 524（网关超时） | 424 | `模型服务的网关等待模型超时`（不带节选） | `wb_upstream` | `gateway_504` / `gateway_524` |
| 10 s 建连期限（`CONNECT_DEADLINE_MS`）到期 | 424 | `模型服务在 10 秒内没有建立连接` | `wb_upstream` | `no_connect` |
| 120 s 内没有响应头 | 424 | `模型服务在 120 秒内没有返回响应` | `wb_upstream` | `no_response` |

`<原因码>` 取 Node 错误的 `code`（`ECONNREFUSED`、`ECONNRESET`、`ENOTFOUND`、`ERR_INVALID_CHAR`……），只保留 `[A-Z0-9_]`，取不到时为 `UNKNOWN`。建连期限到期不再走 `connect.*`（owner 2026-10-14 起草后裁决：慢失败不重试）。`<节选>` 见 D8。不带 `code` 字段（omp 把单独的 `code` 误标成 `type=`，`http-inspector.ts:160-166`，读代码推出）。

不可重试三种的记号名是被 omp 的文本分类器逼出来的（读代码推出）：`TRANSIENT_TRANSPORT_PATTERN`（`flags.ts:158-159`）里的 `timeout`、`timed out` 没有词界，`connect_timeout` 这类名字会命中；`\b504\b` 在 `status.504` 上命中（`.` 是词界），而 `gateway_504` 里 `_` 与 `5` 都是词字符、不构成词界。所以不用 review 提议的 `connect_timeout` / `status.504`，而用 `no_connect` 与 `gateway_<s>`；三句人读文本也不含英文 `timeout` 与独立的 `429|500|502|503|504`。504 / 524 **不带节选**是强制的：网关超时页几乎总含 `Gateway Timeout` / `timed out`，节选一进信封 omp 就会在会话层重试它——这两种失败的「可展开原文」因此只是固定句子（登记于 Risks）。

于是 omp 的 `errorMessage` 末尾恰是 `(type=wb_upstream param=<种类>)`。服务端只认**锚定在整段文本末尾**、且 **`errorStatus` 等于代理为该种类发出的状态**的记号（正则 `\(type=wb_upstream param=(status\.[1-5][0-9]{2}|connect\.[A-Z0-9_]{1,64}|gateway_(?:504|524)|no_connect|no_response)\)$`；`status.*`、`connect.*` 要求 `errorStatus` 为 502，`gateway_*`、`no_connect`、`no_response` 要求 424）。两道条件各挡一种伪造：上游正文里伪造的同样字样出现在节选里，不在末尾；`< 500` 的上游应答原样透传，omp 对**任何状态**都把上游 JSON 的 `error.type` / `error.param` 拼到末尾（`http-inspector.ts:144-170`），所以一个 401 正文 `{"error":{"message":"x","type":"wb_upstream","param":"status.500"}}` 也会以记号结尾——它的 `errorStatus` 是 401，不是 502，记号不被采信，仍归 `auth_failed`。记号缺失、不合形或状态不符时按普通 `errorStatus` 分类（D10），不报错。

放弃的方案：(a) 把 JSON 塞进 `message`——组 1 合入、组 3 未合入期间用户会直接看到一串 JSON，且转义后长度难控；(b) 自定义响应头——omp 不把响应头放进 `errorMessage`；(c) 代理经令牌查到会话、旁路通知 sessions——代理不得导入 sessions（model-proxy「透传端点与 bearer 鉴权」），要新增一条跨模块通道。选这个方案后，组 1 单独合入时用户看到的是一行可读中文（加 omp 自带的 `(type=… param=…)` 尾巴）。

**D7 慢失败回 424，文本避开 omp 的分类器。** 首字节期限、建连期限与上游 504 / 524 三种（D6 下半表）共用这一机制。需要同时满足：传输层不重试（非 408/429/≥500，`fetch-retry.ts:350-351`）；provider 层不重放（4xx 非 408/429，`retryable.ts:55`）；会话层不重试——这一层看**文本**（Context），所以信封里不得出现 `timeout`、`timed out`、`terminated`、`429|500|502|503|504` 这类独立数字、`upstream connect`、`server error`、`unauthorized`、`forbidden`、`quota` 等；此外不能是 400 / 413（触发 omp 的请求转储与 `raw-http-request=` 路径行，`http-inspector.ts:49`）、401 / 403（鉴权位）、402（额度位，可重试，`flags.ts:482`）。`retriable(id)` 对未分类的裸状态码做位与（`flags.ts:332-338`）：`RETRIABLE_KINDS` 的最低位是 `EmptyResponse = 0x2000`（`flags.ts:19-45`、`:70-76`），任何 HTTP 状态码都小于 0x2000，所以裸状态码本身永远不可重试——实测里 400 / 404 不重试与此一致（读代码推出）。424（Failed Dependency：本请求依赖的另一个请求失败）满足全部条件，语义也贴切。D6 的三个 424 信封逐字为 `{"error":{"message":"模型服务在 120 秒内没有返回响应","type":"wb_upstream","param":"no_response"}}`、`{"error":{"message":"模型服务在 10 秒内没有建立连接","type":"wb_upstream","param":"no_connect"}}`、`{"error":{"message":"模型服务的网关等待模型超时","type":"wb_upstream","param":"gateway_<504|524>"}}`，已逐条对照上述正则（读代码推出）。此外 overlay 必须关掉 omp 的模型兜底（D12）：`isHardErrorFallbackEligible` 对不可重试的硬错误也会查 `retry.fallbackChains`（`turn-recovery.ts:1816`），项目层一条链就能让 424 换模型重放。**实现须用真实 omp 经代理实测**：每种 424 → 上游请求数不超过 1（建连卡住时为 0）、无 `auto_retry_start`、回合失败（任务 1.7(b)(d)(e)）。

首字节期限从代理发出上游请求起算，到收到响应头为止；收到响应头之后不再计时。10 s 建连期限与它并存，传输建立即结束；到期回 424 `no_connect`（不再是可重试的 502）。连接被拒、重置等**快**失败仍是 502 `connect.*`、可重试。上游 504 / 524 若在首字节期限之后才到，代理早已回了 `no_response`——期限先到者胜。代理不读环境：两个期限都是 `registerModelProxy` 的选项，`firstByteDeadlineMs` 缺省 120000、`connectDeadlineMs` 缺省 10000（即今天的 `CONNECT_DEADLINE_MS`），生产装配都不传；只有测试夹具传更短的值（D17），所以单测不必真等 10 s。

**D8 ≥500 时读取上游正文的上限。** 只对 502 那一行（504、524 以外的 ≥500）读正文；504 / 524 不读，直接释放。代理最多读上游错误正文的前 16 KiB，且自收到响应头起最多等 5 s，先到者为准，然后销毁上游响应；`content-encoding` 不是空或 `identity` 时不读（节选为空）。字节按 UTF-8 解码（非法序列替换为 U+FFFD），经 D9 的净化器后把换行与制表符折成单个空格、截到**至多 1000 码点**（超出时保留前 994 个码点并接 `…（已截断）`）。omp 只把 `errorMessage` 首行 `<状态> <detail>` 里的 detail 截到 4096 个 UTF-16 单位（`openai-http.ts:36`、`:146`），其后由 `http-inspector.ts` 拼上的 `<message> (type=… param=…)` 不截；1000 码点的节选加前缀最坏约 2100 个单位，首行不会被截，末尾记号也不受影响（读代码推出）。

节选会进入 omp 的文本分类器（`isRetryableError` 与额度、上下文溢出、内容过滤等模式，`flags.ts`）：上游 5xx 正文若含这类字样，omp 可能不重试、或先做一次压缩再重试，所以「502 照常重试一轮」不保证；但会话层封顶一轮（D12）与 omp 的硬编码传输层次数不变，时长上界不变（读代码推出）。文档（任务 1.9）写明这一句。

**D9 净化器是 `core/` 里的纯函数，密钥经装配方闭包传入。** `server/src/core/upstream-failure.ts` 导出 `sanitizeUpstreamText(text, secrets)`（`core/refused-characters.ts` 是「core 里放 model-proxy 与 sessions 共用纯函数」的先例），按序：

1. CRLF 与单独 CR 归一为 LF，U+2028 / U+2029 归一为 LF；删除 U+0000–U+0008、U+000B–U+001F、U+007F；
2. 按行切分，删掉以 `raw-http-request=` 或 `raw-http-request-save-failed=` 开头的行（omp 的转储尾巴，`http-inspector.ts:70`、`:73`）；
3. `secrets` 里每个非空串（先按第 1 步同样归一）的每次逐字出现替换为 `[已移除]`，长的先替换（不论长短——测试密钥 `fake` 会把正文里的 `fake` 也替换掉，测试要按此写期望）；
4. `Bearer <非空白串>`（不分大小写）替换为 `Bearer [已移除]`；形如 `sk-` 后接至少 16 个 `[A-Za-z0-9_-]` 的串替换为 `[已移除]`；
5. 去掉末尾空白；
6. 截到 2000 码点：超出时保留前 1994 个码点并接 `…（已截断）`（6 个码点，与 `events.ts:56` 的 `TRUNCATED_MARK` 同一常量），结果恒 ≤ 2000 码点、不拆代理对。

先删控制字符再去密钥：被 `\x00` 劈开的密钥（`k-\x00123`）若先替换后删字符，会躲过替换、随后被拼回原样。先去密钥后截断：密钥不会因被截成半截而漏网。

**密钥集。** `core/upstream-failure.ts` 另导出纯函数 `upstreamSecretList({apiKey, baseUrl, paths})`，产出：`apiKey`；配置的 base URL 原串；其 userinfo 原串（`//` 与 `@` 之间）与其中的密码段；其 pathname（不为空、不为 `/` 时）整串，以及其中长度 ≥ 8 的每个路径段（`v1`、`api` 这类短段不单列，否则会把普通错误文本切碎）；其查询串（去掉 `?`，非空时）；以及 `paths` 里的每个绝对路径。主机名不在其内（它是供应商，不是密钥）。`createApp` 用装配里已有的 `upstream.{baseUrl, apiKey}`（`server/src/app.ts:92`、`:214`）与 `runtime.stateDir`、`runtime.sandboxRoot`（`:204-205`）及二者的 `realpathSync` 结果（与原值不同才加入；取不到时跳过）构造这张表一次，闭包 `redactUpstream(text) => sanitizeUpstreamText(text, list)` 交给 sessions 装配（未配置上游时只有两组路径），不新增装配字段。代理只认识自己的 `upstream`，节选用 `upstreamSecretList({apiKey, baseUrl, paths: []})`；节选随 `errorMessage` 到 sessions 后会再经完整的表净化一次（幂等：`[已移除]` 与截断标记不含任何密钥）。`agent_failed` 的 `detail`（prompt 失败应答与 `applyFailure` 的运行时文本）同样只经这个闭包，不另开路径。sessions 拿不到密钥本身。放弃的方案：代理缓冲并改写 4xx 正文——会改变「非 5xx 原样流式透传」，omp 依赖原始正文判断额度、上下文溢出等。（**实施补入**：`paths` 由 sessions 侧每次净化时构造，每个目录四种写法——配置原值、`normalize()`、去尾 `/`、`realpathSync.native`；见 upstream-failure「上游原文净化」。）

**D10 分类表。** 纯函数 `classifyTurnFailure`（`server/src/sessions/upstream-classify.ts`）输入：来源（`message_end` 或运行时）、`errorStatus`（可缺）、`errorMessage`；输出 `{reason, status, detail}`，`detail` 尚未净化。规则按序匹配：

| # | 条件 | `reason` | `status` | 固定句子 |
|---|---|---|---|---|
| 1 | 来源是 prompt 失败应答或 `applyFailure`（进程异常退出等） | `agent_failed` | null | Agent 运行失败 |
| 2 | `errorStatus` 502 且末尾记号 `status.<s>` | `upstream_error` | `<s>` | 上游出错：模型服务内部错误 |
| 3 | `errorStatus` 502 且末尾记号 `connect.<c>`；或 `errorStatus` 424 且末尾记号 `no_connect` | `upstream_unreachable` | null | 上游不可达：无法连接模型服务 |
| 4 | `errorStatus` 424 且末尾记号 `no_response`；或 `errorStatus` 424 且末尾记号 `gateway_<s>` | `upstream_timeout` | `no_response` 为 null，`gateway_<s>` 为 `<s>` | 上游超时：模型服务没有及时响应 |
| 5 | `errorStatus` 为 401 或 403 | `auth_failed` | 该值 | 鉴权失败：模型服务拒绝了配置的 API 密钥 |
| 6 | 404 且文本含 `model`（不分大小写） | `model_not_found` | 404 | 模型不存在：模型服务找不到所请求的模型 |
| 7 | 402；或 429 且文本匹配 `/quota\|insufficient\|billing\|余额\|额度/i` | `quota_exhausted` | 该值 | 额度不足：模型服务账户的额度已用完 |
| 8 | 其余 429 | `rate_limited` | 429 | 请求过于频繁：模型服务暂时限流 |
| 9 | 408 | `upstream_timeout` | 408 | （同 #4） |
| 10 | 其余 400–499（含 404 而文本不含 `model`、400 空正文） | `request_rejected` | 该值 | 请求被拒：模型服务拒绝了这次请求 |
| 11 | `errorStatus` ≥ 500 而无记号（只可能是代理自己的 502，如未配置上游） | `upstream_error` | 该值 | （同 #2） |
| 12 | 其余（无状态码、无记号；case 10 断流即此类） | `model_call_failed` | null | 模型调用失败 |

`detail`：#2–#4 取 `errorMessage` 首行，先去掉可选的 `Retry budget exhausted after <n> retry|retries: ` 前缀（omp 在重试预算用尽时会把它写到 `message.errorMessage` 开头，`turn-recovery.ts:2145`；它是否到达宿主看到的 `message_end` 读代码未能确定，任务 3.2 记录实测形状），再去掉开头的 `<三位数状态> `，余下即 D6 的人读行（含节选）；其余取整段 `errorMessage`（#1 为运行时给的文本）。只有可重试的 `status.*`、`connect.*` 会经过重试预算；424 三种不进重试，不会带这个前缀。句子是服务端唯一的一张表；用户看到的状态码显示为 `（HTTP <s>）`，`status` 为 null 时不显示。

逐用例的落点（实测用例 → 规则）：1 → #10（400，`raw-http-request=` 行被删）；2 / 3 → #5；4 → #6；5 → #7；6 / 7 → #2；8 → #3；9 → #4；10 → #12（已到的正文保留）；11a / 11b → 启动即失败（D16），代理里的同步抛错分支在生产里不可达，保留它（归 `connect.ERR_INVALID_CHAR`）是因为删掉它会让该路径重新变成未分类的 502；12 → #10。裁决后新增的两种（未实测，任务 1.7）：建连卡住 → #3（`no_connect`）；上游 504 / 524 → #4（status 504 / 524）。伪造：上游 401 正文自带 `type=wb_upstream param=status.500` → 记号因状态不符不被采信 → #5。**普通限流 429（非额度）未实测**：读代码推出它在传输层与 provider 层都可重试、会话层文本含 `429` 也可重试，在封顶一轮下约 64 s / 24 次后以 #8 失败。

**D11 重试帧的归约。** 归约器（chat-stream「纯协议事件归约」）新增：

- `auto_retry_start`（状态未终态、已 started 时）→ 发 `turn.retry{messageId}`，并把状态标为「重试中」；不清掉已记住的失败。
- 「重试中」之后到达的第一个 assistant `message_end`：`error` → 用它**替换**已记住的失败；`aborted` → 替换为「已中断」；其余 stopReason（这一轮成功）→ 清掉已记住的结局。然后退出「重试中」。没有发生过重试时，「首个记住的结局为准」不变。
- `auto_retry_end{success:false, finalError:"Retry cancelled"}` → 把已记住的结局替换为「已中断」（`turn-recovery.ts:2264-2281`，读代码推出）。其余 `auto_retry_end` 不改状态、不发事件。
- `turn.retry` 经 supervisor 发布、占环形缓冲的序号（与 `turn.start` 一样不落库）；同一 epoch 内带 `Last-Event-ID` 的重连会回放它，经完整快照恢复的连接看不到它（快照里没有「重试中」）。

重试退避中用户按停止：`abort` 帧 → omp 取消睡眠并发 `Retry cancelled` → 回合以 `stopped` 收尾；若 omp 之后不发 `agent_end`，既有的 `OMP_ABORT_GRACE_MS = 8000` 有界退回照样以 `stopped` 收尾。两条路径都在 8 s 内结束，**必须用真实 omp 测停止路由**（只观察过关停时的 abort，任务 4.4(b)）。

前端：`turn.retry` 把该助手消息的「重试中」置真；该消息随后的 `turn.start`、`text.delta`、`thinking.delta`、`step.start`、`error`、`turn.end` 任一到达即置假。第一轮失败前（约 32 s，传输层与 provider 层在 omp 内部重试，不发帧）提示不会出现，这是 omp 帧粒度决定的。

**失败那一轮已经流出的内容不清。** 已有正文输出的回合 omp 不重试（`turn-recovery.ts:1167`），所以能进入重试的那一轮最多只流出过 thinking。决定：`turn.retry` 不重置任何东西——服务端不清已累积 / 已落库的 `thinking`，归约器不为它发 `turn.start`，web 也不清视图里的 `thinking` 与正文。代价：重试成功的回合，「深度思考过程」里可能是第一轮的 thinking 接着第二轮的 thinking（登记为已知残余，见 Risks）。放弃的方案：`turn.retry` 时清 thinking——要改 thinking 的落库次序与快照语义（thinking-fold），换来的只是少一段失败轮次的思考。

**D12 overlay 的 `retry:` 段钉住五个键。** 追加在 `images:` 段之后：

```yaml
retry:
  enabled: true
  maxRetries: 1
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: false
```

`maxRetries: 1` 是 owner 定的；`enabled`、`baseDelayMs`、`maxDelayMs` 取 omp 默认值，写出来是为了让会话 cwd 下的项目层配置改不动它们（overlay 高于项目层）。（**实施更正，#909 PR 2 实测**：原文写「否则一个项目文件把 `baseDelayMs` 改成一小时，5xx 回合就挂一小时」不成立——omp v18.0.10 的退避等待最长 8 s（`retry-fallback-chains.ts:69-77`）；去掉 overlay 的 `baseDelayMs`、项目层写 3600000 时实测只等了 7841 ms，回合 74 s 照常失败。钉住这几个键的理由仍成立：退避变长（最多到 8 s）与重试轮数都由 overlay 决定，项目层改不动。）

只钉这三项还不够：`retry.modelFallback` 缺省为 `true`（`settings-schema.ts:1813`），项目层写一条 `retry.fallbackChains` 就能在重试预算用尽时换到链上的模型，并把重试预算重置（`turn-recovery.ts:2163` 的 `if (switchedModel) this.#retryAttempt = 1`），对不可重试的硬错误也会查链（`isHardErrorFallbackEligible`，`:1816`）——5xx 回合时长随链长翻倍，424 也被重放。`modelFallback: false` 让这三处都短路（`:1518`、`:1816`、`:2117`，读代码推出），与 owner「多上游切换不在范围内」一致：本 change **关闭了 omp 的模型兜底**，实现 PR 的描述必须写明这一点。放弃的方案：只写 `maxRetries`——更短，但重试时长又回到项目层手里。

**D13 落库：三列在 `error` 事件发布前写入。** 迁移 `043_chat_message_error.sql` 只用 `ALTER TABLE … ADD COLUMN` 给 `chat_messages` 加 `error_reason TEXT NULL`、`error_status INTEGER NULL`、`error_detail TEXT NULL`，无缺省、无 CHECK、无回填（`042` 的先例）。`persistEvent` 的 `error` 分支先以一条 UPDATE 写三列（`detail` 已净化），再返回事件供发布；随后的 `turn.end failed` 照旧由 `finishTurn` 结算。中间崩溃时该行是「running + 三列有值」，启动对账把它置为 `failed`，三列保留。放弃的方案：把三列并入 `finishTurn` 的终态事务——那样 `error` 事件会先于它的落库被发布（归约器总是先发 `error` 再发 `turn.end`），要改 `persistEvent` 的一进一出形状。fork 拷贝助手行时三列随行拷贝（与 `status` 同理）；regenerate 删除旧助手行时三列随行消失。

**D14 公开形状。** 快照每条消息多一个键 `error`：user 消息恒为 `null`；assistant 消息在三列都为 NULL 时为 `null`，否则为 `{reason, message, status, detail}`——`message` 是 D10 的句子（序列化时由 `reason` 查表，不落库），`status` 为整数或 `null`，`detail` 为字符串（可为空串）。`reason` 不在表内的行（只可能来自手工改库）读作 `error: null`。`error` 事件负载为 `{messageId, message, reason, status, detail}`，各字段与快照同义。`turn.retry` 负载为 `{messageId}`。

**D15 日志：每个失败回合一行。** supervisor 在发布 `reason ≠ agent_failed` 的 `error` 事件时，经 sessions 的 `log` 端口写一行 `{"event":"upstream_failed","sessionId":"<id>","reason":"<reason>","status":<整数或 null>}`（键集恰此四个；不含密钥、正文、路径）。放弃的方案：代理按请求记——一次 5xx 回合会写 24 行（推算），且 `TokenLookup` 之外代理不知道回合。代价：重试后成功的回合不留日志（登记为残余）。

**D16 启动校验的落点与输出。** 在 `resolveAgentSettings` 里 `optionalSetting(env.MODEL_UPSTREAM_API_KEY, …)`（`server/src/agent-config.ts:81`）之后调用 `http.validateHeaderValue("authorization", \`Bearer ${key}\`)`；它抛错时改抛 `Error("MODEL_UPSTREAM_API_KEY must be a valid HTTP header value")`（不带取值；Node 的 `ERR_INVALID_CHAR` 信息本身也不含取值，但不透传它）。入口照既有合同输出恰一行 `{"event":"server_start_failed","reason":"config"}`（http-service-skeleton「服务启动与装配」，`server/src/server.ts:364-373`）——**变量名不出现在 stderr**，只在抛出的错误信息里，与 `MODEL_ID`（#1261）的先例相同。owner 说的「清楚的信息点名该变量」与这条既有合同冲突，owner 已裁决沿用既有合同（见文末「Owner 裁决」）。

**D17 测试分层与 CI。**

| 层 | 位置 | 内容 | CI |
|---|---|---|---|
| 纯函数 | `server/test/upstream-failure-*.test.ts` | 净化器（含密钥集）、记号编解码、D10 每一行 | `make test` |
| 代理 | `server/test/model-proxy-*.test.ts` | 假上游各开关 → 代理的状态与信封；`firstByteDeadlineMs`、`connectDeadlineMs` 注入短值 + 断言缺省为 120000 / 10000 且生产装配不传；建连卡住用本地「接受 TCP 但永不说话」的监听，以 `https://127.0.0.1:<port>` 寻址（TLS 握手停住，属「DNS/TCP/TLS 未建立」）——不用黑洞 IP，那在不同网络下可能很快回 ICMP 不可达（`EHOSTUNREACH`，走可重试路径） | `make test` |
| 归约器 | `server/test/session-events-*.test.ts` | 注入帧：重试替换、`Retry cancelled`、`turn.retry` | `make test` |
| supervisor / store / REST | 既有 supervisor 测试的桩运行时注入帧 | 三列落库、发布次序、日志行、快照 `error`、fork 拷贝 | `make test` |
| 启动 | `server-config.test.ts`、`server-startup-failure-reason.test.ts` | 编译入口 + 非法密钥哨兵 | `make test` |
| 真实 omp 经代理 | 新 `server/test/omp-official-upstream-failure.test.ts` + 新夹具（`models.yml` 指向一个用 `registerModelProxy` 装起来的本地代理，代理再指向假上游） | 401 单次请求 ≈ 2 s；5xx 两轮（实测记入 PR，后续组在同一运行上追加 SSE / 日志 / 库断言）；项目层（含 `fallbackChains`）改不动重试；首字节期限注入 3000 ms → 1 次请求、无 `auto_retry_start`；建连期限注入 1000 ms 指向不说话的监听 → 0 次上游请求、无 `auto_retry_start`；上游延迟 2 s 后答 504 → 1 次请求、无 `auto_retry_start`；前 12 次 503 后成功 → `done`；重试退避中停止 → `stopped` ≤ 8 s；400 空正文落库不含路径 | `WORKBUDDY_OMP_TEST=1`，CI 经 `.github/scripts/ci-uid-isolation.sh` 清单（与 `scripts/test-ci-harness.sh` 的断言同步改，omp-uid-isolation「CI uid-isolation job」已允许） |
| web | `web/test/` | 解析、归约、错误块渲染、重试提示 | `make test` |
| 冒烟 | `smoke/chat.hurl` | 一条 `401 + WORKBUDDY_FAKE_BODY=secret` 的回合（正文含配置的密钥）→ 快照 `error.reason` 为 `auth_failed`、`detail` 不含密钥，再发普通 prompt 正常完成 | `make smoke`（smoke 与 uid-isolation 两个 job） |
| 走查 | `make ui-walk` 一步 | 同一标记 → 错误块、展开原文且不含密钥、输入框解锁、重发成功 | `make ui-walk` |

永远不打真实模型端点；真实 omp 只用官方 v18.0.10（`make omp-fetch`）。120 s 期限本身只在单元层用注入值测，不在任何 CI 层真等 120 s。

**D18 切片。** （owner 2026-10-14 裁决：八个组合成五个 PR——组 1｜组 2 + 3｜组 4 + 5｜组 6 + 7｜组 8，依次合入；组的划分与次序不变。）八个组，次序固定，每个 PR 合入后主干可运行、`make check` 全绿。切法的判据是「最小可独立合并且保绿的子集」：能单独合入的就单独成组，只有拆开会让一侧拒收另一侧、或证据只能同刀产生时才合在一起。

| 组 | 内容 | 合入后用户可见的变化 |
|---|---|---|
| 1 | 假上游开关、`core/upstream-failure.ts`（净化器、密钥集、信封）、代理摘要与三种 424、经代理的官方 omp 夹具 | 不回响应的上游约 2 分钟失败；建连卡住约 10 s、上游 504 / 524 一次即失败；5xx 的错误文本变成可读中文（仍是 omp 原文形状） |
| 2 | 启动密钥校验 | 非法密钥起不来 |
| 3 | overlay `retry:` 段 | 5xx / 连接被拒约 64 s 失败（推算）；项目层改不动重试、不能换模型 |
| 4 | 重试归约（替换规则、`Retry cancelled`）与 `turn.retry` 的发布 | 重试成功不再误判失败；退避中停止以 `stopped` 收尾 |
| 5 | 失败分类、句子投影、`upstream_failed` 日志 | 错误文本变成「句子（HTTP s）」；服务日志有行 |
| 6 | 迁移 043、净化、落库、fork 拷贝 | 无（三列已写，快照尚不暴露） |
| 7 | 快照 `error`、`error` 事件新键、web 解析 / 归约 / 渲染、重试提示、验收清单行 | 句子、状态码、可展开原文；刷新不丢；重试提示 |
| 8 | `smoke/chat.hurl` 一例、`make ui-walk` 一步 | 无（集成证据） |

组 5、组 6 期间 `error` 事件的线上形状保持 `{messageId, message}`，`message` 为「句子（HTTP s）」的投影，现行前端照常解析；组 4 起发布的 `turn.retry` 现行前端没有监听，收不到也不重新同步（Context「web 侧约束」）。组 7 把快照与 `error` 事件的新键与 web 的严格解析放进**同一个 PR**：任一侧先合都会让另一侧拒收（快照被拒 = 页面打不开）——这是本 change 唯一的 Width 例外。放弃的方案：照 #1025 先例分三步（web 先宽、服务端加键、web 再严）——多两个 PR，换来的只是每个 PR 少几十行。组 2 与其它组没有代码依赖；组 8 的冒烟与走查同在第五个 PR（owner 已定五个 PR，不再拆）。

**D19 web 呈现。** 错误块位于助手消息既有的「错误文本」位置（chat-web「消息线程」的块次序不变），内容：第一行 `<message>`，`status` 非 null 时其后接 `（HTTP <status>）`；`detail` 非空时下面一个 `查看原文` 按钮（`aria-expanded`，默认收起），展开后以纯文本显示 `detail`（保留换行与空白、自动折行、超出一定高度滚动），绝不按 Markdown 或 HTML 渲染。重试提示也在这个位置：消息 `running` 且「重试中」时显示一行 `role="status"` 的 `上游出错，正在重试…`。输入框解锁与重新生成不需要新代码：回合以 `turn.end failed` 结束时既有逻辑已解锁（`web/src/features/chat/composer-locks.ts`），`重新生成` 已对 `failed` 可见（`message-thread.tsx:67`）。

## Risks / Trade-offs

- **[omp 升级改了 `errorMessage` 的拼装]** → 记号解析失败时退回按 `errorStatus` 分类（D10 #11），回合照样有界失败、照样有文本；官方 omp 用例钉住 v18.0.10 的形状。overlay 与 424 的取值同样随 omp 升级重验（omp-runtime「宿主 overlay」既有纪律）。
- **[424 的文本日后被 omp 的分类器认作可重试]** → 三种慢失败退化为一轮重试（`no_response` ≈ 4 min 而不是 ≈ 2 min，封顶一轮兜住）；官方用例断言「上游请求数不超过 1、无 `auto_retry_start`」会先红。
- **[上游自己答 424 并伪造记号]** → `< 500` 原样透传，一个答 424、正文为 `{"error":{…,"type":"wb_upstream","param":"no_response"}}` 的上游与代理自己的 424 无从区分，会被归为 `upstream_timeout`。已接受残余：只影响那个上游自己的失败如何被描述，回合照样有界失败；堵它要改写 4xx 正文，D9 已放弃该方案。不带记号的 424 落到 D10 #10。
- **[504 / 524 看不到上游原文]** → 不可重试信封不能带节选（D6），这两种失败的「查看原文」只显示固定句子；D1 的「可展开看原文」在这两种上降级（已接受，owner 裁决「慢失败不重试」的直接后果）。
- **[净化器漏掉某种密钥形状]** → 配置的密钥、base URL 各部分与两组服务器路径的逐字替换是确定的；`Bearer` 与 `sk-` 是启发式补充；base URL 里短于 8 个字符的路径段不单独替换（只随整段路径一起替换）。上游回显的是**别的**密钥（例如部分打码的）时不保证移除。
- **[重试提示在重连后丢失]** → 经完整快照恢复的连接显示普通「生成中」直到回合结束（已接受残余，见「Owner 裁决」）。
- **[重试成功后 thinking 带着失败那一轮]** → 已知残余（D11）：「深度思考过程」可能是两轮 thinking 首尾相接；正文不受影响（有正文的回合不重试）。
- **[omp 的模型兜底被关掉]** → overlay `retry.modelFallback: false`（D12）；与「多上游切换不在范围内」一致，实现 PR 写明。
- **[`Retry-After` 不透传]** → 上游限流时 omp 只按自己的退避重试；登记为残余，不在本 change 修。
- **[已开始的流停住]** → 本 change 不设期限；omp 的流空闲看门狗缺省 300 s（`packages/ai/src/utils/idle-iterator.ts:4`，读代码推出，未实测）。
- **[启动对账的历史失败行没有错误]** → 显示为没有错误块的失败消息，与今天相同。
- **[组 1 到组 6 之间的过渡]** → 组 1–4 期间用户看到的是 omp 原文形状的可读中文加 `(type=wb_upstream param=…)` 尾巴；组 5–6 期间是「句子（HTTP s）」但没有原文；400 的 `raw-http-request=` 路径行在组 5 起不再显示（投影里没有原文）。各组连续合入，不发布中间版本。
- **[文件体量]** → 新逻辑放新模块；`size-guard` 是硬门槛。
- **[CI 时长]** → 官方 omp 层跑在 `uid-isolation` job（`timeout-minutes: 15`，同 job 还跑 `make smoke`）；每次「503 直到失败」约 64 s（推算）。全 change 只保留两次这样的运行，后续组在其上追加断言（tasks 通用纪律）；连接失败只在代理单测层覆盖。
- **[`/v1` 的错误信封与 `/api/*` 不同]** → http-service-skeleton「统一错误信封」只约束 `/api/*`；代理新生成的 `{error:{message,type,param}}` 不带 `code`，是为了让 omp 的 `(type=… param=…)` 尾巴恰为两项、末尾锚定可靠（D6）。代理自己的 401 `unauthorized` 与 400 `bad_request` 仍是统一信封，不变。

## Migration Plan

五个 PR（组 1｜组 2 + 3｜组 4 + 5｜组 6 + 7｜组 8）依次合入。数据迁移只有 `043`（三列 `ADD COLUMN`，可空，旧行读作 NULL，不回填）；回滚 = 不再读写这三列（与 `042` 相同）。线协议的两处键集变化在组 7 内由服务端与 web 同刀完成。每个组都可以单独 `git revert`，前提是它之后的组未合入或一并回滚。部署无新环境变量；已在用的 `MODEL_UPSTREAM_API_KEY` 若含非法字符，升级后服务将拒绝启动——这正是 D4 的目的，发布说明里写明。

## Open Questions

无。起草时列出的三项（启动失败信息的位置、日志粒度、分类与句子）已由 owner 裁决，见文末「Owner 裁决」。

## Not yet specified

- **普通限流 429（非额度）的时长**未实测（D10 末段为读代码推出）；组 3 的实测只覆盖 5xx（官方层）与连接被拒（一次性脚本）。
- **退避中停止之后 omp 是否发 `agent_end`** 未实测（D11）；两种结果规格都已覆盖，任务 4.4(b) 记录实测到的是哪一种。
- **`maxRetries: 1` 的真实时长**是推算（≈ 64 s / 24 次）；任务 3.2 实测后写进 PR 与 ADR-0012 增补。
- **三种 424 的真实时长与请求数**是推算（建连卡住 ≈ 10 s / 0 次，504 / 524 ≈ 上游应答时刻 + 2 s / 1 次）；任务 1.7(d)(e) 实测。
- **`Retry budget exhausted after …: ` 前缀是否到达宿主的 `message_end`**读代码未能确定（D10）；分类对两种形状都成立，任务 3.2 记录最终 `message_end.errorMessage` 的逐字形状。

## Sketch seams under test

- **`sanitizeUpstreamText` / 记号编解码 / `classifyTurnFailure`**：纯函数，注入样本逐条测。D10 的每一行恰一条用例，D9 的每一步恰一条用例。
- **`registerModelProxy` + 假上游**：既有的代理测试 seam；新增开关只经 prompt 文本里的标记驱动（与 `WORKBUDDY_FAKE_ERROR` 同一机制），CLI 与进程内两种用法同时可用。
- **`applyFrame`**：注入帧序列，断言事件与状态（既有 seam）。
- **supervisor + 桩运行时**：既有 seam，断言落库在发布之前、日志行、事件次序。
- **经代理的官方 omp 世界（新）**：唯一能证明「omp 对 424 不重试」「封顶一轮」「重试后成功」「退避中停止」的层；`openOfficialWorld` 绕过代理，不能复用。
- **`make smoke` / `make ui-walk`（既有）**：编译后的服务与真实浏览器；各加一例，不新增 target。

## Traceability

| 来源 | 落点 |
|---|---|
| D1 有界失败、显示、解锁、日志 | D6–D10、D13–D15、D19；upstream-failure 全部要求；tasks 组 1、5、6、7 |
| D2 重试封顶与提示 | D11、D12；omp-runtime「宿主 overlay」；chat-stream、turn-control 的 MODIFIED；upstream-failure「重试提示事件」；tasks 组 3、组 4、7.3–7.5 |
| D3 落库与快照 | D13、D14；upstream-failure「迁移 043 消息错误列」「失败的公开形状」；chat-sessions「会话 REST」；tasks 组 6、7.1–7.2 |
| D4 非法密钥 | D16；http-service-skeleton「服务启动与装配」；tasks 组 2 |
| D5 120 秒首字节 | D6、D7；model-proxy「透传端点与 bearer 鉴权」；tasks 1.5、1.7(b) |
| 慢失败不重试（2026-10-14 起草后） | D6、D7、D10 #3 / #4；model-proxy「透传端点与 bearer 鉴权」；upstream-failure「回合失败分类」；tasks 1.3、1.4、1.5、1.7(d)(e)、1.10、7.6 |
| #909「上游地址敏感部分不泄露」 | D9 密钥集；upstream-failure「上游原文净化」；tasks 1.2、6.3、6.7、8.3 |
| 实测 case 1–12 | D10 的逐用例落点；tasks 1.7、3.2、4.4、5.5、6.5 |
| 400 路径泄漏 | D9 第 1 步；tasks 1.2、6.3、6.5 |

## Owner 裁决（2026-10-14，起草后）

- 十类失败分类与固定句子（D10 表）照起草定稿。
- 启动拒绝非法密钥沿用既有启动失败契约：stderr 只报 `{"event":"server_start_failed","reason":"config"}`，变量名只在抛出的 `Error.message` 里；「配置错误在 stderr 点名变量」不在本 change。
- 重试提示只随实时事件、不进快照：重试期间刷新或经全量快照重连的用户只看到普通「生成中」（最长约一轮，≈ 32 s，实测轮长），登记为已接受残余。
- 八个组合成五个 PR（见 D18）。
- 日志粒度（每个失败回合一行，重试后成功的不记）：编排方按起草默认取，owner 可推翻。
- （fixture review 之后）慢失败同样不重试：代理的 10 s 建连期限（`CONNECT_DEADLINE_MS`）到期时，用与 120 s 首字节期限相同的不可重试机制应答（424，记号 `no_connect`），归「上游不可达」；上游自己答 504 或 524（网关超时）时同样不可重试（424，记号 `gateway_504` / `gateway_524`），归「上游超时」并带该状态码。连接被拒 / 重置与其它 5xx 仍可重试（≈ 64 s，多一轮）。这几种回合因此在一次等待之内结束（≤ 120 s + omp 开销）。记号名的取法（不用 `connect_timeout` / `status.504`）见 D6。

