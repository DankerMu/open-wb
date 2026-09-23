## Why
Issue #103 is the missing live HTTP boundary for Epic #81. #204 synchronous sink guards and #214 complete snapshots/cursors are merged and archived; an authenticated owned GET events still returns404 rather than a live stream.

## What Changes
- Add authenticated owner-scoped SSE route, canonical replay/live framing, empty-id replay.gap,15s keepalive and multiple subscribers.
- Add synchronous replay/subscription access to Supervisor's existing generation-owned ring; no second counter/buffer. Preserve complete snapshot fences and synchronous external sink semantics.
- Bound slow/broken client transport and release subscribers/timers/responses before Fastify shutdown can wait on open streams.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-stream`: add the live SSE endpoint, atomic replay/live handoff and subscriber lifecycle requirements; existing pure ring and recording requirements remain unchanged.

## Impact
server/src/sessions/stream/sse.ts, supervisor.ts, index.ts and focused tests/helpers; app.ts only if injection plumbing requires it. No browser work, runtime/process/token changes, store schema/mutation, dependency/config/CI/gate changes. The issue's original one-line assembly bound is superseded by its recorded prerequisite decisions.

## Fixture classification
Expanded: authenticated raw HTTP, shared replay/generation identity, asynchronous network cleanup and shutdown. Three source seats: correctness; test-evidence+spec-compliance; invariant-state. Core/domain packs and exact evidence map in tasks.md. Source and independent archive PR each require fixed-head CI. User waived individual human wait, not white-box review/CI.
