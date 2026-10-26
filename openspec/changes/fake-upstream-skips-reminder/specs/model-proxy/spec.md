# model-proxy Spec Delta

> fake-upstream-skips-reminder（#1769）：假上游取「最后一条 user 消息」时跳过 omp 的日期 / cwd 提醒（整段恰为一个 `<system-reminder>` 块的 user 消息），与已有的图片附件消息同样处理。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 假上游夹具契约
`server/test/support/fake-upstream.mjs` SHALL be a zero-dependency local OpenAI-compatible streaming fixture, importable through `start({port?,apiKey?})` and runnable directly by Node. It SHALL expose the actual bound port and asynchronous close, default to loopback/random port and expected bearer key `fake`, and permit an in-process expected-key override. One handler SHALL serve POST /chat/completions and POST /v1/chat/completions to satisfy the literal fixture path and the parent CI base URL, and (change s1d-model-registry, for model-registry「探活」) GET /models and GET /v1/models: with the expected bearer it answers 200 `application/json` `{"object":"list","data":[{"id":"fake-model","object":"model"}]}` unless the in-process option `start({modelsStatus})` names a status 400–599, in which case it answers that status with `{"error":{"message":"scripted models <status>","type":"scripted_error"}}`; every GET /models request (accepted or 401) is appended to the handle's `modelsRequests()` record as `{authorization: <header or null>}`. Missing/wrong Authorization SHALL return401 JSON; on the two GET /models routes only, that 401's `error.message` is `bad key <offered bearer or none>` (echoing the offered value, so probe-sanitising tests have a sentinel to look for) — the chat-completions 401 body is unchanged and never echoes credentials. For authenticated requests, the last user message containing WORKBUDDY_FAKE_ERROR SHALL return500 OpenAI-shaped JSON before any streaming branch. Otherwise, unless one of the failure markers below applies, messages without role:tool SHALL receive one streamed bash tool call with arguments {"command":"echo workbuddy-smoke"} and finish_reason:tool_calls; messages with role:tool SHALL receive at least three content deltas concatenating exactly to `你好，这是 WorkBuddy 的第一条流式回复。`, with finish_reason:stop. Successful streams SHALL use OpenAI chat.completion.chunk records and end with data: [DONE]. CLI SHALL honor FAKE_UPSTREAM_PORT, report actual readiness without credentials, and release resources on termination.

**「最后一条 user 消息」的取法**（#1769）。本要求与 omp-test-harness 里凡以「最后一条 user 消息」判定的规则（标记查找、`toolRoundScope:"turn"` 的轮次规则）SHALL 从 messages 末尾往前取第一条**真实**的 user 消息：跳过 omp 合成的图片附件消息（omp-test-harness「受控上游浏览器标记」），也跳过整段文本（字符串 content，或数组 content 的全部 text 部分依次拼接）去掉首尾空白后恰为一个 `<system-reminder>…</system-reminder>` 块的 user 消息——omp v18.12.3 在本地日期变化时往上下文末尾追加日期 / cwd 提醒，代理上游不支持 developer 角色时以 `user` 角色发出（`date-cwd-reminder.ts`、`openai-completions.ts`）；它不是用户回合，不带也不清除任何标记。带其它文字、或含两个及以上 `<system-reminder>` 块的 user 消息照常算作 user 消息。`WORKBUDDY_FAKE_FAIL_TIMES` 的计数键是这样取到的那条消息的文本。

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

#### Scenario: omp 的日期提醒不算最后一条 user 消息
- **WHEN** 一个实例收到 `user("WORKBUDDY_FAKE_STATUS=503") → user("<system-reminder>\nToday: 2026-10-26; current working directory: '/w'.\n</system-reminder>")`；另一请求为 `user("WORKBUDDY_FAKE_ERROR") → user(<同形提醒>)`；另一组以同一首条 `WORKBUDDY_FAKE_STATUS=503 WORKBUDDY_FAKE_FAIL_TIMES=2` 发四次，其中第二、三次末尾带提醒；另一实例以 `toolRoundScope:"turn"` 收到 `user("跑一下") → assistant(tool_calls) → tool → user(<同形提醒>)`
- **THEN** 第一例 503、第二例 500（与不带提醒时逐字相同）；第三组依次 503、503、按无标记处理、按无标记处理（计数与不带提醒时相同）；第四例流式最终回复而非新的工具调用（提醒不开启新回合）；末尾 user 消息为 `"<system-reminder>…</system-reminder> 另有文字"` 时它照常是最后一条 user 消息
