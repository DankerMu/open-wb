## 1. Test-first implementation
- [x] 1.1 Write process contract tests first and capture their failed run before fake implementation; qualify known-bad frames/absent behaviors rather than treating ENOENT alone as semantic proof.
- [x] 1.2 Implement normal handshake/id correlation and full prompt lifecycle with at least three deltas and matching tool pair; test EOF cleanup.
- [x] 1.3 Cover no-ready, missing-session, chunked plus interleaved, crash, error and extension-ui observable differences; reconstruct >3MiB Unicode logical frame exactly.
- [x] 1.4 Implement call-proxy managed YAML read and real bearer POST/SSE text mapping; test local request body, fragmented SSE/Unicode, failure termination and no token in logs.
- [x] 1.5 Run `npx vitest run --config server/vitest.config.ts server/test/fake-omp.test.ts`, `npm test --workspace server`, `make lint`, `make typecheck`; no narrowed coverage includes; prove plain node CLI via direct process smoke.
- [ ] 1.6 Complete independent review/CI, record deviations and archive only this child fixture.

## Risk pack mapping
- Selected Public API / CLI / script entry: 1.1-1.3, 1.5; real node argv/stdin/stdout tests.
- Selected Config / project setup: 1.4; managed YAML shape and missing/malformed config error.
- Selected File IO / path safety / overwrite: 1.4; temp agentDir config read only; no arbitrary file writes required.
- Selected Schema / columns / units / field names: 1.2-1.4; pinned ready/response/event/chunk/SSE byte fields.
- Selected Auth / permissions / secrets: 1.4; local bearer request observed, stdout/stderr sentinel absent.
- Selected Concurrency / shared state / ordering: 1.2-1.4; ack versus terminal, correlated UI cancellation, per-process state; concurrent prompt scheduling is a non-goal.
- Selected Resource limits / large input / discovery: 1.3, 1.5; >3MiB Unicode chunk transport and child teardown; generic inbound DOS limits are a non-goal for test support.
- Selected Legacy compatibility / examples: 1.2; v1 ready/v2 negotiation from pinned protocol, not newer installed omp.
- Selected Error handling / rollback / partial outputs: 1.3-1.4; scripted crash/error and real proxy failure, no false successful reply.
- Selected Release / packaging / dependency compatibility: 1.5; node standalone, zero npm dependencies, unchanged source/toolchain.
- Selected Documentation / migration notes: fixture documents exact upstream pin, missing repo oracle path and scenario interface; no new standalone documentation file.

## Project domain packs
- Selected process/child-environment isolation: 1.2, 1.4-1.5; real child and teardown, config/token environment inputs. Production spawn allowlist remains #85's scope.
- Selected cross-service boundary: 1.4; local HTTP bearer transmission, no token in emitted logs, no public model service.
- Selected offline deployability: 1.5; standalone Node with no npm dependencies, local HTTP contracts only.
- Not selected tenant/sandbox isolation: this test fixture implements no filesystem sandbox or tenant authorization.
- Not selected auth/session lifecycle: no production cookie, account or token registry behavior.
- Not selected SQLite migration/catalog compatibility: no database access.
- Not selected server/web HTTP-envelope compatibility: no app-server route or browser API changes.
- Not selected browser runtime/navigation/persistence: no browser surface.

## Evidence and limits
PR #143 retains reviewer reports and adjudication. Initial missing-file and callable-stub RED preceded implementation. Fix-pass regressions failed on tool-origin ordering and truncated SSE completion; naive per-buffer UTF-8 decoding and injected chunk interleaving mutants failed their respective tests, then restored code passed.
Independent verification: focused 11/11; server 586/586 with unchanged coverage thresholds; lint/typecheck/anti-drift pass after factoring repeated lifecycle/error assertions. Plain Node smoke emits 13 frames with toolUse message_end before tool execution and final terminal agent_end.
The fake buffers proxy content until DONE rather than proving incremental relay timing. Managed YAML is the single-workbuddy-provider subset. These limits are intentional; real production decoder, cancellation and general YAML behavior are not implemented here. The atomic two-file test-support PR exceeds the review-only 400-line guideline, with rationale in the PR; each file remains under 800 lines.
