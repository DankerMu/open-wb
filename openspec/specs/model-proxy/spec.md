# model-proxy Specification

## Purpose
定义父进程持有上游凭证的模型代理契约：会话 bearer 鉴权、原始请求与响应流透传、错误映射、资源回收及仅含会话凭证环境变量名的托管模型配置；同时定义用于离线集成验证的 OpenAI 兼容假上游。

## Requirements

### Requirement: 假上游夹具契约
`server/test/support/fake-upstream.mjs` SHALL be a zero-dependency local OpenAI-compatible streaming fixture, importable through `start({port?,apiKey?})` and runnable directly by Node. It SHALL expose the actual bound port and asynchronous close, default to loopback/random port and expected bearer key `fake`, and permit an in-process expected-key override. One handler SHALL serve POST /chat/completions and POST /v1/chat/completions to satisfy the literal fixture path and the parent CI base URL, and (change s1d-model-registry, for model-registry「探活」) GET /models and GET /v1/models: with the expected bearer it answers 200 `application/json` `{"object":"list","data":[{"id":"fake-model","object":"model"}]}` unless the in-process option `start({modelsStatus})` names a status 400–599, in which case it answers that status with `{"error":{"message":"scripted models <status>","type":"scripted_error"}}`; every GET /models request (accepted or 401) is appended to the handle's `modelsRequests()` record as `{authorization: <header or null>}`. Missing/wrong Authorization SHALL return401 JSON; on the two GET /models routes only, that 401's `error.message` is `bad key <offered bearer or none>` (echoing the offered value, so probe-sanitising tests have a sentinel to look for) — the chat-completions 401 body is unchanged and never echoes credentials. For authenticated requests, the last user message containing WORKBUDDY_FAKE_ERROR SHALL return500 OpenAI-shaped JSON before any streaming branch. Otherwise, unless one of the failure markers below applies, messages without role:tool SHALL receive one streamed bash tool call with arguments {"command":"echo workbuddy-smoke"} and finish_reason:tool_calls; messages with role:tool SHALL receive at least three content deltas concatenating exactly to `你好，这是 WorkBuddy 的第一条流式回复。`, with finish_reason:stop. Successful streams SHALL use OpenAI chat.completion.chunk records and end with data: [DONE]. CLI SHALL honor FAKE_UPSTREAM_PORT, report actual readiness without credentials, and release resources on termination.

**失败标记**（#909）。鉴权通过、且最后一条 user 消息不含 WORKBUDDY_FAKE_ERROR 时，夹具 SHALL 按该消息文本里的下列标记应答，先于任何流式分支；`WORKBUDDY_FAKE_STATUS`、`WORKBUDDY_FAKE_HANG`、`WORKBUDDY_FAKE_CUT` 同现时按此顺序只取第一个，`WORKBUDDY_FAKE_BODY`、`WORKBUDDY_FAKE_FAIL_TIMES` 与 `WORKBUDDY_FAKE_DELAY` 只修饰 `WORKBUDDY_FAKE_STATUS`；不含标记时行为与上文完全相同：
- `WORKBUDDY_FAKE_STATUS=<三位数>`（`400`–`599`）：以该状态码应答，不发 SSE。正文由 `WORKBUDDY_FAKE_BODY=<名>` 选择，缺省 `json`：`json` 为 `application/json` 的 `{"error":{"message":"scripted upstream <状态码>","type":"scripted_error"}}`；`text` 为 `text/plain` 的 `<状态码> <原因短语>`（原因短语取 Node 的 `http.STATUS_CODES`，取不到时——如 524——为 `Unknown`）；`empty` 为 `content-length: 0` 的空正文；`quota` 为 `application/json` 的 `{"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}`；`model` 为 `application/json` 的 `{"error":{"message":"The model `x` does not exist","type":"model_not_found"}}`；`secret` 为 `application/json`，其 `message` 依次含该实例的期望密钥、`Bearer leak-token-0123456789`、`sk-leakleakleakleakleak` 与一行 `raw-http-request=/tmp/leak.json`（在 JSON 字符串里是转义的 `\n`，经 omp 解析 `error.message` 后才成为真换行）；`big` 为 `text/plain`、恰 20000 个码点、含换行的正文。
- `WORKBUDDY_FAKE_FAIL_TIMES=<n>`（与 `WORKBUDDY_FAKE_STATUS` 同用）：每个实例对每个不同的最后一条 user 消息文本计数，只有前 `n` 次请求得到该状态，其后的请求按无标记处理。
- `WORKBUDDY_FAKE_DELAY=<ms>`（与 `WORKBUDDY_FAKE_STATUS` 同用，`0`–`600000`）：读完请求后先等这么久，再写该状态的响应头与正文（用于「慢 504」）；等待期间客户端断开或 `close` 时 SHALL 放弃写入并释放连接。
- `WORKBUDDY_FAKE_HANG`：读完请求后既不写响应头也不写正文，直到客户端断开；`close` SHALL 释放这些挂起的连接。
- `WORKBUDDY_FAKE_CUT`：以 200 SSE 头开始，发两个 content delta `你好，` 与 `半句`，随后销毁套接字，不发 finish 与 `[DONE]`。
夹具记录的请求清单（既有）对带标记的请求同样逐条记录，使测试能数上游请求次数。

#### Scenario: Two-round model script
- WHEN valid bearer requests first omit role:tool and then include the resulting tool message
- THEN the first response reconstructs exactly one bash function call and tool_calls finish, and the second has at least three content events with the exact required text and stop finish; both have canonical chunk metadata and final DONE

#### Scenario: Authentication and expected key override
- WHEN requests omit bearer, use a wrong bearer or use the default key against an instance configured with a different key
- THEN401 JSON is returned without a successful stream; the correct configured bearer permits the expected branch, and no credentials appear in emitted diagnostics

#### Scenario: Last-user error selection
- WHEN the last user message's string or text-part content contains WORKBUDDY_FAKE_ERROR, regardless of a tool message later in the array
- THEN500 OpenAI-shaped error JSON is returned without SSE; a marker only in an older user message does not override a later ordinary user message

#### Scenario: Both declared mount points
- WHEN the fixture is addressed through /chat/completions or the parent's /v1 base plus /chat/completions
- THEN identical authentication/branch/framing behavior is supplied by the same implementation; unrelated routes do not produce a successful completion

#### Scenario: Invalid request and recovery
- WHEN an authenticated request contains malformed JSON or messages is not an array
- THEN400 JSON is returned, and a subsequent valid request still completes normally

#### Scenario: Imported instance ownership
- WHEN the module is imported and two instances are explicitly started with independent expected keys
- THEN import alone does not listen; each start returns its actual usable port, instances do not share credentials, and close releases listener/sockets including after an aborted client and repeated cleanup

#### Scenario: Standalone startup and shutdown
- WHEN Node runs the script with an explicit FAKE_UPSTREAM_PORT or with the variable unset
- THEN it listens on that port or an OS-selected port, emits a parseable actual-port readiness line only after binding, serves the same contract over real HTTP, and exits/reclaims the port on SIGTERM

#### Scenario: Failed CLI binding
- WHEN the configured port is invalid or already occupied
- THEN startup fails nonzero without false readiness, leaked server ownership or credential-bearing diagnostics

#### Scenario: Scripted failure markers
- **WHEN** authenticated requests' last user message carries `WORKBUDDY_FAKE_STATUS=401`, `WORKBUDDY_FAKE_STATUS=404 WORKBUDDY_FAKE_BODY=model`, `WORKBUDDY_FAKE_STATUS=429 WORKBUDDY_FAKE_BODY=quota`, `WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_BODY=text`, `WORKBUDDY_FAKE_STATUS=400 WORKBUDDY_FAKE_BODY=empty` and `WORKBUDDY_FAKE_STATUS=500 WORKBUDDY_FAKE_BODY=secret` in turn
- **THEN** each response has exactly that status with the named body and content-type and no SSE; the `secret` body contains the instance's expected key verbatim; every request is recorded

#### Scenario: Fail first n then succeed
- **WHEN** the same last user text carrying `WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=2` is sent four times to one instance, and once to a second instance
- **THEN** the first instance answers 503, 503, then the ordinary tool-call stream twice; the second instance answers 503 (counts are per instance and per text)

#### Scenario: Delayed scripted status
- **WHEN** a request carries `WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_DELAY=2000`, and another identical request's client aborts after 500ms
- **THEN** the first receives no response headers before about 2000ms and then status 504 with the default `json` body; the second's connection is released without a late write, and `close` resolves without leaked sockets or timers

#### Scenario: Hang and cut
- **WHEN** one request carries `WORKBUDDY_FAKE_HANG` and another `WORKBUDDY_FAKE_CUT`
- **THEN** the first receives no response headers until the client aborts, after which `close` resolves without leaked sockets; the second receives status 200, an SSE header and exactly the two deltas `你好，` and `半句`, then the socket closes without a finish reason or `[DONE]`

#### Scenario: Models listing for probes
- **WHEN** a fixture instance receives GET /models with the expected bearer, then GET /v1/models with bearer `leak-0001`, then (an instance started with `modelsStatus: 503`) GET /models with the expected bearer
- **THEN** the answers are 200 with the fixed one-model list, 401 whose `error.message` is `bad key leak-0001`, and 503 with the scripted error body; `modelsRequests()` of the first instance deep-equals `[{authorization:"Bearer fake"},{authorization:"Bearer leak-0001"}]`; chat-completions behaviour and `requests()` are unchanged

### Requirement: 透传端点与 bearer 鉴权
app-server SHALL expose POST /v1/chat/completions through registerModelProxy(app,{tokens,models}), where `models` is the caller-supplied lookup `{lookup(id:string): {upstream?:{baseUrl,apiKey}}|undefined, secrets(): readonly string[]}` (a registered model without an upstream is `{}` — no `upstream` key) over the model whitelist (model-registry「注册表快照是白名单的唯一来源」: the registry snapshot in production; an assembly without `models` — and `app.ts` without any assembly — is adapted through `staticRegistry(assembly?.modelCatalog ?? <static single-model catalog>, assembly?.upstream)` from `server/src/model-proxy/lookup.ts`, which keeps `modelCatalog` / `upstream` as the static test seam and implements the same interface as the registry). `lookup` SHALL be called per request at forwarding time and never cached by the proxy; `secrets()` SHALL return every registered upstream's apiKey and base URL parts at that moment (the sanitising key set). model-proxy SHALL NOT read the environment, import the whitelist resolver or the registry store, and SHALL NOT hold a per-registration upstream. model-proxy SHALL own TokenLookup={lookup(token:string):string|null}; it SHALL NOT import sessions or implement TokenRegistry. Canonical typed errors SHALL come from core/errors, with the existing HTTP mapper supplied by the caller.
Authorization SHALL carry a64hex bearer whose exact lookup hits a live runtime. Missing, malformed, unknown or revoked bearer SHALL return401 unauthorized with no upstream request. Authentication SHALL precede body parsing. There is no registration-time upstream check any more: after the body checks and the whitelist check below, a looked-up model whose route has no `upstream` yields 502 agent_unavailable with zero upstream requests (the pre-s1d answer for an installation without `MODEL_UPSTREAM_*`, now per model). Every proxy response, including errors, SHALL carry Cache-Control:no-store without changing sibling cache/guard policy.
Authenticated requests SHALL accept JSON media/syntax with a4MiB raw-byte limit and forward the original body bytes and content-type to the looked-up model's baseURL plus /chat/completions. InvalidJSON/unsupportedmedia/overlimit SHALL produce400 bad_request before upstream contact.
**Model whitelist.** As part of that same body validation — which applies to authenticated requests: after authentication and after the media, size and JSON-syntax checks, before the per-model upstream check and before any upstream contact — the proxy SHALL require the body's top-level JSON value to be an object holding exactly one member whose key, after JSON string unescaping, equals `model`, and that member's value to be a JSON string equal, code unit for code unit (no trimming, no case folding, no Unicode normalization), to a model id for which `models.lookup` returns a route. A top-level value that is not an object, a missing `model`, two or more members whose decoded keys equal `model` (whatever their values: JSON parsers disagree on which duplicate wins and the body is forwarded verbatim, so a duplicate would let the upstream read a different model than the one checked), a `model` that is not a string, and a string for which `lookup` returns undefined SHALL each produce the same 400 bad_request envelope with no-store and zero upstream requests; the response and any diagnostic SHALL NOT echo the offered model name. Order (changed by s1d-model-registry): a valid token with a malformed body or an unregistered model answers 400 whether or not any upstream exists; only a registered model without an upstream answers 502 agent_unavailable. The route returned by the `lookup` that passed is the one forwarded to: a registry change after that call SHALL NOT affect the in-flight request or its streamed response. Only the top-level member keys and the `model` value are read: nested `model` members are ignored, the request's `stream` member is not read, and the rule is the same for streaming and non-streaming requests (the response path is unchanged). A body that passes SHALL still be forwarded as its original bytes. Apart from this check, no message-semantic parsing, body reserialization or message logging is permitted. Upstream Authorization SHALL be replaced with `Bearer <that model's apiKey>`; client bearer/cookie SHALL NOT be forwarded as headers.
Non5xx upstream status, content-type and opaque body bytes SHALL be streamed in order without waiting for the complete response; the proxy SHALL NOT follow redirects or transform response body bytes. **上游失败摘要（#909）。** 代理自己生成的上游失败应答 SHALL 是 `{"error":{"message":<一行人读中文>,"type":"wb_upstream","param":<种类>}}`（`application/json`，no-store，无 `code` 键），分两组五种。

可重试的两种（状态 502，omp 照常重试）：
- HTTP ≥500 且不是 504、524：代理 SHALL 读取上游错误正文的前至多 16 KiB，且自收到响应头起至多 5000ms（先到者为准；`content-encoding` 既非缺省也非 `identity` 时不读），随后释放上游响应；`param` 为 `status.<上游状态码>`，`message` 为 `模型服务返回 HTTP <上游状态码>：<节选>`（节选为空时为 `模型服务返回 HTTP <上游状态码>`）。节选 = 按 UTF-8 解码（非法序列替换为 U+FFFD）后经 upstream-failure「上游原文净化」（密钥集为 `models.secrets()`——此刻全部已登记上游的 apiKey 与 base URL 各部分——并上本请求转发所用 route 自己的 apiKey 与 base URL 各部分，在途期间换密钥或删模型时旧值仍被净化）、读取未到上游正文结尾即停止（字节上限、时间上限、出错或连接关闭）时，在整串密钥替换之后再丢掉末尾恰为某个密钥开头一段——按该开头经同一轮整串替换后的形状比较（较短的密钥嵌在较长密钥被截断的开头里时先被替换）——或不足 16 位的 `sk-…` 的部分（#1427 评审补入）、换行与制表符折成单个空格、截到至多 1000 码点（超出时保留前 994 个码点并接 `…（已截断）`）。
- 传输建立前的连接失败（被拒、重置、DNS 失败等）或构造上游请求时同步抛错：`param` 为 `connect.<原因码>`，`message` 为 `无法连接模型服务（<原因码>）`；原因码取 Node 错误的 `code` 中 `[A-Z0-9_]` 字符（至多 64 个），取不到时为 `UNKNOWN`。

不可重试的三种（状态 424，正文逐字节固定，不带上游正文的任何部分）：
- 建连期限：自发起连接起，在 `connectDeadlineMs` 内未建立相应传输（DNS/TCP/TLS）时，代理 SHALL 释放该上游请求并应答 `{"error":{"message":"模型服务在 10 秒内没有建立连接","type":"wb_upstream","param":"no_connect"}}`。
- 上游网关超时：上游以 504 或 524 应答时，代理 SHALL 不读其正文、释放上游响应并应答 `{"error":{"message":"模型服务的网关等待模型超时","type":"wb_upstream","param":"gateway_<上游状态码>"}}`。
- 首字节期限：自发出上游请求起，在 `firstByteDeadlineMs` 内未收到上游响应头时，代理 SHALL 释放该上游请求并应答 `{"error":{"message":"模型服务在 120 秒内没有返回响应","type":"wb_upstream","param":"no_response"}}`。

`connectDeadlineMs`（缺省 10000）与 `firstByteDeadlineMs`（缺省 120000）是 `registerModelProxy` 的可选项；生产装配 SHALL NOT 传它们，本模块 SHALL NOT 从环境读取它们。建连计时器 SHALL 在传输建立时结束，与首字节期限并存；收到响应头之后不再计时：已经开始的响应 SHALL NOT 受任何期限约束。504 / 524 在首字节期限之后才到时，首字节期限的应答已经发出。
424、它的三份正文与种类名对 omp v18.12.3 核过：传输层、provider 层与会话层都不重试它。可重试（Transient/Timeout）一面的主因是 v18.12.3 的 4xx 终止闸——`isTerminalClientErrorStatus`（`packages/ai/src/error/flags.ts:614-616`，`400 ≤ status < 500` 且非 408/429）让 424 跳过文本的 Transient/Timeout 判定（`:677-695`；状态取自 HTTP 响应，不是文本前缀；闸外另有少数英文专用判定——`:630`（`isMalformedFunctionCallText`，无 api 闸，经 `retriable()` `:495` 放行、不在 `RETRIABLE_KINDS`）、`:631`（`isProviderFinishErrorText`，无 api 闸）、`:632`、`:661-669`、`:700`、`:701-703`（`StaleResponsesItem`，仅 responses / codex-responses api）、`:706`（`isCodexSteerRejection`，仅 codex-responses api）——424 中文正文不命中），第二层是正文与种类名不含 `TIMEOUT_PATTERN` / `TRANSIENT_TRANSPORT_PATTERN`（`:168` / `:229-230`）命中的词（`timeout`、`timed out`、独立的 `429|500|502|503|504` 等）；鉴权一面不受闸约束，`AUTH_FAILURE_PATTERN`（`:231-232`）对任何状态都检查，所以正文与种类名不含它命中的词是唯一一层。三条正则由 `upstream-failure-sanitize.test.ts` 以逐字拷贝守住；升级 omp 时重抄这三条并重验（#909 design D6、D7；#1586）。No retries are added.
Before downstream commitment, upstream transport failure SHALL map to the 502 `connect.*` answer above (connection-deadline expiry: the `no_connect` 424 answer; first-byte expiry: the `no_response` 424 answer); after commitment, it SHALL terminate the failed stream without appending a JSON error or falseDONE. Downstream cancellation and app shutdown SHALL release owned upstream requests/responses/timers/connections, including pending header acquisition. Generated errors/diagnostics SHALL NOT expose keys or sessionbearers; raw upstream error detail SHALL appear only as the sanitised, truncated excerpt of a retryable ≥500 answer defined above. The module SHALL NOT register product startup assembly, models.yml or cookie-auth exemptions.

#### Scenario: Invalid bearer never reaches upstream
- WHEN Authorization is missing, malformed/non64hex, unknown or revoked, including malformed bodies and models without an upstream
- THEN401 unauthorized and no-store are returned before parsing, with zero upstream requests

#### Scenario: Missing configuration after valid authentication
- WHEN a valid token names a registered model whose route has no `upstream`; another request names an unregistered model; a third sends malformed JSON — all against a lookup in which no model has an upstream
- THEN the first answers 502 agent_unavailable, the second and third answer 400 bad_request, all with no-store and zero upstream requests, without throwing during module registration or affecting siblinghealth

#### Scenario: Per-model routing
- WHEN the lookup maps `m1` to fake upstream A (key sentinel A) and `m2` to fake upstream B (key sentinel B), and a valid token sends one request naming each, then B answers 500 with a body echoing key sentinel A, A's base URL, key sentinel B and B's base URL
- THEN A receives exactly the `m1` request with `Bearer <A>` and B exactly the `m2` request with `Bearer <B>`; the 502 excerpt for B's failure contains none of the four values; application output contains neither sentinel

#### Scenario: The forwarding route's own secrets are sanitised
- WHEN `secrets()` returns an empty list (the route was removed after `lookup` passed), and the looked-up upstream answers 500 with a body echoing that route's apiKey and base URL
- THEN the 502 excerpt contains neither value

#### Scenario: Lookup change does not touch an in-flight stream
- WHEN a streaming request naming `m1` is being forwarded and the lookup then stops returning `m1` (and a second request naming `m1` arrives)
- THEN the first response streams to completion from the original upstream; the second answers 400 bad_request with zero upstream requests

#### Scenario: Byte-preserving credential substitution
- WHEN a valid token sends JSON containing a whitelisted `model`, distinct whitespace, escape spelling and multibyte text with an explicit JSON content-type
- THEN the recording real upstream receives identical bytes/content-type and the configured APIkey bearer, never the incoming bearer/cookie as forwardedheaders

#### Scenario: Real two-round fake model
- WHEN authenticated requests naming the whitelisted model reach the #88 fake-upstream through the proxy, first without tool role and then with tool result
- THEN its bash toolcall round and exact multievent Chinese reply/DONE reach the client unchanged; the proxy does not interpret tool/message semantics

#### Scenario: Incremental non5xx passthrough
- WHEN a real upstream emits the first bytes then holds the response open until the downstream observes them
- THEN the client observes those bytes before upstreamcompletion, subsequent bytes preserve order/exactvalue, and non5xx status/content-type (including non200 such as429) remain unchanged withno-store

#### Scenario: Upstream failures normalized
- WHEN upstream returns HTTP500 or 503, or refuses connection
- THEN each answer is the local 502 `wb_upstream` envelope with no-store (`param` `status.500`, `status.503`, `connect.ECONNREFUSED` respectively) instead of the raw upstream body, without leaked credentials or successfulstreamcompletion

#### Scenario: Slow failures answer 424
- **WHEN** the proxy is registered with `connectDeadlineMs` 300 and its upstream base URL is `https://127.0.0.1:<port>` of a local listener that accepts TCP and never writes (the TLS handshake stalls)
- **THEN** the client response is 424 with exactly the `no_connect` body and no-store at about 300ms; the listener's socket is released and no further connection is made
- **WHEN** the fake upstream is driven with `WORKBUDDY_FAKE_STATUS=504 WORKBUDDY_FAKE_BODY=secret WORKBUDDY_FAKE_DELAY=200`, and separately with `WORKBUDDY_FAKE_STATUS=524 WORKBUDDY_FAKE_BODY=text`
- **THEN** each client response is 424 with exactly the `gateway_504` / `gateway_524` body and no-store at about 200ms / immediately; neither response contains the configured key, `leak-token-0123456789`, `524 ` or any other byte of the upstream body; the upstream response is released and each case made exactly one upstream request
- **WHEN** the proxy is registered through the production assembly
- **THEN** the effective connection deadline is 10000ms and no environment key changes it

#### Scenario: Parser byte limit and sibling isolation
- WHEN a configured authenticated request is malformedJSON, unsupportedmedia or exceeds4MiB rawbytes
- THEN400 bad_request/no-store occurs before upstreamcontact; a validJSON request of exactly4MiB carrying a whitelisted `model` is forwarded byte-identically
- WHEN siblingauth/API routes parse requests after proxy registration
- THEN their existing parser/bodylimit/guard/cache behavior is unchanged; /v1 does not require a cookie or broadenpublicexemptions

#### Scenario: Cancellation and late stream failure
- WHEN the downstream disconnects, appclose occurs while an upstream is pending, or upstream resets after responsebytes have begun
- THEN owned upstream work settles/reclaims without unhandled errors or hangs; late failure closes the downstream stream rather than producing a forgedJSON envelope orDONE

#### Scenario: Long established stream
- WHEN a response has begun normally and remains open beyond10seconds
- THEN the connection-establishment deadline does not cut it off; normal completion or clientcancellation still performs cleanup

#### Scenario: Established transport with delayed headers
- WHEN the appropriate transport connection is already established but the model has not yet sent response headers after10seconds
- THEN this connection timer SHALL NOT produce502 or424 or cancel the request; headers arriving before the first-byte deadline and the body after them pass normally, while clientdisconnect/appclose still cancel owned pending work

#### Scenario: Model outside the whitelist is refused
- **WHEN** the lookup registers exactly `m1` and `m3`, each with an upstream and a valid token posts, each once with `"stream":true` and once without it, the bodies `{"model":"m2","messages":[]}`, `{"model":"M1","messages":[]}`, `{"model":" m1","messages":[]}`, `{"messages":[]}`, `{"model":1}`, `{"model":null}`, `{"model":["m1"]}`, `["m1"]`, `"m1"`, `{"model":"m1","model":"other"}`, `{"model":"other","model":"m1"}` and `{"model":"other","mod\u0065l":"m1"}` to a proxy whose recording real upstream is configured
- **THEN** every response is 400 `{"error":{"code":"bad_request","message":"请求格式不正确"}}` with no-store; the recording upstream has received zero requests; no response body contains `m2`, `M1` or `other`

#### Scenario: Whitelisted model is forwarded untouched
- **WHEN** with the same lookup a valid token posts `{ "stream" : true, "metadata":{"model":"other"}, "mod\u0065l" : "m3", "messages":[{"role":"user","content":"你好"}] }` (unusual whitespace, an escaped spelling of the single top-level `model` key, a nested `model` member) and, separately, the same body without `stream`
- **THEN** the recording upstream receives each body byte-identically with the configured API-key bearer, and the upstream's streamed and non-streamed responses reach the client unchanged

#### Scenario: Default single-model whitelist
- **WHEN** the server starts without `MODEL_CATALOG` and with `MODEL_ID` unset, and a live session bearer posts a body naming `deepseek-v4.1-flash`, then one naming `gpt-x`
- **THEN** the first is forwarded and the second is 400 bad_request with zero additional upstream requests; real omp turns in `make smoke` (whose managed `models.yml` names only whitelisted ids) complete as before

#### Scenario: 5xx summary carries status and a sanitised excerpt
- **WHEN** the recording upstream answers `500` with a `text/plain` body carrying the same secrets as the fake upstream's `secret` body, each on its own line (incl. a real line `raw-http-request=/tmp/leak.json` — inside the `secret` JSON body that line is JSON-escaped, so it only becomes a real line after omp parses the JSON, which is where the session-side sanitiser removes it) (the proxy's base URL is `http://u:p4ss-secret@127.0.0.1:<port>/tenant-0123456789/v1` and the body additionally echoes that base URL, `p4ss-secret` and `tenant-0123456789`), and separately `503` with `text/plain` `503 Service Unavailable`, and separately `502` with a 20000-codepoint body containing newlines
- **THEN** each client response is 502 `{"error":{"message":…,"type":"wb_upstream","param":"status.<s>"}}` with no-store; the first message contains neither the configured key, nor `leak-token-0123456789`, nor `sk-leakleakleakleakleak`, nor `raw-http-request=`, nor `p4ss-secret`, nor `tenant-0123456789`; the second message is exactly `模型服务返回 HTTP 503：503 Service Unavailable`; the third message has no line break and its excerpt is exactly 1000 codepoints including the truncation mark

#### Scenario: First-byte deadline answers 424
- **WHEN** the proxy is registered with `firstByteDeadlineMs` 300 and the upstream accepts the request but sends no headers, and separately the upstream sends headers after 200ms and then streams for 2s
- **THEN** the first client response is 424 with exactly the no_response body and no-store at about 300ms, the upstream request is released and no further upstream request is made; the second streams to completion unaffected by the deadline
- **WHEN** the proxy is registered through the production assembly
- **THEN** the effective deadline is 120000ms and no environment key changes it

#### Scenario: Below-500 answers stay opaque
- **WHEN** the upstream answers `401`, `404` and `429` JSON bodies and a `400` empty body
- **THEN** status, content-type and body bytes reach the client unchanged, exactly as before this change

### Requirement: 托管 models.yml
The model-proxy module SHALL export deriveProxyBaseUrl(address:AddressInfo):string and writeManagedModelsYml(agentDir,{proxyBaseUrl,models}):Promise<void> where `models` is the non-empty ordered model whitelist (model-selection「模型白名单配置」), each element `{id,name,reasoning,vision,maxTokens,efforts?}` (model-selection「模型白名单配置」的白名单项，`maxTokens` 恒有) (the server always passes the whole resolved whitelist; an empty array rejects without touching the file). Actual TCP listen addresses SHALL map wildcard0.0.0.0 to127.0.0.1 and wildcard:: to::1; explicit IPv4/IPv6 SHALL be retained, IPv6 enclosed in brackets, actual port used and /v1 appended with http scheme.
The writer SHALL NOT create agentDir or any parent — the directory is established by omp-runtime「OMP_STATE_DIR 托管布局」 before the writer runs, and a missing agentDir rejects — and SHALL deterministically replace agentDir/models.yml — by writing a fresh temporary file in agentDir (created exclusively, never through an existing path) with mode exactly `0640` regardless of the process umask and renaming it over `models.yml`, so that a symlink or foreign file planted at `models.yml` is replaced rather than followed or written through, and no partially written file is ever visible; a failed write SHALL leave no temporary file behind — with block YAML containing providers.workbuddy: api openai-completions, supplied proxyBaseUrl, literal apiKey WORKBUDDY_MODEL_TOKEN, and exactly one model entry per element of `models`, in array order and with no other entry, each holding the element's `id`, its `name`, contextWindow 128000 (the same for every model), maxTokens equal to the element's `maxTokens` (model-selection「模型白名单配置」: 32768 by default, per model via `MODEL_CATALOG`), and then — always, for every element (#1563) — a `reasoning` key: `reasoning: true` followed by a `compat` mapping holding exactly `reasoningContentField: reasoning_content` when the element's `reasoning` is true, or `reasoning: false` alone when it is false. After those keys, an element that carries `efforts` SHALL add a `thinking` mapping holding exactly `mode: effort` and `efforts` as a block list of the element's values in their given order (an element without `efforts` has no `thinking` key), and then — always, for every element — `input` as a block list: exactly `text` when the element's `vision` is false, exactly `text` then `image` when it is true (`thinking` before `input`). The two keys are written unconditionally because omp v18.12.3 resolves a custom model against its built-in catalog by id and takes every omitted field (`input`, `reasoning`, `thinking`, `cost`, `contextWindow`, `maxTokens`, …) from the catalog entry (`config/custom-models.ts` `finalizeCustomModel`): the catalog lists `deepseek-v4.1-flash` as `[text, image]`, so a host that omits `input` for a `vision: false` model gets a model that claims image input, and a host that omits `reasoning` can get the catalog's value; an explicit value is never overridden (pinned by the official-binary case of model-selection「模型与强度从下一条消息起生效」). Every reasoning element that comes from `MODEL_CATALOG` carries `efforts` by construction (model-selection「模型白名单配置」 rejects a `reasoning: true` element without it at startup), so every such entry has a `thinking` mapping; the only reasoning element without `efforts`, and therefore the only reasoning entry without a `thinking` key, is the single element of an installation that sets no `MODEL_CATALOG`. Since `MODEL_VISION` defaults to `on` (owner 2026-10-18, #912), an installation that sets neither `MODEL_CATALOG` nor `MODEL_VISION` passes that element with `vision` true, so its entry carries `input: [text, image]`; `MODEL_VISION=off` yields `input: [text]`. The `reasoning`, `thinking` and `input` keys are consumed by omp without schema validation on the host side: their acceptance by omp v18.12.3 and their effect on `get_available_models` are pinned by the official-binary comparison case of model-selection「模型与强度从下一条消息起生效」 and SHALL be re-verified on an omp upgrade; for the `MODEL_CATALOG`-unset entry, which has no `thinking` key, omp derives an effort set of its own from the model id (model-selection「推理强度集合」). The reasoning declaration only tells omp the model is a reasoning model on the request side (thinking/effort parameters, and replaying stored thinking into multi-turn history under the `compat.reasoningContentField` name, which DeepSeek-style upstreams validate); it SHALL NOT be relied on to gate the host thinking pipeline, because omp parses `reasoning_content`/`reasoning`/`reasoning_text` response deltas into thinking frames regardless of it (thinking-fold). The mapping from environment variables `MODEL_REASONING` and `MODEL_VISION` (each `on` default → true, `off` → false, any other value including empty rejected at startup with an error naming the variable) and the parsing of `MODEL_CATALOG` into the whitelist belong to startup assembly (`server/src/agent-config.ts`), not to this module: the writer receives the resolved whitelist and performs no validation of its own beyond rejecting an empty array. It SHALL NOT write authHeader or read/expand parent environment credentials. Supplied string values SHALL remain strings and SHALL NOT inject YAML properties. Identical inputs SHALL produce identical bytes; changed inputs SHALL replace obsolete managed content. Filesystem failures SHALL reject rather than report success. Startup invocation after listen remains a later assembly responsibility, not this module's side effect.

#### Scenario: Connectable address derivation
- WHEN the actual listener address is0.0.0.0:18016 or IPv6:::18016
- THEN URLs are http://127.0.0.1:18016/v1 and http://[::1]:18016/v1 respectively
- WHEN an explicit IPv4 or IPv6 address is supplied
- THEN that address and actual port are retained with correct IPv6 brackets

#### Scenario: Credential-safe managed output
- WHEN generation runs with proxyBaseUrl http://127.0.0.1:18016/v1 and the single-model whitelist `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:false,vision:false,maxTokens:32768}]` while parent upstream/token environment sentinels exist
- THEN parsed output contains only the declared workbuddy provider/model, literal env-name apiKey, required limits, `reasoning: false` with no `compat` key, `input: ["text"]` and no authHeader; file content contains none of the unrelated sentinel values

#### Scenario: Deterministic overwrite and escaped model identity
- WHEN identical options are written twice, then a single-model whitelist whose id and name contain quotes, newline and YAML-significant characters is written
- THEN the first two files are byte-identical and the final parsed file preserves the exact new id/name without extra keys/providers or stale model entries
- WHEN the same single-model whitelist is written with its `reasoning` true and then false
- THEN the second file contains `reasoning: false`, no `compat` key and no stale `reasoningContentField` line

#### Scenario: Real filesystem ownership
- WHEN agentDir exists and holds no models.yml
- THEN models.yml is created and readable after the promise resolves
- WHEN agentDir does not exist, or is a regular file
- THEN the promise rejects and unrelated files remain unchanged

#### Scenario: Reasoning declaration toggles
- WHEN generation runs with the single model deepseek-v4.1-flash whose `reasoning` is true, then false
- THEN the first parsed model entry has `reasoning: true` and `compat: {reasoningContentField: "reasoning_content"}`, the second has `reasoning: false` and no `compat` key; both have `input` and no other added key, both are accepted by omp's models.yml schema; each variant written twice is byte-identical
- WHEN startup reads `MODEL_REASONING` unset, `on`, `off`, empty and `yes`
- THEN the single model passed to the writer has `reasoning` true, true and false respectively, and empty or `yes` fails startup before models.yml is written, naming `MODEL_REASONING` without echoing unrelated environment values

#### Scenario: Planted link is replaced and the mode is fixed
- **WHEN** `agentDir/models.yml` is a symlink to a file outside agentDir and the writer runs under umask `000` and again under umask `077`
- **THEN** both times `models.yml` is a regular file of mode `0640` holding the managed content, the outside file is byte-identical to before, and agentDir holds no leftover temporary file

#### Scenario: Several models in whitelist order
- **WHEN** generation runs with the whitelist `[{id:"m1",name:"通用",reasoning:true,vision:false,maxTokens:32768,efforts:["minimal","low","medium","high","xhigh","max"]},{id:"m2",name:"m2",reasoning:false,vision:false,maxTokens:8192},{id:"m3",name:"深度",reasoning:true,vision:true,maxTokens:32768,efforts:["low","high"]}]`, then again with only `[{id:"m2",name:"m2",reasoning:false,vision:false,maxTokens:8192}]`
- **THEN** the first parsed file has exactly one provider `workbuddy` whose `models` are three entries in that order: `m1` with name `通用`, `contextWindow: 128000`, `maxTokens: 32768`, `reasoning: true`, `compat: {reasoningContentField: "reasoning_content"}`, `thinking: {mode: "effort", efforts: ["minimal","low","medium","high","xhigh","max"]}` and `input: ["text"]`; `m2` with `contextWindow: 128000`, `maxTokens: 8192`, `reasoning: false`, `input: ["text"]` and no `compat` or `thinking` key; `m3` with name `深度`, `contextWindow: 128000`, `maxTokens: 32768`, the reasoning keys, `thinking: {mode: "effort", efforts: ["low","high"]}` and `input: ["text","image"]`; writing the same whitelist twice is byte-identical; the second file holds the single `m2` entry and no line of `m1` or `m3` remains

#### Scenario: Single-model output is unchanged
- **WHEN** generation runs with the whitelist of an installation that sets no `MODEL_CATALOG` and sets `MODEL_VISION=off` — `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:false,maxTokens:32768}]` (no `efforts`) — and with the same element whose `reasoning` is false, and the results are compared with two new fixture files checked in by #1563 beside the test (reasoning true / false; `maxTokens: 32768`, an explicit `reasoning` line in both, `input:` / `- text` after the reasoning keys)
- **THEN** (title retained from the pre-#1563 spec; "unchanged" now means byte-identical to the #1563 fixture files) both outputs are byte-identical to their fixture file; and against the pre-#1563 fixtures the test already holds (`reasoningYaml` / `plainYaml`, which carry `maxTokens: 8192`), after the same `maxTokens: 8192` → `maxTokens: 32768` line substitution the pre-#1563 test applied, the new reasoning-true output is the old one with exactly two lines inserted (`  input:` and `  - text` after the `compat` mapping) and the new reasoning-false output is the old one with exactly three lines inserted (`  reasoning: false` after `maxTokens`, then the same two `input` lines), every other line byte-identical and in the same order (compared as line sequences, insertions only)
- **WHEN** generation runs with an empty whitelist
- **THEN** the promise rejects and an existing `models.yml` is left unchanged

#### Scenario: maxTokens reaches the upstream request
- **WHEN** the official pinned omp 18.12.3 binary is started against the fake upstream with a managed `models.yml` whose model entry carries `maxTokens: 32768`, and one prompt turn runs; another run uses an entry with `maxTokens: 8192`
- **THEN** every entry the fake upstream records for that turn (omp-test-harness「受控上游请求记录」) has `maxTokens` equal to 32768, and 8192 in the second run — omp passes these two values through rather than dropping or clamping them (the clamp ceiling and the field name omp sends for this provider are re-verified on v18.12.3 by the implementation PR and recorded there)

#### Scenario: Single-model default declares image input
- **WHEN** generation runs with `[{id:"deepseek-v4.1-flash",name:"deepseek-v4.1-flash",reasoning:true,vision:true,maxTokens:32768}]`, and with the same element whose `reasoning` is false
- **THEN** each output equals the corresponding vision-false output of「Single-model output is unchanged」with exactly one line added at the end of the `input` list — `- image` at the indentation of the list items — and no other line changed; the parsed entry's `input` is `["text","image"]`
- **WHEN** startup reads `MODEL_VISION` unset, `on` and `off` with `MODEL_CATALOG` unset
- **THEN** the single model passed to the writer has `vision` true, true and false respectively

### Requirement: 会话 bearer 登记与轮换
TokenRegistry SHALL expose issue(sessionId:string):string, lookup(token:string):string|null and revoke(sessionId:string):void. It SHALL be structurally compatible with the existing proxy TokenLookup and runtime SessionTokens ports without reversing the proxy→sessions dependency boundary. Registry state SHALL be private, process-local and isolated per instance, with one live token per session and one session per live token.
issue SHALL acquire32 cryptographically random bytes from node:crypto randomBytes and encode64lowercasehex characters.1000 real issuances SHALL have the required shape and no repeats. Successful same-session issuance SHALL replace the old token atomically; lookup of the old token SHALL immediately returnnull and the new token SHALL identify that session. Other sessions SHALL remain unchanged.
lookup SHALL match the exact opaque token string and returnnull for unknown/empty/malformed/altered-case/revoked values. revoke SHALL invalidate the current token for that session; unknown or repeated revocation SHALL be harmless. Lookup and revocation SHALL use indexed state rather than scanning all tokens.
Entropy failure or a candidate colliding with any currently live token SHALL throw without modifying either existing binding or publishing a new one; errors SHALL not include credential values and there SHALL be no insecure fallback or implicit retry. The registry SHALL NOT retain an unbounded history of revoked tokens, read configuration/upstream keys, perform IO, start timers or log credentials. Runtime lifecycle and proxy route assembly remain outside this slice.

#### Scenario: Random opaque issuance
- WHEN 1000 distinct sessions obtain tokens from a fresh registry using real Node crypto
- THEN every token matches64lowercasehex, all are distinct and each lookup returns its original session

#### Scenario: Rotation, revocation and isolation
- WHEN two sessions hold tokens and one session rotates
- THEN its old token returnsnull, its new token resolves correctly and the other session is unaffected
- WHEN that session is revoked twice, or an unknown session is revoked
- THEN no unrelated binding changes and the revoked token remains unknown
- WHEN another registry instance queries those tokens
- THEN it returnsnull

#### Scenario: Exact lookup
- WHEN a caller submits an unknown, empty, malformed or case-altered token
- THEN lookup returnsnull without modifying valid bindings

#### Scenario: Failed issuance preserves authority
- WHEN crypto throws during initial issuance or rotation, or returns a token already live for the same or another session
- THEN issue throws, no candidate is published, old/current bindings remain exact, and no credential is included in the error
- WHEN the external entropy failure is removed and issue is called again
- THEN normal issuance/rotation succeeds without stale reverse bindings

#### Scenario: Proxy port integration
- WHEN an unchanged model-proxy route receives a current registry-issued bearer and then an old/revoked bearer
- THEN the current bearer reaches the configured local upstream while the old/revoked bearer receives401 without contacting that upstream

### Requirement: 上游端点拼接
代理转发的目标 SHALL 为 model-registry「上游地址的视图形式与拼接」的 `upstreamEndpoint(<该模型的 baseUrl>, "chat/completions")`：路径去掉结尾斜杠后接 `/chat/completions`，查询串保留、fragment 丢弃；不带查询串的 base URL（`…/v1`、`…/v1/`、无路径）的转发目标与此前逐字相同。

#### Scenario: 带查询串的上游
- **WHEN** 登记模型的上游地址为 `http://127.0.0.1:<port>/v1?org=a`（测试内记录请求行的服务），有效 token 以该模型发一次请求
- **THEN** 上游收到恰一个请求，请求行路径为 `/v1/chat/completions?org=a`，bearer 为该模型密钥
