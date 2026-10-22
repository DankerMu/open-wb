# model-proxy Spec Delta

> s1d-model-registry：`registerModelProxy` 改收按模型查找的 `models` 契约（design D5 / D6），取代 `allowedModels` 与单一 `upstream`；检查次序与净化密钥集随之改。只改「透传端点与 bearer 鉴权」；「托管 models.yml」的写出器契约不变（调用时机见 model-registry「变更即发布」）。

## MODIFIED Requirements

### Requirement: 透传端点与 bearer 鉴权
app-server SHALL expose POST /v1/chat/completions through registerModelProxy(app,{tokens,models}), where `models` is the caller-supplied lookup `{lookup(id:string): {upstream:{baseUrl,apiKey}|undefined}|undefined, secrets(): readonly string[]}` over the model whitelist (model-registry「注册表快照是白名单的唯一来源」: the registry snapshot in production; `app.ts` without an assembly adapts the static catalog and the optional single upstream through `lookupFromCatalog`). `lookup` SHALL be called per request at forwarding time and never cached by the proxy; `secrets()` SHALL return every registered upstream's apiKey and base URL parts at that moment (the sanitising key set). model-proxy SHALL NOT read the environment, import the whitelist resolver or the registry store, and SHALL NOT hold a per-registration upstream. model-proxy SHALL own TokenLookup={lookup(token:string):string|null}; it SHALL NOT import sessions or implement TokenRegistry. Canonical typed errors SHALL come from core/errors, with the existing HTTP mapper supplied by the caller.
Authorization SHALL carry a64hex bearer whose exact lookup hits a live runtime. Missing, malformed, unknown or revoked bearer SHALL return401 unauthorized with no upstream request. Authentication SHALL precede body parsing. There is no registration-time upstream check any more: after the body checks and the whitelist check below, a looked-up model whose `upstream` is undefined yields 502 agent_unavailable with zero upstream requests (the pre-s1d answer for an installation without `MODEL_UPSTREAM_*`, now per model). Every proxy response, including errors, SHALL carry Cache-Control:no-store without changing sibling cache/guard policy.
Authenticated requests SHALL accept JSON media/syntax with a4MiB raw-byte limit and forward the original body bytes and content-type to the looked-up model's baseURL plus /chat/completions. InvalidJSON/unsupportedmedia/overlimit SHALL produce400 bad_request before upstream contact.
**Model whitelist.** As part of that same body validation — which applies to authenticated requests: after authentication and after the media, size and JSON-syntax checks, before the per-model upstream check and before any upstream contact — the proxy SHALL require the body's top-level JSON value to be an object holding exactly one member whose key, after JSON string unescaping, equals `model`, and that member's value to be a JSON string equal, code unit for code unit (no trimming, no case folding, no Unicode normalization), to a model id for which `models.lookup` returns a route. A top-level value that is not an object, a missing `model`, two or more members whose decoded keys equal `model` (whatever their values: JSON parsers disagree on which duplicate wins and the body is forwarded verbatim, so a duplicate would let the upstream read a different model than the one checked), a `model` that is not a string, and a string for which `lookup` returns undefined SHALL each produce the same 400 bad_request envelope with no-store and zero upstream requests; the response and any diagnostic SHALL NOT echo the offered model name. Order (changed by s1d-model-registry): a valid token with a malformed body or an unregistered model answers 400 whether or not any upstream exists; only a registered model without an upstream answers 502 agent_unavailable. The route returned by the `lookup` that passed is the one forwarded to: a registry change after that call SHALL NOT affect the in-flight request or its streamed response. Only the top-level member keys and the `model` value are read: nested `model` members are ignored, the request's `stream` member is not read, and the rule is the same for streaming and non-streaming requests (the response path is unchanged). A body that passes SHALL still be forwarded as its original bytes. Apart from this check, no message-semantic parsing, body reserialization or message logging is permitted. Upstream Authorization SHALL be replaced with `Bearer <that model's apiKey>`; client bearer/cookie SHALL NOT be forwarded as headers.
Non5xx upstream status, content-type and opaque body bytes SHALL be streamed in order without waiting for the complete response; the proxy SHALL NOT follow redirects or transform response body bytes. **上游失败摘要（#909）。** 代理自己生成的上游失败应答 SHALL 是 `{"error":{"message":<一行人读中文>,"type":"wb_upstream","param":<种类>}}`（`application/json`，no-store，无 `code` 键），分两组五种。

可重试的两种（状态 502，omp 照常重试）：
- HTTP ≥500 且不是 504、524：代理 SHALL 读取上游错误正文的前至多 16 KiB，且自收到响应头起至多 5000ms（先到者为准；`content-encoding` 既非缺省也非 `identity` 时不读），随后释放上游响应；`param` 为 `status.<上游状态码>`，`message` 为 `模型服务返回 HTTP <上游状态码>：<节选>`（节选为空时为 `模型服务返回 HTTP <上游状态码>`）。节选 = 按 UTF-8 解码（非法序列替换为 U+FFFD）后经 upstream-failure「上游原文净化」（密钥集为 `models.secrets()`——此刻全部已登记上游的 apiKey 与 base URL 各部分）、读取未到上游正文结尾即停止（字节上限、时间上限、出错或连接关闭）时，在整串密钥替换之后再丢掉末尾恰为某个密钥开头一段——按该开头经同一轮整串替换后的形状比较（较短的密钥嵌在较长密钥被截断的开头里时先被替换）——或不足 16 位的 `sk-…` 的部分（#1427 评审补入）、换行与制表符折成单个空格、截到至多 1000 码点（超出时保留前 994 个码点并接 `…（已截断）`）。
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
- WHEN the lookup maps `m1` to fake upstream A (key sentinel A) and `m2` to fake upstream B (key sentinel B), and a valid token sends one request naming each, then B answers 500 with a body echoing sentinel B
- THEN A receives exactly the `m1` request with `Bearer <A>` and B exactly the `m2` request with `Bearer <B>`; the 502 excerpt for B's failure contains neither sentinel nor either base URL; application output contains neither sentinel

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
- **WHEN** `allowedModels` is `{"m1","m3"}` and a valid token posts, each once with `"stream":true` and once without it, the bodies `{"model":"m2","messages":[]}`, `{"model":"M1","messages":[]}`, `{"model":" m1","messages":[]}`, `{"messages":[]}`, `{"model":1}`, `{"model":null}`, `{"model":["m1"]}`, `["m1"]`, `"m1"`, `{"model":"m1","model":"other"}`, `{"model":"other","model":"m1"}` and `{"model":"other","mod\u0065l":"m1"}` to a proxy whose recording real upstream is configured
- **THEN** every response is 400 `{"error":{"code":"bad_request","message":"请求格式不正确"}}` with no-store; the recording upstream has received zero requests; no response body contains `m2`, `M1` or `other`

#### Scenario: Whitelisted model is forwarded untouched
- **WHEN** with the same whitelist a valid token posts `{ "stream" : true, "metadata":{"model":"other"}, "mod\u0065l" : "m3", "messages":[{"role":"user","content":"你好"}] }` (unusual whitespace, an escaped spelling of the single top-level `model` key, a nested `model` member) and, separately, the same body without `stream`
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

