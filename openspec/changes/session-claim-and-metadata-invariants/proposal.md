## Why
Two S0b bookkeeping invariants in `server/src/sessions/` are left unpinned:
- #219 — `SessionSupervisor` releases a turn's claim only when the finishing pump is still `slot.pump` (`supervisor.ts:320-327`). When the next turn is admitted on the same slot before the old pump's `finally` runs (sink re-admits synchronously on `turn.end`: store already idle, `#prompt` has no await between `#claim` and dispatch), the new pump overwrites `slot.pump`, so the old turn's `#claims` entry is never deleted. `#claims` then pins the old `Slot` → `SessionRuntime` → `OmpProcess` graph forever and grows linearly. No user-visible 409 (assistant ids are AUTOINCREMENT, never reused), but it is an unbounded retention defect. Reachability is narrow: B registers its pump only after `stream.dispatched`, which waits for the child stdin write callback (async for real pipes and for the test `PassThrough`), while A's tail is pure microtasks — so with today's runtime A's finally runs first. The release is nevertheless keyed on an ordering accident; the fix removes that dependency so any future same-tick dispatch ack (sink re-entry, runtime refactor) cannot leak.
- #190 — `store.bumpStreamEpoch` contains a `HttpError("not_found")` branch (`store.ts:347-352`) that is unreachable after the preceding `requireChanges(..., 1)`; `setSessionFile` has only the generic receipt error. The missing-session contract of these trusted metadata writes is unstated. They now have production callers (`supervisor.ts:306` setSessionFile, `supervisor.ts:537` bumpStreamEpoch); both are only reached after `store.runtimeState(sessionId)` returned a row. No current code path deletes `chat_sessions` rows; the only latent deletion is the account cascade (`032_chat_sessions.sql:16` `owner_id … ON DELETE CASCADE` with `PRAGMA foreign_keys = ON`), and no account-deletion path exists in `server/src`. A missing row under a live supervisor slot is therefore an invariant violation, not a client-facing condition.

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: persisted/shared state and concurrency ordering in the supervisor; store persistence contract)
Blast radius: every multi-turn session's claim bookkeeping; supervisor acquisition error path (bumpStreamEpoch fault → acquisitionFault → generic 5xx).
Selected risk packs: Concurrency / shared state / ordering; Resource limits (unbounded retention); Error handling / rollback; Legacy compatibility.
Evidence floor: extracted pump-exit unit test RED before / GREEN after; same-slot sink re-entry integration regression (behavioural); missing-session store tests; existing supervisor/store suites unchanged; server test/lint/typecheck/anti-drift green.

## What Changes
- #219: a finishing pump always releases its own turn's claim (`#releaseClaim` is already identity-safe); only clearing `slot.pump` stays gated on pump identity. The pump-exit bookkeeping (today the `finally` body at `supervisor.ts:320-327`) is extracted into a small directly unit-testable function operating on the claims map and slot, so the handover case (`slot.pump !== pump`) gets a deterministic RED/GREEN without depending on microtask hop counts (issue #219 acceptance option (b)). No new public supervisor API.
- #190: decide **invariant-only**. Trusted callers own existence (no current code path deletes rows; supervisor reads `runtimeState` first). Remove the unreachable `not_found` branch from `bumpStreamEpoch`; both methods keep throwing the generic receipt `Error` on a missing row, without writes; document this in code comments and the spec. Not canonical `not_found`: a typed `HttpError` thrown by `bumpStreamEpoch` would pass unchanged through the supervisor's `#translate` (`supervisor.ts:639-642`) and surface as a 404, contradicting the existing `Supervisor dispatch and generation binding` requirement that storage faults stay generic (`openspec/specs/chat-sessions/spec.md:166`). A missing row is a programming/invariant fault and must stay a generic 5xx.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-sessions`: ADDED requirements for per-turn claim release and trusted metadata missing-session semantics.

## Impact
`server/src/sessions/supervisor.ts`, `server/src/sessions/store.ts`, and their tests. No REST/HTTP mapping, sink contract, admission gate, runtime state machine, schema, or migration change.
