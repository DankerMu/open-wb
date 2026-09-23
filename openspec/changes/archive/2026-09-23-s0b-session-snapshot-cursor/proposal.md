## Why
Issue214 blocks lossless gap recovery in103/93. The user approved a complete atomic history snapshot plus its stream boundary, implemented after204 and before103; waiting for turn completion is rejected. At base dacdf52c3baa31f32328bc1e4c834d32af56970a, protected real app/SQLite and native-child probes both exit1 because1000 published pending characters read back as empty. Earlier characterization showed a2048-character snapshot plus1048 already-covered queued characters naively becoming3096.

## What Changes
- **BREAKING** GET messages adds streamCursor:{epoch:number,seq:number|null}; content includes the store-owned pending tail without forcing persistence. Numeric seq covers that live generation through seq; null seals the entire epoch when no further publication from it is possible.
- Supervisor owns one RingBuffer per acquired generation, records canonical events synchronously after persistence/buffering and before external observation, and exposes the snapshot boundary. Native revocation alone is not a publication-drain barrier.
- History and cursor are captured together in the same synchronous authorized REST preParsing step. Existing cookie/owner isolation, no-store and public field projection remain.
- Freeze downstream103/92/93 recovery rules: replace snapshot, drop covered queued IDs, apply only successors; gap resets EventSource ID with an empty id field and consumes no data sequence. This change does not implement SSE or web.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- chat-sessions: complete read views and atomic REST snapshot boundary.
- chat-stream: read-only ring sequence boundary and generation-owned recording/sealing.

## Impact
Source: sessions/store.ts, supervisor.ts, stream/ring-buffer.ts, rest.ts and their current module consumers/test helpers. No migration, durable per-event write, dependency/config/CI change, runtime grace-period change, replay min−1 change or new transport. Existing parent S0b design/spec and issues103/92/93 are synchronized by the parent. New production helper files require a concrete cap/ownership reason before editing; store.ts is800lines, prefer the existing projection loop rather than a second store implementation.

## Risk and Evidence Contract
Fixture level: expanded (cross-layer snapshot consistency, native/pump lifecycle and public HTTP shape). Review seats correctness, test-evidence+spec-compliance, invariant-state. Core/domain pack mapping and concrete scenarios are in tasks.md. Parent protected probes and baseline identities live in /tmp/open-wb-issue214-evidence; final source and separate archive CI remain mandatory. No claim of an existing browser bug: SSE and chat UI are not implemented yet.
