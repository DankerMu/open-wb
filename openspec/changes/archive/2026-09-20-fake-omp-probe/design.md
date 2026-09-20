## Context

The #87 helper already serializes input and owns ready/ack/turn frames. Extend it, not a second process implementation.
Change surface: existing fake-omp script and paired contract suite only.

## Goals / Non-Goals

Goal: report child-observed identity, environment keys, HOME/agent values, write result and proc read result honestly.
Non-goals: production code, sudo/config, uid switching, isolation enforcement, secret filtering, /proc downgrade closure; #131/#132 own these.
Governing invariant: the report reflects actual operations inside the same child, with write attempted before proc read and normal terminal completion after either operation fails.
Must preserve: all non-probe prompts and argv-selected scenarios, handshake, ack ids, frame ordering, clean stdin shutdown.
Sibling surfaces: handlePrompt dispatch, completeTurn, existing call-proxy/error/UI scenarios, test subprocess cleanup, future Linux consumer.

## Decisions

- Recognize valid `probe:<pid>:<writePath>` messages in existing prompt dispatch. Only the first two colons are separators; the remaining path is verbatim, including colons/spaces. The contract covers numeric pid and nonempty path; do not invent a malformed-input validation API.
- Use the child Node process getuid/getgid, Object.keys(process.env).sort() joined by commas, HOME and PI_CODING_AGENT_DIR verbatim. Never report arbitrary environment values or proc contents.
- Write UTF-8 `probe` using the child's actual credentials, then read `/proc/<pid>/environ`. Each operation reports `ok`/`readable` or the actual filesystem errno independently; no inferred readability.
- Reuse completeTurn with one delta and no synthetic tools; response ack and terminal shape remain canonical.
- Test through existing startFake harness, never mock the script. Expected identity derives from same-uid parent; env is explicitly controlled.
- Linux same-uid proc readability assertion runs in ordinary Ubuntu unit CI, not gated behind future WORKBUDDY_UID_TEST. macOS checks actual missing-proc errno and still runs all other probe checks; Linux-only claims are explicit.

## Risks / Trade-offs

- This is trusted test support with deliberate arbitrary path writing, not a sandbox implementation. Inputs come from test-owned directories.
- Fixed labeled report fields are for controlled harness inputs; no new escaping protocol is introduced. Tests parse field boundaries rather than whitespace-splitting paths.
- Root versus nonroot differs for permission errors: deterministic missing-parent ENOENT tests avoid assuming EACCES locally.
- Same uid success cannot establish isolation; later distinct-uid tests must observe EACCES themselves.

## Required Evidence

Successful real-child probe: exact fields, sorted key set, exact HOME/agent, colon/space path content `probe`, single text delta, stop then terminal end.
Failure probes: missing write parent reports ENOENT but still reads proc; missing pid reports ENOENT but still writes file and completes.
Existing non-probe suite remains green. Focused tests must fail against original script before implementation.
Review focus: truthful child observations; operation order and independent errno; existing dispatch compatibility; Linux assertion actually executes in CI.
