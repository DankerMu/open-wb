## Why
Issue #91 supplies the pure replay decision required before #103 can attach SSE. The repository already has canonical ChatEvent payloads but no event-ID ring; a retained cursor boundary must distinguish a real missing successor from an already-received event that was evicted.

## What Changes
- Add one per-session, per-runtime-epoch RingBuffer with fixed retention of 1000 events, monotonically increasing IDs and replay/gap/fresh decisions.
- Reuse the numeric-step ChatEvent type. No store/runtime/HTTP wiring or replay.gap frame generation belongs to this slice.
- User explicitly resolved the issue/spec contradiction in favor of D5/spec min−1: retaining2..1001 permits cursor1 replay; cursor0 gaps, and after1002 pushes cursor1 gaps. Issue91 body/comment now records this decision.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-stream`: add pure event-ID retention and replay decisions without replacing the existing protocol-mapping requirement.

## Impact
Production scope `server/src/sessions/stream/ring-buffer.ts`; paired tests `server/test/session-ring-buffer.test.ts`. No dependencies, configuration, thresholds, routes, store or existing exported-symbol changes.

## Fixture and Assurance
Compact fixture, pure deterministic seam; Construction/Light with parent-protected boundary examples, independent compiled public-API smoke and plausible wrong-boundary qualification. Protocol meaning is explicit but no real HTTP/process/storage boundary changes. Same checkout, one implementer, no nesting/worktrees. Existing canonical event mapping, numeric step IDs, epoch ownership and future SSE wiring remain unchanged.
