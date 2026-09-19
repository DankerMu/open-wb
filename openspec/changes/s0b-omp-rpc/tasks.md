## 1. Contract and implementation
- [x] 1.1 Obtain fixture review and strict validation before source changes.
- [x] 1.2 Capture semantic RED at callable OmpProcess boundary before implementation; preserve outputs outside repo.
- [ ] 1.3 Implement process.ts protocol entrypoint and sole internal frame.ts decoder without changing spawn contract; cover handshake, correlation, chunking, IO errors and UI cancellation.
- [ ] 1.4 Demonstrate real fake subprocess cases and controlled invalid-wire cases in design; preserve RED/GREEN and cleanup evidence.

## 2. Acceptance and delivery
- [ ] 2.1 Parent runs focused protocol/spawn tests, npm test --workspace server, make lint, make typecheck and make anti-drift; independent real-child smoke.
- [ ] 2.2 Expanded agent reviews (correctness, test-evidence+spec-compliance, security-perf), bounded fix gate and same-SHA CI green.
- [ ] 2.3 Merge issue PR; update parent task 1.4 and archive this fixture through follow-up PR.

## Risk pack disposition
- Selected Public API / CLI / script entry: start/send/frame/exit behavior; tasks 1.3-1.4.
- Not selected Config / project setup: #101 owns configuration; no config changes.
- Not selected File IO / path safety / overwrite: preserve #85 boundary; existing spawn regression in 2.1.
- Selected Schema / columns / units / field names: frozen wire schema, byte—not character—length; invalid-wire cases in 1.4.
- Selected Auth / permissions / secrets: no raw frame/stderr/credential logging; error-path evidence and security review 1.4/2.2.
- Selected Concurrency / shared state / ordering: correlated ids, repeated start, exit/timer settlement; 1.4.
- Selected Resource limits / large input / discovery: 1MiB/64MiB caps, bounded incomplete input; 1.4.
- Selected Legacy compatibility / examples: frozen v18.0.10 wire and existing spawn API; 1.4/2.1.
- Selected Error handling / rollback / partial outputs: failed startup termination, truncated frames, recovery and IO failure; 1.4; revert without migration.
- Not selected Release / packaging / dependency compatibility: no dependencies or binary supply change.
- Selected Documentation / migration notes: fixture/API boundaries and parent progress; 2.3.

## Review deviation
Epic #81 user waiver removes only per-issue human white-box hold, not agent review/CI; final functional review remains after epic completion. Source/test writer cannot modify these acceptance rules or CI thresholds.
