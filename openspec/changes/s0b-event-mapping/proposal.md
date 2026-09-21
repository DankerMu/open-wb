## Why
Issue #83 supplies the pure protocol-to-chat normalization needed by #100 without importing persistence or process lifecycle. Raw omp frames include ACKs, maintenance boundaries and tool-call identities that must not become false browser terminal events or unrelated step updates.
## What Changes
- Add server/src/sessions/events.ts and paired tests: immutable per-accepted-prompt state, frame normalization, remembered assistant failure and explicit abnormal-runtime-failure input.
- Emit only turn.start/text.delta/step.start/step.end/error/turn.end; filter transport/UI/ACK/thinking/toolcall/turn noise. Terminal failure emits error before turn.end once.
- Keep toolCallId as the pure layer's step correlation identity; #100 binds it to numeric persisted step IDs before publication. One generic ChatEvent<StepId> union describes both phases without two implementations.
## Capabilities
### New Capabilities
- `chat-stream`: pure normalized event mapping requirement only; no replay/buffering/SSE implementation.
### Modified Capabilities
None. Parent S0b has pending chat-stream deltas; this child promotes only its implemented pure-mapping requirement.
## Impact
One production module and paired server tests. No dependencies, schema/config/CI changes, store/runtime edits, IO, timers, random IDs or clock reads. Reuse type-only OmpFrame from the existing decoder, not an upstream source implementation. #100 owns persisted-ID binding, prompt correlation, runtime failure/local-only completion and publication; #91/#103 own replay/SSE.
## Fixture and evidence
Expanded inherited from issue83: state/order/identity and downstream wire compatibility warrant correctness, test-evidence+spec and invariant-state seats. Construction/Standard with high-consequence identity/terminal cases: A1 tests before source (SETUP), separately authorized A2 callable wrong output semantic RED, frozen originals, B source-only GREEN. Parent compiled deterministic sequence/immutability probes, disposable semantic mutants/restoration; scoped/fullserver tests, types/Biome/build/anti-drift/OpenSpec and exact-SHA CI. No per-issue human gate under user's Epic81 waiver; final functional review remains.
