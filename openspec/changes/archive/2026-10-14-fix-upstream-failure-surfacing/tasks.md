# Tasks: fix-upstream-failure-surfacing

> 跟踪：直接在 #909 上实现，不拆子 issue。下面八个组按 owner 2026-10-14 的裁决合成**五个 PR**，依次合入：组 1｜组 2 + 组 3｜组 4 + 组 5｜组 6 + 组 7｜组 8（组内任务与验证不变，合并的两组在同一 PR 里各自给出证据）。下文「每组一个 PR」读作「每个 PR」。
>
> 依赖（「X ← Y」读作「X 的前提是 Y」）：组 3 ← 组 1（经代理的官方 omp 夹具与假上游开关）；组 4 ← 组 3（「重试后成功」「退避中停止」要靠封顶一轮才能在测试时间内跑完）；组 5 ← 组 4（同改 `events.ts` 的结局记录，先定重试语义再定失败负载）；组 6 ← 组 5（落库写的是分类结果）；组 7 ← 组 6（快照读的是落库的三列）；组 8 ← 组 7（冒烟与走查断言公开形状与界面）。组 2 与其它组没有代码依赖，可在任何时刻合入；为免并行冲突仍按编号次序。组内按编号顺序。
>
> 通用纪律：
> - 每组一个 PR，合入后 `make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿、主干可运行；凡改到或新增官方 omp 用例的组另跑 `WORKBUDDY_OMP_TEST=1` 的全部 `server/test/omp-official-*.test.ts`（`make omp-fetch` 拉到的 v18.0.10，不是 brew 装的版本）。
> - **永远不打真实模型端点。** 单测、官方 omp 用例、冒烟与走查一律打假上游；`make smoke-live` 不在本 change 的验证里。
> - 新逻辑进新模块：`web/src/features/chat/stream.ts`（757 行）、`server/src/sessions/supervisor.ts`（784）、`server/src/sessions/store.ts`（780）、`web/src/lib/session-contract.ts`（678）离 800 行上限很近；`scripts/size-guard.sh` 是硬门槛，不调阈值。
> - 任务里点名的 `文件:行` 是在 `09c9b5b7` 上读的。每组开工时先重跑该组第一个任务的核对；有出入先改本 change 的 design 与该组任务，再继续。
> - 带「实测」的任务把命令、输出与时长贴进 PR；design 里标「推算」的数字一律以实测替换，时长类结论同时写进对应 ADR 增补。
> - 既有断言只要还有意义就不删除、不削弱；因行为变化而改写的断言（model-proxy「Upstream failures normalized」、overlay 字节、消息键集、`server/test/model-proxy-timeout.test.ts:44-61` 的建连超时用例——今天断言 502 + `AGENT_UNAVAILABLE_ENVELOPE` 且真等约 10 s，改为注入短期限并断言 424 `no_connect`），在 PR 的偏离记录里逐条列出旧断言与新断言。
> - 不实现 design 的 Non-Goals：不加自动重试策略或多上游切换，不透传 `Retry-After`，不给已开始的流设期限，不让重试提示进快照。
> - 一次性脚本（如时长测量）写在系统 scratchpad，不入库；输出贴进 PR。
> - **官方 omp 层的时间预算**：`uid-isolation` job 的 `timeout-minutes: 15` 里还要跑 `make smoke`。每次「503 直到失败」约 64 s（推算），所以全 change 只保留两次这样的运行（3.2 的两例），后续组在这两例上追加断言，不另起运行；每组 PR 写明该测试文件的总时长。
> - `Suggested fixture level` 只用 `none | compact | expanded`。

## 风险包

| 风险包 | 选中 | 落点 |
|---|---|---|
| Public API / CLI / script entry | 选中：快照消息键集、`error` 事件负载、新事件 `turn.retry` | 组 7 的严格解析与拒收用例；chat-sessions「会话 REST」MODIFIED；4.3 的服务端先发安全性 |
| Config / project setup | 选中：`MODEL_UPSTREAM_API_KEY` 新增启动失败条件；宿主 overlay 内容变化 | 组 2、组 3 |
| File IO / path safety / overwrite | 选中：400 的错误文本带出服务器路径 | 1.2（净化器第 2 步与密钥集里的两组服务器路径）、6.3 |
| Schema / columns / units / field names | 选中：迁移 043 | 6.2 |
| Auth / permissions / secrets | 选中：上游密钥、上游地址的敏感部分与服务器路径进入错误文本与日志的路径；overlay 关闭 omp 的模型兜底 | 1.2、1.4、3.2、5.4、6.3、8.1 的「不含密钥」断言（8.1 用逐字含密钥的 `secret` 正文，使断言能红）|
| Concurrency / shared state / ordering | 选中：落库先于发布；重试帧与结局替换的次序 | 4.2、6.3 |
| Resource limits / large input / discovery | 选中：读 ≥500 正文的上限、原文 2000 码点上限、建连 / 首字节两个期限 | 1.2、1.4、1.5 |
| Legacy compatibility / examples | 选中：旧行三列为 NULL；组 5、组 6 期间旧前端仍收两键 `error` | 5.3、6.2、7.1 |
| Error handling / rollback / partial outputs | 选中：本 change 的主体 | 各组 |
| Release / packaging / dependency compatibility | 选中：依赖 omp v18.0.10 的帧与 `errorMessage` 形状 | 1.7、3.2、4.4 钉住；ADR 增补写明升级时重验 |
| Documentation / migration notes | 选中 | 1.9、2.3、3.4、4.6、5.6、6.6、7.7 |

## 1. model-proxy / upstream-failure — 代理失败摘要、首字节期限与测试设施（组 1）

- [x] 1.1 开工核对：重读 `server/src/model-proxy/index.ts` 的 `sendUpstream`（`:303-326`）、折叠分支（`:260`）、`CONNECT_DEADLINE_MS`（`:12`）及其到期分支与 `requestUpstream`（`:339-418`）；`resource/oh-my-pi` 的 `TRANSIENT_TRANSPORT_PATTERN`（`packages/ai/src/error/flags.ts:158-159`）仍与 design D6 对三个 424 记号名的分析一致；`var/omp/omp --version` 为 18.0.10。
  验证：核对结果写进 PR；行号有出入时先改 design 的引用。
- [x] 1.2 新建 `server/src/core/upstream-failure.ts`（纯函数，无 IO）：`sanitizeUpstreamText(text, secrets)` 按 upstream-failure「上游原文净化」六步、按其次序实现（先删控制字符再去密钥，最后截断）；`upstreamSecretList({apiKey, baseUrl, paths})` 按该要求的「密钥集」实现（较长的串先替换）；截断标记把 `server/src/sessions/events.ts:56` 的 `TRUNCATED_MARK` 移到 core，`events.ts` 与 `store-thinking.ts` 改为从 core 导入（仍是单一来源）；代理用的失败信封构造函数（design D6 的五种情况，三个 424 正文逐字节固定）。
  验证：`server/test/upstream-failure-sanitize.test.ts` 覆盖规格「去密钥与去路径」「被控制字符劈开的密钥」「上游地址与服务器路径」「截断上限」与每一步各一例（含空密钥集、密钥 `fake` 替换正文里的 `fake`、userinfo 无密码段、pathname 为 `/`、无查询串、realpath 与原值相同只出现一次）；一条断言三个 424 信封经 omp 拼出的文本（`424 <message>\n<message> (type=wb_upstream param=<种类>)`）都不匹配 omp 的 `TRANSIENT_TRANSPORT_PATTERN`、`TIMEOUT_PATTERN`、`AUTH_FAILURE_PATTERN`（模式逐字拷进测试并注明出处与 omp 版本）；`make lint typecheck`。
- [x] 1.3 假上游开关：在 `server/test/support/fake-upstream.mjs`（及 `.d.mts`）按 model-proxy「假上游夹具契约」实现 `WORKBUDDY_FAKE_STATUS` / `_BODY` / `_FAIL_TIMES` / `_DELAY` / `_HANG` / `_CUT`，可参照测量用的一次性 `upstream.mjs`（scratchpad，不入库）。保持零依赖，CLI 与进程内两种用法都可用。另在 `server/test/support/` 加一个「接受 TCP、永不写一个字节」的监听（建连卡住用：以 `https://127.0.0.1:<port>` 寻址时 TLS 握手停住），记录接受的连接数，`close` 销毁全部套接字；不用黑洞 IP（各网络下行为不一，可能很快回 `EHOSTUNREACH`）。 **（fixture 复审补注）**：「接受 TCP、一个字节都不写」的监听已有现成的 `startStalledHandshake`（`server/test/model-proxy-helpers.ts:563-574`，`model-proxy-timeout.test.ts` 在用）——挪到 `server/test/support/` 并加接受计数后复用，不另造重复 helper。
  验证：夹具测试覆盖规格新增的四个场景（含「Delayed scripted status」），既有八个场景原样通过；`HANG` 与 `DELAY` 的连接在 `close` 后无泄漏（既有「Imported instance ownership」的写法）；静默监听的接受计数与 `close` 各一例。
- [x] 1.4 代理 ≥500 与连接失败：`sendUpstream` 对 504 / 524 不读正文、释放上游响应并回 424 `gateway_<s>` 固定正文；对其余 ≥500 读至多 16 KiB / 5000ms 的正文（`content-encoding` 非 identity 不读），经 1.2 的净化器（密钥集为 `upstreamSecretList({apiKey, baseUrl, paths: []})`，取自代理自己的 `upstream`）生成节选与 502 信封；`requestUpstream` 的快失败（Node `code`、同步抛错）生成 502 `connect.*` 信封。`< 500` 路径一字不改。
  验证：`model-proxy-*.test.ts` 覆盖规格「5xx summary carries status and a sanitised excerpt」（含 base URL 的 userinfo 与路径段）「Below-500 answers stay opaque」、改写后的「Upstream failures normalized」与「Slow failures answer 424」的 504 / 524 两例；5000ms 上限用注入时钟或短值验证，不真等。
- [x] 1.5 两个期限：`ModelProxyOptions.firstByteDeadlineMs`（缺省 120000），自发出上游请求起计时，收到响应头即清，到期释放上游请求并回 424 `no_response`；`ModelProxyOptions.connectDeadlineMs`（缺省 10000，取代模块常量 `CONNECT_DEADLINE_MS` 的直接使用），传输建立即清，到期释放上游请求并回 424 `no_connect`（不再是 502）。两者正文逐字节固定。生产装配（`server/src/app.ts:213-214`）两项都不传。 **（fixture 复审补注）**：既有的 `model-proxy-timeout.test.ts:44-61` 随之改为注入短期限、断言 424 `no_connect`（或并进「Slow failures answer 424」），列入偏离记录；改后本组没有任何单测真等 10 s。
  验证：「First-byte deadline answers 424」两例（注入 300ms）；「Slow failures answer 424」的建连一例（注入 300ms，指向 1.3 的静默监听，接受计数为 1）；一条断言两个缺省值为 120000 / 10000 且生产装配的选项里没有它们；改写后的「Established transport with delayed headers」通过。单测不真等 10 s。
- [x] 1.6 经代理的官方 omp 夹具：新增 `server/test/support/omp-official-proxied.ts`，在 loopback 上用 `registerModelProxy` 起一个代理实例（令牌查表接 runtime 的令牌登记），托管 `models.yml` 指向它（同一 provider 下两个白名单模型，3.2 的项目层兜底链用第二个），代理指向假上游或 1.3 的静默监听，可注入 `firstByteDeadlineMs` 与 `connectDeadlineMs`。`openOfficialWorld` 不动。
  验证：新文件 `server/test/omp-official-upstream-failure.test.ts` 的第一例：无标记 prompt 经代理完成为 done。
- [x] 1.7 官方 omp 实测（同一文件，`WORKBUDDY_OMP_TEST=1`）：
  (a) `WORKBUDDY_FAKE_STATUS=401` → 上游恰 1 次请求，回合 failed，`message_end.errorStatus` 为 401；
  (b) `WORKBUDDY_FAKE_HANG` 且 `firstByteDeadlineMs` 3000 → 上游恰 1 次请求，没有 `auto_retry_start` 帧，回合 failed，`errorMessage` 以 `(type=wb_upstream param=no_response)` 结尾；
  (c) `WORKBUDDY_FAKE_STATUS=503`（会话级重试此时仍为缺省）→ 等到第一帧 `auto_retry_start` 即断言其 `errorMessage` 第一行为 `502 模型服务返回 HTTP 503…`、整段以 `(type=wb_upstream param=status.503)` 结尾，然后关停；
  (d) 代理指向静默监听、`connectDeadlineMs` 1000 → 监听恰接受 1 个连接（假上游 0 次请求），没有 `auto_retry_start`，回合 failed，`message_end.errorStatus` 为 424、`errorMessage` 以 `(type=wb_upstream param=no_connect)` 结尾；**实测**时长（design 推算 ≈ 1 s + omp 开销；生产 10 s）；
  (e) `WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_BODY=text WORKBUDDY_FAKE_DELAY=2000`（正文为 `504 Gateway Timeout`，一旦进信封就会命中 omp 的 `timeout` 模式）→ 上游恰 1 次请求，没有 `auto_retry_start`，回合 failed，`errorStatus` 424、`errorMessage` 以 `(type=wb_upstream param=gateway_504)` 结尾且不含 `Gateway`；**实测**时长（推算 ≈ 2 s + omp 开销）。
  把该文件加进 `.github/scripts/ci-uid-isolation.sh` 的 vitest 清单，并同步 `scripts/test-ci-harness.sh` 对该行的逐字断言（omp-uid-isolation「CI uid-isolation job」已允许两处同步）。
  验证：五例本地通过并贴出帧日志节选与时长；`make test-guardrails` 通过。(b)(d)(e) 任一例 omp 仍重试，停下来报告，不改用别的状态码或记号名绕过（design D6 / D7 需要重议）。
- [x] 1.8 规格对照：model-proxy 两条 MODIFIED 的全部场景各有对应测试名（PR 里列表）。
- [x] 1.9 文档：`docs/architecture/system.md` 模型代理一节写明五种失败信封（可重试 502 两种、不可重试 424 三种）、424 与记号名的理由、120 s 只限响应头、10 s 建连期限到期不再重试，以及一句「≥500 节选会进入 omp 的文本分类器（额度、上下文溢出、内容过滤等），502 不保证照常重试一轮，但时长上界不变」；ADR-0008 增补一条（#909：代理不再丢弃 5xx 细节而带回净化节选；首字节期限；慢失败——建连期限到期、上游 504 / 524——回不可重试的 424；与 omp 版本绑定，升级重验）。
  验证：文档里的状态码与字段名与代码一致（PR 里逐条对照）。
- [x] 1.10 变异证据（对真实文件逐条做、逐条撤销，结果贴进 PR）：净化器去掉删 `raw-http-request=` 行一步 → 去路径用例判红；把删控制字符挪到去密钥之后 → 「被控制字符劈开的密钥」判红；`upstreamSecretList` 不产出 userinfo 与路径段 → 「上游地址与服务器路径」与 1.4 的 base URL 用例判红；`no_connect` 改回 502 `connect.CONNECT_DEADLINE` → 1.7(d) 判红（监听接受连接数 > 1 或出现 `auto_retry_start`）；`gateway_504` 信封的 message 改为含字面 `504` 或带上节选 → 1.7(e) 判红（出现 `auto_retry_start`）；记号名改为 `connect_timeout` → 1.2 的分类器模式断言判红；节选上限改为 1001 码点 → 节选长度用例判红；424 改为 504 → 1.7(b) 判红（上游请求数 > 1 或出现 `auto_retry_start`）；首字节计时器在连接建立时就清除 → 「First-byte deadline answers 424」判红；`< 500` 分支误调净化器 → 「Below-500 answers stay opaque」判红。
- [x] 1.11 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；`WORKBUDDY_OMP_TEST=1` 全部官方用例通过。

Suggested fixture level: expanded - 改共享入口（模型代理是 omp 访问模型的唯一通道）的错误映射与超时语义，影响 Critical Path「omp 子进程治理」；涉及密钥进入错误文本的路径
Minimal mergeable slice: atomic - 424 与三个记号名的选择只有经真实 omp 实测才成立，代理改动、假上游开关与经代理的官方夹具必须同刀；净化器在本组只有代理一个调用方，与之同刀才不被 knip 判为未用导出

## 2. http-service-skeleton — 非法密钥拒绝启动（组 2）

- [x] 2.1 `server/src/agent-config.ts` 在 `MODEL_UPSTREAM_API_KEY`（`:81`）解析之后调用 `http.validateHeaderValue("authorization", \`Bearer ${key}\`)`；抛错时改抛 `MODEL_UPSTREAM_API_KEY must be a valid HTTP header value`，不含取值、不透传 Node 的原始错误。
  验证：`server-config.test.ts` 覆盖 `\n`、`\0`、`密钥`、`abc def` 四例（前三例抛错且 message 含键名不含哨兵，第四例通过）。
- [x] 2.2 编译入口：`server-startup-failure-reason.test.ts` 跑 http-service-skeleton「非法上游密钥拒绝启动」场景。
  验证：stdout / stderr 不含哨兵、恰一行 `{"event":"server_start_failed","reason":"config"}`、无文件系统与监听副作用；`abc def` 正常启动。
- [x] 2.3 文档：`docs/architecture/system.md` 的配置说明写明密钥必须是合法 HTTP 头取值、否则拒绝启动；PR 描述提示升级前检查密钥。
  验证：PR 里贴出改动段落。
- [x] 2.4 变异证据：去掉校验 → 2.2 判红（进程启动成功）；把 Node 原始错误的 message 透传 → 2.1 的键名 / 哨兵断言判红；改为手写字符集 `/^[\x20-\x7e]*$/` → `abc def` 之外再加一例 `é`（Latin-1，Node 接受）判红。
- [x] 2.5 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿。

Suggested fixture level: compact - 一处配置校验与它的测试；不过它改变的是生产启动条件（发布说明必须提示），审阅按 expanded 的 sibling surface 核对 `smoke-live` 与 CI 的密钥取值
Minimal mergeable slice: atomic - 一个校验调用、它的单测与编译入口用例

## 3. omp-runtime — 会话级重试封顶一轮（组 3）

- [x] 3.1 `server/src/sessions/omp/host-overlay.ts` 的 `HOST_OVERLAY` 在 `images:` 段后追加 design D12 的 `retry:` 段（五个键，含 `modelFallback: false`）；头注释补一句理由。
  验证：overlay 字节测试按 omp-runtime「宿主 overlay」的新内容更新并通过（偏离记录列出旧字节与新字节）；「overlay 不随档位变化」照旧通过。
- [x] 3.2 官方 omp：`omp-official-upstream-failure.test.ts` 加「会话级重试封顶一轮（真实 omp）」两例（每次 503；项目层 `retry: {maxRetries: 10, baseDelayMs: 3600000, modelFallback: true, fallbackChains: {default: ["<provider>/<第二个模型>"]}}`，断言假上游收到的请求体 `model` 全是第一个模型），并把 1.7(c) 的末尾记号断言并进第一例（删去 1.7(c) 的单独运行）；第一例**逐字记录**最终 `message_end.errorMessage`（是否带 `Retry budget exhausted after 1 retry: ` 前缀，design D10），贴进 PR。连接失败不在官方层跑（记号形状与 `status.*` 同一拼装，由 1.4 的代理单测覆盖），只用一次性脚本实测一次时长贴进 PR。
  验证：两例通过；**实测**上游请求数与时长写进 PR（design 的 ≈ 64 s / 24 次是推算）。
- [x] 3.3 规格对照：omp-runtime「宿主 overlay」的新场景有对应测试名。
- [x] 3.4 文档：ADR-0012 增补（#909：overlay 新增 `retry:` 段，五个键的取值与理由，3.2 的实测数字；明写「关闭了 omp 的模型兜底」）。PR 描述同样写明 overlay 关闭了 omp 的模型兜底（`retry.modelFallback: false`）及其理由（多上游切换不在范围内）。
  验证：文档数字与 3.2 的实测一致。
- [x] 3.5 变异证据：`maxRetries: 1` 改为 `2` → 3.2 判红（出现第二个 `auto_retry_start`）；去掉 `baseDelayMs` 行 → 项目层一例判红或超时（如实记录是哪一种）；去掉 `modelFallback: false` 行 → 项目层一例判红（出现请求第二个模型的请求体或第二个 `auto_retry_start`）。
- [x] 3.6 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk`、`WORKBUDDY_OMP_TEST=1` 全部官方用例全绿。

Suggested fixture level: expanded - 改 omp 子进程的生产配置（Critical Path「omp 子进程治理」），行为以真实 omp 实测为准
Minimal mergeable slice: atomic - overlay 的六行与证明它生效的真实 omp 用例

## 4. chat-stream / turn-control / upstream-failure — 重试归约与 `turn.retry`（组 4）

- [x] 4.1 开工核对：`server/src/sessions/events.ts` 的帧分支（`:106-130`）、`message_end`（`:266-286`）、`agent_end`（`:288-302`）；`resource/oh-my-pi` 的 `Retry cancelled`（`packages/coding-agent/src/session/turn-recovery.ts:2264-2281`）。
  验证：核对写进 PR。
- [x] 4.2 归约器（design D11）：`auto_retry_start` → `turn.retry{messageId}` 与「重试中」；其后第一个 assistant `message_end` 替换结局；`auto_retry_end` 的 `Retry cancelled` → 已中断；其余 `auto_retry_*` 过滤。
  验证：先在未改代码上写 chat-stream「Retry that succeeds ends done」并看到它红（今天判 failed），再实现到绿，并断言整段只有一个 `turn.start`（重试轮的 `agent_start` 不发第二个，靠 `events.ts:148` 既有的 `started` 守卫；守卫若已变，先补回）；一例断言 `turn.retry` 前已累积的 thinking 在重试成功后仍在（design D11 的已接受残余，不清）；「Cancelled retry ends stopped」「Retry frames outside a running turn」与全部既有 chat-stream、turn-control 场景通过。（「Retry that fails reports the last failure」与「Classified failure payload」依赖分类，属组 5。）
- [x] 4.3 supervisor 发布 `turn.retry`（不落库，占环形缓冲序号）。
  验证：upstream-failure「重试提示可回放不可快照」通过；另一例用现行 web 的连接器解析带 `turn.retry` 的事件流，证明它被忽略且不触发重新同步（chat-web 既有「未知类型忽略」规则）。
- [x] 4.4 官方 omp（同一文件）：
  (a) `WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=12` → 恰一个 `turn.retry`、回合 `done`、正文为假上游的工具轮与回复（审批按既有夹具作答）；
  (b) 每次 503，在 `turn.retry` 之后调用 stop 路由 → turn-control「重试退避中停止（真实 omp）」：`OMP_ABORT_GRACE_MS` 内恰一个 `turn.end stopped`、无 `error`；**记录实测到的收尾路径**（omp 发 `agent_end`，还是有界退回）。
  验证：两例通过；(a) 在 4.2 之前的代码上判红，贴出对照。
- [x] 4.5 规格对照：chat-stream 与 turn-control 本组覆盖的场景各有对应测试名。
- [x] 4.6 文档：`docs/architecture/system.md` 的 SSE 一节加 `turn.retry`（发布不落库、可回放不进快照、第一轮失败前不出现）。
  验证：PR 里贴出改动段落。
- [x] 4.7 变异证据：把替换改回「首个为准」→ 4.4(a) 与「Retry that succeeds ends done」判红；去掉 `Retry cancelled` 分支 → 「Cancelled retry ends stopped」判红（4.4(b) 若走有界退回则仍绿，如实记录）；`turn.retry` 改为落库 → 「重试提示可回放不可快照」判红。
- [x] 4.8 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk`、`WORKBUDDY_OMP_TEST=1` 全部官方用例全绿。

Suggested fixture level: expanded - 改 omp 帧的归约语义（结局可被替换）与发布的事件集合，回合终态的判定在此
Minimal mergeable slice: atomic - 替换规则、`Retry cancelled` 与 `turn.retry` 都由同一个「重试中」状态驱动；4.4(a) 只有三者齐备才可能为绿

## 5. upstream-failure / chat-stream — 失败分类、句子与日志（组 5）

- [x] 5.1 开工核对：1.7(b)–(e) 与 3.2 记录的 `errorMessage` 末尾形状与 upstream-failure「回合失败分类」的记号正则一致；`failTurn`（`events.ts:329-343`）与 `persistEvent`（`server/src/sessions/turn-control.ts:219-230`）行号核对。
  验证：核对写进 PR；形状不一致时先改规格与 design D6。
- [x] 5.2 新建 `server/src/sessions/upstream-classify.ts`（纯函数）：末尾记号解码与 `classifyTurnFailure`，句子表只在此定义。
  验证：`upstream-classify.test.ts` 覆盖「逐条分类」「记号只认末尾」「状态不符的记号不被采信」「重试预算前缀不影响 detail」，每一行恰一例。
- [x] 5.3 归约器的失败负载：`error` 事件带 `reason`、`status`、`detail`（未净化）与句子 `message`；prompt 失败应答与 `applyFailure` 归为 `agent_failed`。supervisor **本组发布的 `error` 仍是两键** `{messageId, message}`，`message` 为「句子（HTTP s）」（status 为 null 时只有句子），现行前端照常解析。
  验证：chat-stream「Classified failure payload」「Retry that fails reports the last failure」通过（断言归约器输出）；一条 supervisor 用例断言线上负载恰两键、`message` 为 `鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）`。
- [x] 5.4 日志：sessions 的 `log` 端口类型加 `upstream_failed` 记录；supervisor 在发布 `reason ≠ agent_failed` 的 `error` 时交出一条；`server/src/server.ts` 的 `writeRecord` 联合类型同步。
  验证：upstream-failure「每个失败回合一行」（桩运行时）与 http-service-skeleton「上游失败记录」（生产装配，stderr 恰多一行且不含密钥）通过。
- [x] 5.5 官方 omp（同一文件）：**不新增 503 运行**——在 3.2 第一例上追加断言：SSE 的 `error.message` 为 `上游出错：模型服务内部错误（HTTP 503）`，`log` 端口恰一条 `upstream_failed`、`status` 503；在 1.7(a) 的 401 例上追加 `鉴权失败：…（HTTP 401）`；在 1.7(d) 上追加 `上游不可达：无法连接模型服务`（无 `（HTTP`），在 1.7(e) 上追加 `上游超时：模型服务没有及时响应（HTTP 504）`。
  验证：两例通过；官方测试文件的总时长写进 PR。
- [x] 5.6 文档：`CONTEXT.md` 领域术语表加一行「回合失败原因」（十个 `reason` 与句子，指向 upstream-failure 规格）；`docs/architecture/system.md` 写明 `upstream_failed` 记录。
  验证：`CONTEXT.md` 与 `openspec/glossary.md`（若存在）不双写同一术语。
- [x] 5.7 变异证据：去掉记号正则的 `$` 锚 → 「记号只认末尾」判红；去掉「`errorStatus` 须等于该种类的代理状态」的检查 → 「状态不符的记号不被采信」判红（401 伪造例归成 `upstream_error`）；不剥 `Retry budget exhausted` 前缀 → 「重试预算前缀不影响 detail」判红；把 #6 的 `model` 判定删掉 → 404 不含 model 的用例判红；日志记录加上 `detail` → 「每个失败回合一行」的键集断言判红；`agent_failed` 也记日志 → 同一场景判红。
- [x] 5.8 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk`、`WORKBUDDY_OMP_TEST=1` 全部官方用例全绿；手工打开一个 401 失败的会话，确认现行前端显示「鉴权失败：…（HTTP 401）」（贴 DOM 文本）。

Suggested fixture level: expanded - 改变已发布事件的文本含义（`error.message`）并新增一种 application stderr 记录
Minimal mergeable slice: atomic - 句子投影与日志读的是同一个分类结果；分类没有消费方时 knip 判未用导出

## 6. upstream-failure — 错误落库（组 6）

- [x] 6.1 开工核对：`ls server/src/core/db/migrations | tail -1` 仍为 `042`、`git ls-remote` 的各分支没有 `043`；`grep -rn MIGRATION_042 server/test` 列出所有枚举迁移的测试。
  验证：核对写进 PR；`043` 已被占用时停下来报告。
- [x] 6.2 迁移 `server/src/core/db/migrations/043_chat_message_error.sql`（头注释照 `042`）；`server/test/core-db-helpers.ts` 的迁移清单与受信迁移计数加一，6.1 命中的其它测试同步。
  验证：upstream-failure「新库与存量库」「中途失败可重试」通过。
- [x] 6.3 净化与写入：`createApp`（`server/src/app.ts`）用 `upstreamSecretList({apiKey, baseUrl, paths})` 构造密钥集一次——`assembly.upstream` 的 apiKey 与 baseUrl，`runtime.stateDir`、`runtime.sandboxRoot` 及二者的 `realpathSync`（与原值不同才加入，取不到时跳过）——再构造 `redactUpstream` 闭包交给 sessions 装配（未配置上游时只有两组路径）；`agent_failed` 的运行时文本同样只经它；`persistEvent` 的 `error` 分支先净化 `detail`、写三列，再返回供发布的事件（线上负载仍是组 5 的两键）。写三列的 store 方法放新模块（如 `store-error.ts`）。
  验证：upstream-failure「落库先于发布」与「上游地址与服务器路径」的 `runtime` 一例（桩运行时以含状态目录绝对路径的文本失败）通过；`secret` 正文的 400 回合落库的 `error_detail` 不含密钥、bearer、`sk-` 串与 `raw-http-request=`。
- [x] 6.4 fork 的行拷贝（`server/src/sessions/store-branch.ts`）带上三列；启动对账不写三列。
  验证：upstream-failure「拷贝、删除与对账」通过；`bash scripts/size-guard.sh` 退出 0；chat-sessions「会话 store 源码模块划分」场景通过。
- [x] 6.5 官方 omp（同一文件）：同样**不新增 503 运行**——在 3.2 第一例上追加库里三列为 `upstream_error`、503、含 `模型服务返回 HTTP 503`；新增一例 `WORKBUDDY_FAKE_STATUS=400 WORKBUDDY_FAKE_BODY=empty`（约 2 s）→ `request_rejected`、400，`error_detail` 不含 `raw-http-request=`（实测 case 12 的路径行）。
  验证：两例通过。
- [x] 6.6 文档：`docs/architecture/system.md` 的数据一节列出三列及其含义。
  验证：PR 里贴出改动段落。
- [x] 6.7 变异证据：把写三列挪到发布之后 → 「落库先于发布」判红；fork 不拷三列 → 「拷贝、删除与对账」判红；写入前不净化 → 6.3 的 `secret` 断言判红；闭包只用 `[apiKey]` 构造 → 6.3 的 `runtime` 路径一例判红；迁移改为带 `DEFAULT ''` → 「新库与存量库」判红。
- [x] 6.8 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk`、`WORKBUDDY_OMP_TEST=1` 全部官方用例全绿。

Suggested fixture level: expanded - 新迁移与持久化；落库与发布的次序
Minimal mergeable slice: atomic - 迁移没有写入方是死列，写入方没有迁移无处可写；fork 拷贝与写入同刀，否则 fork 在合入后的窗口里静默丢列

## 7. chat-sessions / chat-web — 快照与事件的公开形状、前端呈现（组 7）

- [x] 7.1 服务端公开形状：REST 快照每条消息加 `error`（upstream-failure「失败的公开形状」）；`error` 事件发布完整五键，去掉组 5 的两键投影；`toPublicHistory`（`server/src/sessions/rest.ts:464-499`）同步。
  验证：chat-sessions「会话 REST」改写后的两个场景与 upstream-failure「刷新后看到同一条错误」通过。
- [x] 7.2 web 快照解析：`error` 键按严格键集 `{reason,message,status,detail}` 或 `null` 解析，user 消息必须为 `null`；解析放新模块。`web/src/lib/session-contract.ts:365` 的消息键集加 `error`。
  验证：chat-web「API 客户端扩展」的「消息 error 键严格解析」通过——接受（`null`、四键对象、`status:null`、`detail:""`）与拒绝（缺 `error`、多键、缺 `detail`、`status:"401"` / `700` / `401.5`、`detail:null`、`reason:""`、user 消息非 null）；`grep -rln 'attachments:' web/test web/e2e` 命中的每个构造消息 DTO 的夹具与支撑文件（含 `web/e2e/route-hold.ts`）都补上 `error` 键，名单写进 PR。
- [x] 7.3 web 事件解码：`error` 五键、`turn.retry` 一键，`turn.retry` 加入数据事件清单；解码与归约放新模块（如 `stream-failure.ts`）。
  验证：chat-web「失败与重试事件严格解码」通过；既有「命名错误与原生自动续连」通过。
- [x] 7.4 归约：视图消息的 `error` 改为对象、新增 `retrying`；`chatStateFromSnapshot` 取快照 `error`、`retrying` 为 `false`；十二类事件的置真 / 置假规则；`runtime-convert.ts` 的透传字段随类型更新。
  验证：chat-web「失败对象与重试标记归约」与既有归约场景、`convertMessage` 场景通过。
- [x] 7.5 呈现：`web/src/features/chat/message-thread.tsx` 的 `MessageError`（`:153-163`）按 chat-web「消息线程」的错误文本段落渲染句子、`（HTTP s）`、`查看原文` 与原文块；同一位置的重试提示。原文以文本节点渲染。输入框解锁与 `重新生成` 不改代码（design D19），只在既有输入框锁定测试里加一例「上游失败结束后解锁」。
  验证：「失败消息的分类说明与原文」「重试提示」两个场景通过（jsdom）；含 `<b>x</b>` 的原文不产生 `b` 元素；亮暗主题下错误块颜色沿用既有 `--wb-status-error-text`。
- [x] 7.6 验收清单（`docs/acceptance/functional-checklist.md`，结论一律 `待签`，不代签）：CH-48 的期望改为「失败的回答里有一句分类说明（带状态码时显示 HTTP 状态码），可点『查看原文』展开；刷新页面后仍在」；新增五行，ID 接在现有最大号之后：(a) 把服务的上游密钥改成格式合法但上游不接受的值后重启（含换行等非法字符的密钥会让服务拒绝启动，见组 2），发一句话——几秒内出现「鉴权失败…（HTTP 401）」，展开原文里没有密钥，输入框可用，重发与重新生成可点；(b) 把上游地址指向一个总回 503 的服务后重启，发一句话——约半分钟后出现「上游出错，正在重试…」，约一分钟后以「上游出错…（HTTP 503）」结束；(c) 把上游地址指向一个能完成连接、收下请求但永不回应的服务后重启，发一句话——约两分钟后以「上游超时…」结束，期间不出现重试提示；(d) 把上游地址指向一个只接受 TCP 连接、从不完成握手的 `https` 地址后重启，发一句话——约十秒后以「上游不可达…」结束（不显示 HTTP 状态码），期间不出现重试提示；(e) 把上游地址指向一个总回 504 的服务后重启，发一句话——几秒内以「上游超时…（HTTP 504）」结束，期间不出现重试提示。
  验证：清单格式守卫通过；行里没有像素值与选择器。
- [x] 7.7 规格对照：chat-sessions、chat-web 的 MODIFIED（含「API 客户端扩展」）与 upstream-failure「失败的公开形状」的每个场景各有对应测试名。
- [x] 7.8 变异证据：服务端快照少发 `error` 键 → web 解析拒收用例与 7.1 判红；web 解析器放宽为接受多余键 → 拒收用例判红；原文改为 `dangerouslySetInnerHTML` → `<b>x</b>` 用例判红；`text.delta` 不清 `retrying` → 「失败对象与重试标记归约」判红；`status` 为 null 时仍渲染 `（HTTP` → 第二条消息断言判红。
- [x] 7.9 整组验证：`make check`、`make test-guardrails`、`make smoke`、`make ui-walk` 全绿；`bash scripts/size-guard.sh` 退出 0。

Suggested fixture level: expanded - 改公开 API（快照键集与事件负载），web 的严格解析与服务端必须同刀
Minimal mergeable slice: atomic - **Width 例外**：快照消息与 `error` 事件的键集两侧都是严格解析（`session-contract.ts:365`、`stream.ts:718`），服务端先加键则现网页面整体拒收快照、打不开会话，web 先收紧则拒收现网快照，所以 7.1–7.4 必须同刀；7.5 的呈现可以拆出，但拆出后 7.1–7.4 的新字段没有任何可见效果、无法走查，故一并合入。替代方案（#1025 先例的先宽后严三步）见 design D18

## 8. chat-harness — 冒烟与走查（组 8）

- [x] 8.1 `smoke/chat.hurl`：按 chat-harness「上游失败的冒烟与走查」在既有用例之后追加 `401 + WORKBUDDY_FAKE_BODY=secret` 回合（上游正文逐字含配置的密钥，分类仍为 `auth_failed`）、断言、普通回合与删除，全部带 `skip: {{skip_turn_control}}`。`Makefile` 配方、Hurl 文件参数与 `AGENTS.md` 的冒烟证据行不变。
  验证：`make smoke` 连跑两遍通过，chat-harness「连跑两遍不积累临时空间」通过；`make test-guardrails`（Make 配方与 `AGENTS.md` 行的 oracle）通过；以 `skip_turn_control=true` 对假上游手工跑一次该文件，确认这些条目被跳过。
- [x] 8.2 `make ui-walk`：新增上游失败一步（新 `web/e2e/ui-walk-upstream-failure.ts`，由 `ui-walk.spec.ts` 调用），会话 id 取自被观察的 `POST /api/sessions` 201 响应，`finally` 里删除。
  验证：两个 project 通过；步骤失败时会话也被删除（临时注入一个失败断言验证后撤销）。
- [x] 8.3 变异证据：服务端把 401 归成 `request_rejected` → 冒烟判红；`redactUpstream` 改为原样返回（跳过净化器）→ 冒烟的「`detail` 不含密钥」与走查的「原文不含密钥」判红；web 不渲染 `（HTTP 401）` → 走查判红；冒烟条目去掉 `skip` 门控 → 8.1 的 `skip_turn_control=true` 运行判红。
- [x] 8.4 收尾验证：`make check`、`make test-guardrails`、`make smoke`（两遍）、`make ui-walk`、`WORKBUDDY_OMP_TEST=1` 全部官方用例全绿；`npx openspec validate fix-upstream-failure-surfacing --strict --no-interactive` 通过；本文件全部任务勾选；验收清单新增行仍为 `待签`，#909 在这些行签收前不关闭（functional-acceptance「功能验收清单与签收」）。 **（编排方注，2026-10-14）**：本条原文要求验收行签署前 #909 保持打开；按 owner 的整体指令（非 Epic issue 全部关闭，owner 事后验收），#909 随第 5 个 PR（#1431）关闭，CH-48、CH-107…CH-111 仍为「待签」。

Suggested fixture level: compact - 只加测试步骤，不改产品代码；冒烟配方与证据行不变
Minimal mergeable slice: atomic - 冒烟一例与走查一步同在五个 PR 中的最后一个（owner 2026-10-14 裁决）；两者只加测试、各几十行
