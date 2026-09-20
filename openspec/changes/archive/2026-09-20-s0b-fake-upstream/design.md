## Context
Issue #88 / parent task2.1. Governing sources: parent model-proxy spec29-36; design D9/D11; ADR0008; existing fake-omp HTTP test seams, not its constants as expected output.
OpenAI wire schema: official openai/openai-node Git blob `ab04eb836e0356a245e08347ca2b8e31397ca3fa`, ChatCompletionChunk lines1011-1219 (`id`, `created`, `model`, object=chat.completion.chunk, choices/delta/index/finish_reason, indexed function tool_calls). Source https://api.github.com/repos/openai/openai-node/git/blobs/ab04eb836e0356a245e08347ca2b8e31397ca3fa. Only wire facts are used; no upstream implementation is copied.
Governing invariant: an authenticated request deterministically follows the declared message-based branch, and its HTTP/SSE bytes, lifecycle and errors are independently observable without any real vendor or secret log.
Change surface: one test-support .mjs, paired TypeScript contract test, optional minimal .d.mts solely for strict JS-module typing.

## Goals / Non-Goals
Must preserve: no src/config/dependency/CI changes; existing fake-omp behaviors untouched; offline Node24.13.1 execution; later #98/#102/#105 can use an actual bound loopback port.
Must add: start({port?,apiKey?}) → Promise<{port:number,close():Promise<void>}>; CLI node fake-upstream.mjs; real bearer/JSON/SSE contract.
Non-goals: production proxy, token registry, actual bash execution, generic model simulation, non-streaming chat API, SDK dependency, CI harness wiring, full multimodal generation.

## Resolved Contract Details
- [T1] Credentials: default expected key is `fake` (parent D11 MODEL_UPSTREAM_API_KEY=fake); in-process apiKey override enables #102 sentinel tests. CLI needs only FAKE_UPSTREAM_PORT and default test key. Never log or echo Authorization/apiKey/request contents in errors or readiness output.
- [T1, low-risk reconciliation] Parent spec names POST /chat/completions while D11 upstream base URL includes /v1. One handler is mounted at exactly /chat/completions and /v1/chat/completions to preserve both live consumers. These are two required mount points, not duplicated implementations or an arbitrary path-rewrite shim. Other routes remain outside the fixture contract.
- [T2] Bind 127.0.0.1; port0 means OS allocation. Importing does not listen. CLI reads FAKE_UPSTREAM_PORT (unset→0), prints one JSON readiness line containing the actual port only after listen succeeds, and releases the server on SIGTERM/SIGINT. Invalid port/listen failure exits nonzero without credentials.
- [T2] TypeScript tests use existing .test.ts discovery. A declaration file may describe start's small public type if the .mjs import needs one; no any/ts-ignore or compiler relaxation to bypass the boundary.
- Auth runs before response selection. Missing/wrong canonical Bearer value gives401 JSON, never SSE. Malformed JSON or non-array messages gives400 JSON and does not crash the listener; this is a small real-HTTP failure safeguard, not a generic validator.
- Find the last role:user message, not the last array element or any historical user message. Marker WORKBUDDY_FAKE_ERROR in its text gives500 OpenAI-shaped JSON before either success branch. Support ordinary string content and OpenAI text-part content; ignore non-text parts rather than implement images.
- With no role:tool anywhere in messages, emit exactly one function tool call named bash with JSON arguments {"command":"echo workbuddy-smoke"}, terminal finish_reason=tool_calls, then data:[DONE]. With a role:tool message, emit at least3 nonempty delta.content events whose concatenation is exactly 你好，这是 WorkBuddy 的第一条流式回复。, finish_reason=stop, then data:[DONE]. No artificial user-text escape hatch may skip the tool-first branch.
- Stream HTTP200 text/event-stream with correctly delimited data records. Each JSON chunk has the canonical metadata/choice shape and a stable completion id/timestamp within that response. Assertions count SSE records, not TCP read chunks; no timing sleeps as the proof of streaming correctness.
- close() releases the listener and owned sockets, works after client abort, and is safe for repeated cleanup. Simultaneous independent instances do not share credentials or ports. Startup failure does not install persistent signal listeners.

## Seams / Evidence
Real fetch/http requests inspect status, content-type, incremental SSE records, tool-call reconstruction, exact Chinese content and DONE order. Tests never import output constants/frame builders from the fixture. Real CLI subprocess publishes a port; requests use that port; SIGTERM and native exit/port closure are observed before cleanup.
Required negative cases: missing/wrong bearer and an overridden key; marker precedence over tool/text branch; older-user marker versus last-user marker; malformed request recovery; unsupported route does not enter successful completion; occupied/invalid port; aborted client then close. Preserve semantic RED, actual exit and restored GREEN outside repo.
Independent acceptance: focused fixture tests, full server suite, lint/types/anti-drift, strict OpenSpec validation; parent CLI/HTTP smoke and fault candidates for auth, branching/marker and framing/lifecycle. No production-vendor call.
Sibling surfaces: #98 upstream URL/bearer forwarding, #102 sentinel/full proxy round, #105 standalone process/port cleanup; fake-omp call-proxy currently relays only text from one request. Its two-round integration is tracked by https://github.com/DankerMu/open-wb/issues/166 at the #102 boundary, not changed here and not a new queue dependency.

## Delivery / Risks
TDD barrier: tests are written first. Missing-module failure is setup evidence only. A minimal callable HTTP scaffold may respond deliberately wrong statuses to produce semantic RED before auth/SSE behavior is implemented; parent verifies the barrier before authorizing implementation. No retrospective stub replay in the source tree.
Risk: a fake and its tests may share invented wire assumptions → independent schema facts and literal expectations; future real-omp smoke remains #105, not claimed here.
Rollback: remove unused fixture before consumers land, or revert with its paired consumers later; no data migration. Human per-issue white-box review waived for Epic81 only; agent gates and final epic functional review remain.
