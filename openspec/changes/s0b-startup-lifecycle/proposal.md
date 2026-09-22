## Why
Issue #102 completes the production lifecycle after #101 configuration/assembly and #89 managed model writer. Parent actual-process baselines fail: server_started is emitted without models.yml, and SIGTERM with a real child ignoring EOF observes listener-close before runtime-exit.
## What Changes
- Publish the existing managed models.yml after listen using the actual connectable bound address, before the success record, retaining env-name-only credentials.
- Make shutdown own native runtime settlement before listener closure and caller-owned DB closure, including signals around bind/model publication and real startup failure cleanup.
- Prove a full fake-omp call-proxy turn through a real local upstream, persisted done, with upstream sentinel and actual runtime bearer absent from process stdout/stderr.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `http-service-skeleton`: fully restate startup lifecycle and adjacent shared-assembly scope for models publication, native-first shutdown, cancellation/real-failure distinction and full-turn secret hygiene. Preserve #101's approved config range and all prior startup/import/auth contracts.
## Impact
server/src/server.ts and real startup-order integration tests with minimal reusable test support. Reuse models-yml.ts, app.sessions lifecycle handles and existing fake child/upstream; no new production dependency, environment flag, second entry, runtime timeout policy or source-text oracle.
## Risk triage
Issue type: feature. Fixture level: expanded (agree upstream).
Blast radius: startup publication, native children, credentials, listener/SQLite ownership and failure/signal interleavings.
Selected risk packs: entry/API, config compatibility, filesystem publication, units/address identity, auth/secrets, concurrency/state, resources, compatibility, partial failure, packaging and documentation.
Evidence floor: actual compiled main entry + real listen/close/SQLite/fake child/upstream; original two semantic RED counterexamples repaired; secret sentinel/full bearer proof; deterministic interleaving and failure qualification; scoped full-server validation, cross-review and exact-head CI.
## Non-Goals
No CI/smoke/web/SSE changes, real omp integration, new sandbox enforcement, async observer contract (#204), or pre-existing pid-less failed-spawn timing repair (#205). Existing same-uid security limits remain; this is not a production-release or OS-enclave claim.
