## Why
#93 supplies the pure chat-state reducer and EventSource connection/recovery owner needed by #104, after #92/#103/#214. Native reconnect alone does not make the initial REST→SSE handoff lossless: a controlled real-HTTP/native probe observed snapshot running/1:1, completion before subscription, then fresh replay=[] while current history was done/X/1:3.

## What Changes
- Add the pure chat-view reducer and injected EventSource connector, with typed payload decoding, cursor filtering and generation-fenced recovery.
- Reconcile a fresh snapshot on every native open as well as replay.gap; buffer and filter successors, invalidate superseded/closed recovery and bound pending events.
- Export only the existing named message/step/cursor types actually consumed from their DTO owner. API methods/parsers remain unchanged.
- Keep pages, route wiring, server, dependencies and browser reconnection policy out of scope.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-web`: add pure assistant-view reduction and lossless event consumption/recovery requirements alongside the existing API client requirement.

## Impact
web/src/features/chat/stream.ts and paired reducer/connector tests; one shared test fixture if needed; minimal named type exports in web/src/lib/session-contract.ts. Source/test files must stay below800 lines; no duplicate implementation or concrete ReturnType contracts. Parent S0b planning artifacts are synchronized, not a server protocol change.

## Risk Triage
Issue type: feature.
Fixture level: expanded (agrees with upstream: protocol + asynchronous recovery/ordering/lifecycle).
Blast radius: missing/duplicated assistant text, stale cross-session installation, stuck generating state or leaked stream/load.
Selected risk packs: Public API; Schema; Auth; Concurrency; Resource limits; Legacy compatibility; Error handling; Documentation.
Evidence floor: red-first paired tests, qualified controlled-scheduler recovery cases, actual Chromium EventSource + real HTTP/server/native producer, complete web coverage/static/type/build/drift, independent reviews and exact-head CI.
