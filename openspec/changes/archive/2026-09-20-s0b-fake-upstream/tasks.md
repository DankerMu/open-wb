## 1. Contract and test-first barrier
- [x] 1.1 Obtain expanded fixture review and strict validation before implementation. UpstreamFixtureReview PASS; strict validation exit0.
- [x] 1.2 Write paired real-HTTP/CLI contract tests first; capture initial setup failure if module is absent, then semantic RED against a minimal callable wrong-response HTTP scaffold before implementing auth/SSE. Parent verified absent module, then live HTTP404 baseline (13 failed/6 passed), before Stage B; final19/19 passed.

## 2. Fixture implementation
- [x] 2.1 Implement the sole fake-upstream.mjs with start/close, configured bearer, both required mount points, deterministic tool/text SSE and last-user500 selection; minimal .d.mts supplies strict TS import types.
- [x] 2.2 Prove standalone port/readiness/native exit, imported no-side-effects/independent instances, malformed-request recovery and client-abort cleanup without changing existing fake-omp or product code. Contract cases and independent actual CLI/HTTP probe passed.

## 3. Independent acceptance and delivery
- [x] 3.1 Parent runs focused contract tests, full server suite/coverage, make lint, make typecheck, make anti-drift and strict OpenSpec validation; exercise the actual CLI over HTTP with observed cleanup. All commands exit0; CLI SIGTERM exits0 and subsequent curl exits7 (connection refused).
- [x] 3.2 Qualify auth, branch/error selection and SSE/lifecycle oracles with semantic wrong candidates in a disposable copy. Nine mutants rejected by assertion failures; reference/restoration GREEN. Initial pooled-fetch refusal oracle missed a live listener; repaired to fresh TCP ECONNREFUSED and requalified all nine. No production mutation or imported expected-output constants.
- [x] 3.3 Expanded correctness / test-evidence+spec-compliance / security-perf review: three seats no blocking findings, round1 CLEAN at592484e19b06b79ac6336b2e6133dbfc37a53975; CI35510322050 all8jobs success; PR168 merged.
- [x] 3.4 Merge #88, update parent task2.1 and archive this fixture through the docs-only follow-up PR carrying this ledger. Source merge eb11971; canonical model-proxy adds only this fixture requirement.

## Risk pack disposition
- Selected Public API / CLI / script entry: import/start/close and real standalone port/termination; 1.2/2.2/3.1.
- Selected Config / project setup: CLI-owned FAKE_UPSTREAM_PORT and in-process expected-key override; invalid/occupied port and no false readiness; 2.2. No application config changes.
- Not selected File IO / path safety / overwrite: no fixture file writes or path-derived storage; Node loads its own script only.
- Selected Schema / columns / units / field names: canonical OpenAI chunk fields, tool arguments, SSE record boundaries/DONE, last-user text extraction; 2.1/3.2.
- Selected Auth / permissions / secrets: correct/wrong/missing bearer, override isolation, no credential diagnostics; 2.1-2.2/3.2.
- Selected Concurrency / shared state / ordering: multiple instances, auth/error precedence, stream order, import versus CLI, abort/close; 2.1-2.2.
- Selected Resource limits / large input / discovery: listener/socket/child lifetime and malformed/aborted input; 2.2. Generic production request-size policy belongs #98, not this bounded test-response fixture.
- Selected Legacy compatibility / examples: literal root path and D11 /v1 base; no existing fake-omp change; 2.1/3.1.
- Selected Error handling / rollback / partial outputs:401/400/500 non-streaming, listen failure, no false DONE, cleanup; 2.1-2.2/3.2. No migration; revert fixture with future consumers if needed.
- Selected Release / packaging / dependency compatibility: plain Node24 .mjs, no new dependency/build requirement; 2.2/3.1.
- Selected Documentation / migration notes: explicit path/key decisions, current fixture and parent ledger; 3.4.

## Project domain risk disposition
- Selected cross-service boundary / offline deployability: real loopback HTTP with no model-vendor network or npm dependency; 2.1/3.1.
- Selected process lifecycle: actual Node CLI child/readiness/termination and owned sockets; 2.2/3.1.
- Not selected tenant/sandbox isolation, authentication cookies, SQLite catalog, browser runtime, production HTTP envelope: no changes to those surfaces. Fixture error JSON follows upstream OpenAI shape, not app-server envelope.

## Governance
User Epic81 per-issue human white-box waiver remains; agent review, CI and final functional review are not waived. Candidate cannot change fixtures, configs, dependencies, thresholds or CI. Test-only/minimal-callable-scaffold RED barrier precedes behavior implementation; no retrospective production stub mutation. Reviewers run no tests/probes. Parent alone runs formatting/static/full acceptance. Unrelated fake-omp tool-round interoperability belongs its later integration owner, not this slice.
