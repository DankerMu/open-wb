## Context
The fake is a standalone Node JSONL process, not a mock of future production code.
Pinned source: can1357/oh-my-pi commit 33cc6b9a043a74e00a157e72ca909272796d8461, docs/rpc.md and rpc-types.ts; no upstream implementation code copied.
## Goals / Non-Goals
Goals: faithful selected wire behaviors and intentionally selectable failures; reproducible public process tests.
Non-goals: full omp emulator, real model credentials, production RPC decoder, generic YAML parser, real tool execution, CI wiring.
## Decisions
Change surface: server/test/support/fake-omp.mjs and its sole paired contract test.
Governing invariant: default frames obey the pinned protocol; divergence occurs only through an explicit scenario, and credentials never enter emitted frames/logs.
Must preserve: Node-only invocation, existing server test isolation and teardown, request-id correlation, prompt ACK distinct from terminal completion.
Sibling surfaces: #95 handshake/chunk decoder, #100 prompt supervisor, #102 call-proxy startup-log test; #89 managed YAML producer.
Scenario interface: argv `--scenario <name>` (default normal); names no-ready, missing-session, chunked, interleaved, crash, error, extension-ui, call-proxy. The issue's seven mode families group chunked/interleaved together; both variants require evidence.
Accept ordinary omp launch options required by later consumers without interpreting them as scenarios; no production-only environment variable needed to select a scenario.
Normal ready advertises v1 plus supported [1,2], 1MiB physical and 64MiB logical limits; negotiation echoes request id with data.protocolVersion=2.
get_state uses data.sessionFile nonempty in normal mode, missing only in missing-session mode; --resume may supply the returned session path.
Default prompt ack precedes emitted turn events; at least three text_delta events, one correlated tool start/end pair, assistant message_end, terminal agent_end. No real shell execution.
Chunked get_state response after negotiation has a logical JSON object exceeding 3MiB including non-ASCII text; chunks obey byteLength, contiguous indices/count/id and 1MiB physical cap. Interleaved variant deliberately inserts an unrelated frame between chunks.
Crash exits nonzero during a prompt before terminal agent_end; error emits assistant stopReason error and errorMessage then terminal agent_end.
Extension-ui emits a confirm request and waits for matching extension_ui_response cancellation before terminal completion.
Call-proxy reads $PI_CODING_AGENT_DIR/models.yml: managed YAML mapping providers.workbuddy.baseUrl, api openai-completions, apiKey WORKBUDDY_MODEL_TOKEN and models list (parent D2). Parse only this documented generated subset, including quoted scalar URL; malformed/missing config fails visibly, no fallback URL.
Use WORKBUDDY_MODEL_TOKEN only as Bearer in a real POST <baseUrl>/chat/completions. Request includes prompt messages and stream:true; OpenAI SSE choices[].delta.content becomes text_delta. Input chunk boundaries and Unicode must not corrupt text; [DONE] completes.
A proxy failure produces observable error termination, never a fabricated successful reply; do not echo bearer or raw config in stdout/stderr.
Seams under test: child_process spawn + real stdin/stdout, independent test decoder for chunk bytes, local node:http server for request/auth and SSE delivery.
Test lifetimes: all children, listeners, sockets and temp directories disposed on pass/failure; process exits on stdin EOF in idle normal mode. No long sleeps as protocol synchronization.
## Risks / Trade-offs
A handwritten YAML subset is deliberately not general YAML; pair test input with parent D2 managed producer shape. No npm dependency allowed.
Tests must assert externally visible wire fields and byte identities, not import fake implementation helpers as the oracle.
## Migration Plan
No persisted-state migration. Later issues invoke this script through their spawn injection seam; rollback removes the two test files.
