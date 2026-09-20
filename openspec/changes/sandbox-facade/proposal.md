## Why
#123 composes the already accepted path resolver and shared-directory helper with an owner-root port and fail-closed rejection audit. #112/#113/#115/#122 are integrated; callers need one canonical boundary before #127.

## What Changes
- Add core/sandbox/index.ts createSandbox with synchronous rootOf/audit ports and absolute-path success result; expose existing ensureSharedDir unchanged.
- Resolve ownership before path inspection; denied paths emit exactly one canonical sandbox.reject event before sandbox_denied; audit/root errors propagate.
- Paired real-filesystem tests with stub external ports, no resolver mocks; static dependency evidence instead of a source-text grep unit test.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- sandbox-core: add facade-only requirement, preserving existing resolve and shared-directory requirements.

## Impact
Source index.ts + paired test; no feature/http imports, dependencies, route wiring or DB changes. Production rootOf/store and HTTP integration remain #125/#127/#128.

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: authorization/path boundary and audit ordering)
Blast radius: mistaken ownership or swallowed audit failure can bypass sandbox accountability.
Selected risk packs: Public API; File IO; Schema/fields; Auth; Ordering; Error handling; Documentation.
Evidence floor: semantic RED then real-filesystem/stub-port GREEN, server coverage/type/build/static gates, compiled facade smoke, independent static review and exact-head CI.
Scope interpretation: audit emit is synchronous number-returning canonical core/audit emitter, not async/void; completion means successful return. Grep/source tests replaced by static import-boundary verification, not weakened dependency rule.
