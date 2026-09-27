# Spec delta: omp-test-harness（#528 受控上游标记）

> 整段取父 change `s1c-session-metadata-presentation` delta ADDED 段的「受控上游思考与写入标记」。本 issue 交付该 requirement 父 delta 的全部内容。

## ADDED Requirements

### Requirement: 受控上游思考与写入标记
The existing loopback fake-upstream (`server/test/support/fake-upstream.mjs`, the controlled upstream behind real omp in `make smoke`, `make ui-walk` and their CI jobs) SHALL additionally honour two markers found as substrings of the last user message text, selected by the same last-user-text lookup as `WORKBUDDY_UI_WALK:<uuid>` and combinable with it and with each other. `WORKBUDDY_THINK`: the answering text round (the request whose history already holds a `tool` role message) SHALL emit, after the `role` chunk and before the first `content` chunk, exactly three chunks whose `delta` is `{reasoning_content:<part>}` with parts `先读需求，`, `再列要点，`, `最后作答。` (the same deterministic thinking text as the fake omp `thinking` scenario), leaving the content chunks, finish reason and `[DONE]` unchanged; under an armed gate these reasoning chunks are part of the prefix sent before the hold and release is unchanged. `WORKBUDDY_WRITE`: the tool round (history without a `tool` role message) SHALL issue one `write` tool call with arguments exactly `{"path":"workbuddy-report.html","content":"<!doctype html><title>WorkBuddy</title><h1>WorkBuddy</h1>\n"}` instead of the bash call; the answering round is unchanged. Real omp in `--approval-mode write` treats that plain-path `write` as write tier, so it raises no approval, resolves the relative path against the session's `--cwd` (the bound workspace root for a bound session), writes the file and reports the absolute `details.resolvedPath`. The error marker keeps its precedence. Requests carrying neither marker SHALL receive byte-for-byte the frames they receive today (bash tool round, fixed reply, no reasoning chunk), so the existing `chat.hurl`, ui-walk journey and gate requirement are unaffected. The fixture test suite SHALL cover both markers, their combination with a gate, and the unmarked default.
Because the model proxy relays the upstream SSE bytes unchanged and omp's openai-completions provider maps `delta.reasoning_content` to `thinking_start`/`thinking_delta`/`thinking_end` unconditionally on the response side (vendored `ai/src/providers/openai-completions.ts:1150-1175`, independent of the model entry's `reasoning` declaration), a `WORKBUDDY_THINK` turn through real omp yields thinking frames regardless of `MODEL_REASONING`; the fixture proves frame arrival through real omp, not the behaviour of any real model.

#### Scenario: 思考标记产生 reasoning 块
- **WHEN** a chat-completions request whose history holds a `tool` message and whose last user text contains `WORKBUDDY_THINK` is sent, with and without an armed gate for its `WORKBUDDY_UI_WALK:<uuid>` marker
- **THEN** the stream is the role chunk, three `reasoning_content` chunks concatenating to exactly `先读需求，再列要点，最后作答。`, then the unchanged content chunks, finish and `[DONE]`; with an armed gate the reasoning chunks and the first content prefix are sent before the hold and release sends the unchanged remainder exactly once

#### Scenario: 写入标记替换 bash 工具轮
- **WHEN** a request without `tool` history whose last user text contains `WORKBUDDY_WRITE` is sent, and separately the same request without the marker
- **THEN** the marked request streams one `write` tool call with the exact documented arguments and finish reason `tool_calls`, no bash call; the unmarked request streams the unchanged bash tool call

#### Scenario: 无标记请求字节不变
- **WHEN** requests without either marker are sent for the tool round and the answering round, with and without a gate
- **THEN** the frames are identical to the pre-change fixture output (no `reasoning_content` key, bash tool call, fixed reply), and every existing gate scenario passes unchanged
