## Risk Packs
- Concurrency / ordering — selected: held write vs SIGTERM ordering, deterministic barrier → 1.4, 2.3.
- Error handling — selected: empty 200 / second tool-only round fail visibly; guard mutation goes red → 1.1, 2.1, 2.3.
- Auth / secrets — selected: full proxy turn outputs and models.yml contain neither upstream key nor runtime bearer → 1.3, 2.2.
- Legacy compatibility — selected: #88 contract, other fake-omp scenarios, existing call-proxy stub tests, startup-order and #227 listener tests unchanged → 2.4.
- Public API, Config, Schema, File IO/path safety, Resource limits, Release, Documentation — not selected: test-support-only change; no production surface, config, data, dependency or doc change.

## 1. Implementation
- [x] 1.1 fake-omp call-proxy bounded two-round relay + visible failure for empty/tool-only answering round (design "Relay design").
- [x] 1.2 fake-omp.test.ts: E1 contract against real #88 fixture via recording forwarder; empty-200 and second-round tool-only stubs.
- [x] 1.3 server-startup-order.test.ts: E2 compiled-entry full proxy turn.
- [x] 1.4 Shared gated models.yml preload in server-startup-helpers.ts (throw + call-through modes); listener-shutdown.test.ts switched to it; E3 held-write SIGTERM case.

## 2. Verification
- [x] 2.1 E1 green; RED of the positive contract against the pre-change relay.
- [x] 2.2 E2 green: persisted text equals fixture text, bash step done, no secrets in outputs or models.yml.
- [x] 2.3 E3 green; guard mutation makes it red; `git diff --exit-code server/src` after restore.
- [x] 2.4 `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0; new/changed test files run 3× without flakes.
