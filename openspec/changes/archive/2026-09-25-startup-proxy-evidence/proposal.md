## Why
Two #102 evidence gaps in test support, no production defect:
- #166 — the fake omp `call-proxy` relay (`server/test/support/fake-omp.mjs` `runProxy` ~:340, `postChat` ~:436, `appendSseContent`) posts one round and only keeps `delta.content`. The #88 fake upstream (`server/test/support/fake-upstream.mjs`) answers a request without a `role:"tool"` message with only `tool_calls` + `finish_reason:"tool_calls"` (spec `model-proxy` 假上游夹具契约), so fake-omp → proxy → fake-upstream yields `deltas=[]` and `completeTurn([], false)` reports a successful empty turn. call-proxy is only exercised against private text stubs (`server/test/fake-omp.test.ts`), and the existing spec scenario `http-service-skeleton` "Full proxy turn keeps both credentials out of output" (`openspec/specs/http-service-skeleton/spec.md:35-37`) has no permanent test — it is #166 AC5 (#102 startup integration test).
- #210 — `server/src/server.ts:272` guards late publication after the real `writeManagedModelsYml` (`if (owned.signalReceived || owned.app === undefined) return;`). No permanent test delivers SIGTERM while that write is pending (spec scenario "Signal during managed model publication", `http-service-skeleton/spec.md:31-33`), so deleting the guard stays green. PR #337's `--require` preload that gates the models.yml write (`server/test/listener-shutdown.test.ts` `gatedModelsWriteHook`) provides the deterministic barrier.

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: absent (expanded: process spawn/lifecycle harness, compiled-entry shutdown, proxy/credential evidence)
Blast radius: test support only; a wrong change could weaken the #88 fixture contract, hide empty-turn regressions, or produce a flaky startup test.
Selected risk packs: Concurrency / ordering; Error handling; Auth / secrets; Legacy compatibility.
Evidence floor: call-proxy contract tests against the real #88 fixture; compiled-entry full proxy turn; held-write SIGTERM test green and red under guard mutation; full server suite, lint, typecheck, anti-drift.

## What Changes
- fake-omp `call-proxy`: bounded two-round relay (at most one tool round) per the MODIFIED 真实代理承载 scenario; empty 200 or a second tool-only round → `stopReason:"error"`; a first round with content and no tool calls stays single-round success.
- `server/test/fake-omp.test.ts`: positive two-round contract against the real #88 fixture behind a test-owned recording forwarder; empty-200 case; existing stub tests (fragmented UTF-8, failure modes) kept.
- `server/test/server-startup-order.test.ts`: compiled-entry full proxy turn (evidence for "Full proxy turn keeps both credentials out of output") and held-write SIGTERM case (evidence for "Signal during managed model publication").
- `server/test/server-startup-helpers.ts`: shared gated models.yml preload (throw mode for #227, call-through mode for #210); `listener-shutdown.test.ts` switched to it.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-test-harness`: MODIFIED 假 omp 进程契约 — scenario 真实代理承载 now requires the tool round and forbids successful empty turns.

## Impact
`server/test/**` only. No `server/src` change, no #88 fixture contract change, no CI workflow change. The `http-service-skeleton` scenarios cited above are unchanged; this change adds their permanent evidence.
