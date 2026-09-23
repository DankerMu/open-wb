## Why
Issue #204 identified an undeclared synchronous-only assumption in Supervisor observation sinks. Before #214 recording and #103 SSE composition, the user explicitly chose synchronous sinks with a failing guard rather than asynchronous observer ownership. Current native rejected Promises escape Node's default rejection boundary; other returned thenables are silently accepted.

## What Changes
- Define and enforce synchronous onEvent/onError return semantics through the existing app/registerSessions/Supervisor chain.
- A returned native or non-native thenable is an owned programming error regardless of settlement. Contain its eventual rejection without awaiting it or introducing sink-work shutdown ownership.
- Preserve ordinary synchronous returns and thrown-error behavior; event-sink violation retires its runtime through existing ownership, error-sink violation is retained without recursive notification.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-sessions`: add the explicit synchronous observation-sink requirement; existing dispatch, persistence, native retirement and caller-owned DB requirements remain intact.

## Impact and Fixture
Expanded: the code delta is small but the failure is process-level detached rejection and the repair enters existing native-retirement/error ownership. Production scope supervisor.ts plus sink documentation in index.ts/app.ts; paired regression additions in session-supervisor-faults.test.ts. No runtime/store implementation, SSE, snapshot API, dependency, config or CI changes.
Construction/Standard with real compiled app + native fake child, Node default unhandled-rejection policy, non-native thenables, and protected parent acceptance. User decision is recorded on issue204 and /tmp/open-wb-issue103-evidence/user-decisions.json. #214/#103 remain blocked until source and separate archive PRs pass their own CI.
