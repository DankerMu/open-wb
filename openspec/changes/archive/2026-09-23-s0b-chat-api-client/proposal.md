## Why
#92 supplies the typed REST adapter needed by #93/#104 after the #214 snapshot contract and #103 stream transport. The web client currently has no session methods.

## What Changes
- Add listSessions, createSession, getMessages and prompt to the existing ApiClient/request/error pipeline.
- Preserve complete snapshot text and the exact nullable stream cursor; validate session response DTOs at the network boundary.
- Extract only reusable JSON predicates needed to keep api.ts under 800 lines, without changing existing API behavior.

## Capabilities
### New Capabilities
- `chat-web`: typed session API client (this slice only; page and EventSource remain later issues).
### Modified Capabilities
None.

## Impact
Only web/src/lib/api.ts, small adjacent JSON/session contract modules and paired API tests. No server, UI, dependencies, configuration or permission changes.

## Risk Triage
Issue type: feature with a small equivalence extraction.
Fixture level: expanded.
Upstream suggested level: compact (override: public ApiClient and strict response parsers are explicit expanded triggers).
Blast radius: new chat consumers; extracted predicates must not regress existing auth/files/audit callers.
Selected risk packs: Public API; Schema; Auth; Legacy compatibility; Error handling; Documentation.
Evidence floor: red-first public factory/paired API tests, complete web suite with coverage, typecheck/build/static/drift, parent-owned real HTTP client smoke, exact-head CI.
