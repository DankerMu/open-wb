# model-proxy Specification

## Purpose
定义模型代理集成使用的离线 OpenAI 兼容假上游契约，包括两轮流式响应、鉴权与错误选择、进程入口和资源回收。生产代理与托管模型配置的后续契约由各自变更增补。
## Requirements
### Requirement: 假上游夹具契约
`server/test/support/fake-upstream.mjs` SHALL be a zero-dependency local OpenAI-compatible streaming fixture, importable through `start({port?,apiKey?})` and runnable directly by Node. It SHALL expose the actual bound port and asynchronous close, default to loopback/random port and expected bearer key `fake`, and permit an in-process expected-key override. One handler SHALL serve POST /chat/completions and POST /v1/chat/completions to satisfy the literal fixture path and the parent CI base URL. Missing/wrong Authorization SHALL return401 JSON. For authenticated requests, the last user message containing WORKBUDDY_FAKE_ERROR SHALL return500 OpenAI-shaped JSON before any streaming branch. Otherwise messages without role:tool SHALL receive one streamed bash tool call with arguments {"command":"echo workbuddy-smoke"} and finish_reason:tool_calls; messages with role:tool SHALL receive at least three content deltas concatenating exactly to `你好，这是 WorkBuddy 的第一条流式回复。`, with finish_reason:stop. Successful streams SHALL use OpenAI chat.completion.chunk records and end with data: [DONE]. CLI SHALL honor FAKE_UPSTREAM_PORT, report actual readiness without credentials, and release resources on termination.

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

