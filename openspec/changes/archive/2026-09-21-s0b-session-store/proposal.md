## Why
Issue#97 provides owner-scoped durable conversation state and bounded in-progress persistence required by REST/supervisor slices. The existing032 schema is canonical; stream buffering must not trade away atomic admission or final content.
## What Changes
- Add only server/src/sessions/store.ts plus paired tests, following createWorkspaceStore factory/interface conventions.
- Owner-scoped creation/list/message-tree reads; atomic acceptance, separate streamEpoch increment/sessionFile persistence, pre-dispatch rollback; immediate step writes and2s/2048UTF8-byte body flush; terminal settlement and explicit startup reconciliation.
- Timer error notification and close ownership are store lifecycle, not runtime/network assembly. No REST/omp/SSE or schema/config/dependency changes.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- chat-sessions: add会话持久化与回合刷盘; preserve schema requirement, leave REST/runtime requirements to future changes.
## Impact / Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: owner isolation, persistent transaction/state and timedbuffer lifecycle; no spawn implementation)
Blast radius: cross-owner reads, half-accepted turns, lost/duplicated deltas, stale timers overwriting new turns, permanentrunning rows
Selected risk packs: Public API; Schema/units; Auth/permissions; FileIO/persistentdata; Concurrency/order; Resource lifetime; Compatibility; Errors/rollback; Release; Documentation
Evidence floor: realSQLite and fakeclock semanticRED/GREEN, compiled fileDB and realtimer smoke, rollback/error/stale-callback oracles, mutation/reference/restoration, fullserver/static/drift/build and sameSHA CI
