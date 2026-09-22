## Context
The canonical event type is `server/src/sessions/events.ts:6-23`; Supervisor publishes numeric database step IDs. Parent D5 defines epoch-local IDs and min−1 replay. No existing RingBuffer/Last-Event-ID implementation exists in server sources.

## Goals / Non-Goals
Provide one deterministic pure ring, not an SSE server, persistence layer, event mapper or global session registry. Constructor receives a trusted nonnegative safe-integer epoch. #103 owns one instance per session/runtime generation and discards it on runtime exit; a new instance restarts seq1 in the new epoch. No reset/clear compatibility API or dead parser export is needed.

## Decisions
- `new RingBuffer(streamEpoch)`; `push(event: ChatEvent): string`; `since(lastEventId: string | null, {turnRunning: boolean})` returns `{mode: 'replay'|'gap'|'fresh', events}`. Each returned event carries `{id,type,data}` using the existing event union, not a second payload taxonomy.
- Fixed1000 circular slots, O(1) push without shift/copying the retained buffer; materialize only the requested replay result, in sequence order. Keep bounded metadata for the most recent still-active turn.start; turn.end clears that active marker. Do not collect text/history elsewhere.
- An ID is canonical ASCII `<epoch>:<seq>`, nonnegative safe integers with no leading zeros except0. Null means absent; empty/malformed IDs mean gap. Cursor0 is valid and useful before the first event. Match epoch and min−1 lower bound exactly. A same-epoch syntactically valid cursor at/beyond the current tail produces replay with no retained successors, following D5's stated lower-bound rule rather than inventing an upper-bound rejection.
- For an empty new ring the next sequence is1 and the lower-bound predecessor is0. The HTTP layer later decides whether a ring exists at all; this pure object never pretends to know persistence/runtime state.
- With no ID: turnRunning=false is fresh/empty; true replays from the retained active turn.start inclusive, otherwise gap/empty. A completed previous turn.start is never treated as the start of a newly accepted turn that has not emitted its first event.
- Retained records are immutable snapshots of the flat primitive payloads: copy at push, freeze owned record/payload, never freeze caller-owned input. Returned arrays are separate views; modifying input or a returned array cannot alter later replay. No general deep-clone abstraction.

## Risks / Trade-offs
Cursor-presence overrides turnRunning, so reconnecting clients receive only successors, never an accidental full-turn duplicate. Lifecycle disposal/epoch persistence and actual replay.gap frame IDs are #103/#100 ownership, not manufactured by this pure helper. Existing numeric identity limits apply; arbitrary precision IDs and configurable capacities are non-goals.

## Reconnaissance and Better Implementation Prompt
References: issue91 user decision; parent spec chat-stream:18-31 and design D5:47-54; canonical ChatEvent events.ts:6-23; architecture sessions/stream boundary system.md:95-99. Hidden pitfalls are the min−1 off-by-one, replaying a completed turn on refresh, reusing internal tool IDs, and a second unbounded event history. Implement only the two scoped files, one public behavior RED→GREEN at a time; reuse ChatEvent, bound retention, preserve ordered payload bytes and pure instance isolation. Do not wire #103 early or relax static gates to retain unused exports.
