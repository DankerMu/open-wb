## Context
#85 supplies spawnOmp; #87 supplies the real fake-omp executable. #95 owns protocol only.
Wire authority: resource/oh-my-pi/docs/rpc.md lines 32-105, frozen v18.0.10 (33cc6b9a043a74e00a157e72ca909272796d8461); issue's docs/architecture/rpc.md is a known broken link (#141).
Change surface: process.ts, its sole internal frame.ts decoder, and protocol tests; no imports from session stores or model-proxy. Decoder extraction keeps each file below 800 lines without a second implementation or compatibility re-export.

## Goals / Non-Goals
Goals: lossless bounded frames, exact correlation, successful readiness only after get_state provides sessionFile.
Non-goals: DB persistence (#97/#100), event mapping (#83), idle/turn/token/resume policy and graceful escalation (#96), configuration validation (#101).
Must preserve: spawnOmp public API and its exact argv/environment/creation ordering; frozen protocol semantics including prompt ACK not implying completion.
Governing invariant: no invalid/partial logical frame reaches consumers or satisfies a pending command; failed startup cannot report readiness.
Sibling surfaces: stdout decoder, stdin writer, pending-id map, handshake timer, child error/exit/stream closure, fake producer, future SessionRuntime.

## Decisions
- Add OmpProcess wrapping spawnOmp with injectable spawn boundary and handshakeTimeoutMs (default 10000). Constructor options reuse SpawnOmpOpts; start returns Promise<{sessionFile:string}>. Repeated start returns the same outcome, never spawns twice.
- Expose on('frame'|'exit') and send(frame). Correlated commands use an internal request helper or a public request method if needed by consumers; send itself is the raw JSONL writer and returns Promise<void> for write failures. Preserve every valid response as a frame, even late same-id prompt failures.
- Expose child handle or thin close-input/kill controls for #96; transport adds no idle or graceful escalation policy.
- Register stream/error/exit handlers before consuming ready. Bound the entire handshake, not each step independently. Validate matching id AND command, successful v2 response and nonempty data.sessionFile. Reject startup with a stable agent_unavailable classification, without raw credential-bearing payloads.
- Fatal startup failure terminates the child; native exit immediately invalidates startup and forbids new commands. After successful startup, stdout still drains complete buffered frames/responses before one logical exit with the original code/signal; unanswered requests fail at stream completion. IO errors abort transport; timers and pending state clear. Spawn errors reject without uncaught EventEmitter errors.
- Parse byte-oriented bounded JSONL; strict UTF-8; recover from malformed JSON lines with sanitized diagnostic/protocol-error notification, never raw frame logging. Blank lines are ignored.
- Cap physical frames at 1 MiB and logical payloads at 64 MiB, honoring smaller advertised positive limits. Reject oversized input before unbounded accumulation. Outbound commands remain unchunked and respect physical bound.
- One chunk sequence at a time: validate metadata, strict base64, index order, byte length, count and limits. Assemble bytes into one bounded buffer, then strict UTF-8 and object parse only after exact completion. Reject nested chunk envelopes. Interruption/interleaving abandons the partial sequence and reports protocol error; continue reading subsequent independent frames. EOF with partial line/sequence reports truncation, never a partial frame.
- Immediately send cancelled extension_ui_response with matching id; do not await user interaction. Drain stderr without accumulating/logging raw secrets.

## Risks / Trade-offs
- Protocol recovery can leave a handshake waiting → total handshake deadline remains authoritative; active requests implicated by protocol failure must reject rather than report success.
- Real pipe segmentation is nondeterministic → real subprocess integrations plus controlled stream boundary cases with literal independent wire expectations; no duplicate full fake implementation.
- Tests can mask missing correlation → out-of-order responses, wrong ids/commands and late same-id response evidence.
- Shared checkout is not an OS-enforced verifier enclave → candidate cannot edit fixture/config/CI; parent runs acceptance and protected CI supplies independent gate. No stronger isolation claim.
- Native exit and logical exit are distinct (Node v24.13.1 child_process exit/close contract). #96 owns bounded shutdown/token cleanup when a native-dead child's pipe remains open; this transport does not add idle or escalation policy.
- Source provenance: first candidate adapted upstream and was rejected before push. User authorized one further retry after a failed isolation attempt; a fresh implementer authored the independent one-buffer decoder from supplied wire facts before any repository reads, then integrated it. Draft and authorization are preserved in /tmp/open-wb-issue95-evidence; no upstream implementation is retained.

## Migration Plan
No current production consumer. Add transport atomically; #96 consumes it next. Revert issue commit to roll back; no persisted data change.

## Required Evidence
Real fake child: normal handshake, no-ready timeout and observed termination, missing-session rejection, 3 MiB Unicode chunk identity, interleaving error, immediate UI cancellation and crash code/signal.
Controlled IO: segmentation/coalescing, malformed-then-valid line, invalid metadata/base64/UTF-8/length/limits, incomplete EOF, out-of-order ids, write/spawn errors and pending settlement. Existing spawn regression remains green.
