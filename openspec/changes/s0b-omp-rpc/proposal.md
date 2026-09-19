## Why
Issue #95 connects the accepted spawn boundary to the frozen omp v18.0.10 JSONL protocol, enabling #96 without coupling transport to sessions or storage.

## What Changes
- Add OmpProcess handshake, correlated command IO, validated chunk reassembly, frame/exit observation and extension UI cancellation.
- Preserve spawnOmp argv, environment and directory preparation unchanged.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-runtime`: add RPC handshake and frame transport requirements.

## Impact
Production surface: server/src/sessions/omp/process.ts and its sole internal decoder server/src/sessions/omp/frame.ts; protocol tests in server/test/omp-rpc*.test.ts with shared observation helpers. Extracting the decoder preserves one implementation and the 800-line limit; tests exercise it through the public process boundary. No new dependency.

Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: child protocol correctness, bounded memory, handshake readiness and downstream runtime failure handling.
Selected risk packs: public API, schema, secrets, concurrency, resource limits, compatibility, error handling, documentation.
Evidence floor: semantic RED/GREEN; real fake-omp subprocess cases; focused protocol + existing spawn tests; server coverage, lint, typecheck, anti-drift and protected CI.
Human review deviation: user explicitly waived per-issue human review for Epic #81; final functional review after epic completion. Agent reviews and CI remain required (epic comment 5743093674).
