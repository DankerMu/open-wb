# chat-harness Specification

## Purpose
Define manual smoke gates and automated dialogue acceptance: credential-free Hurl invocation, exact or shape-only assertions over a caller-owned service, real pinned-omp CI integration, bounded job-owned process cleanup, and browser walkthroughs proving native streaming across genuine in-flight reload and durable completed reload.
## Requirements
### Requirement: 手动真实上游冒烟入口
`make smoke-live` SHALL consume an already-running service without build/start/stop. If MODEL_UPSTREAM_BASE_URL or MODEL_UPSTREAM_API_KEY is absent or empty, it SHALL exit nonzero and identify the missing variable without printing its value or executing Hurl. Required values SHALL be transferred literally through Make and quoted shell expansion, without evaluating Make/shell syntax in their bytes. After gates, missing Hurl SHALL produce explicit installation guidance. Hurl SHALL run in a clean child environment containing only PATH, with `--test --jobs 1 --retry 0`, `base_url` from raw SMOKE_BASE_URL, `content_pattern=^.+$`, `min_bash_steps=0`, and only `smoke/chat.hurl`. Upstream gate values SHALL NOT appear in Hurl args/environment or diagnostics. Hurl failure SHALL propagate nonzero. Existing `make smoke` recipe SHALL remain unchanged in this slice.
The target SHALL be listed exactly once in .PHONY and the command header. The existing Make oracle SHALL protect its exact recipe and reject duplicate/redefined targets, including `smoke-live :`, missing/duplicated .PHONY entries and mutated invocation.

#### Scenario: Missing configuration fails before invocation
- WHEN either required upstream variable is missing or empty
- THEN make exits nonzero with that variable name and no Hurl invocation, without revealing configured values

#### Scenario: Literal clean invocation
- WHEN both gate values are nonempty and Hurl is discoverable
- THEN one clean child receives exact shape-only argv and caller baseURL bytes, no upstream values, and the target returns the Hurl result

#### Scenario: Exact command guard
- WHEN the Make oracle inspects a duplicate spaced smoke-live header, altered recipe or missing .PHONY entry
- THEN it rejects the changed contract; the current complete guardrail suite remains green

### Requirement: HTTP 冒烟对话用例
`smoke/chat.hurl` SHALL independently start with empty cookies, login, create a session201 and send one prompt202. It SHALL poll only messages GET with bounded per-entry retries until the captured assistant and session are done; assert content matches `content_pattern`, bash step count is at least `min_bash_steps`, and every step is done. It SHALL logout, login as another account, verify session access404, logout, then verify bearer-free POST `/v1/chat/completions`401. It SHALL not require earlier smoke files or leave live authentication sessions/running turns. `make smoke` SHALL pass exact anchored fake reply and min_bash_steps1; existing smoke-live passes nonempty shape and min_bash_steps0 through the same file.

#### Scenario: Real pinned runtime completes dialogue
- WHEN compiled app uses verified real omp18.0.10 and the existing controlled upstream, and make smoke runs twice
- THEN public/auth/chat all pass with exact reply `你好，这是 WorkBuddy 的第一条流式回复。`, at least one done bash step, completed captured assistant/session and account/proxy boundaries intact

#### Scenario: Oracle rejects false completion
- WHEN response text differs, captured assistant is not done, bash is missing or failed, a foreign account can read the session, or bearer-free proxy accepts the request
- THEN the chat oracle fails for the corresponding semantic assertion and does not retry the POST prompt

### Requirement: Real-runtime CI harness ownership
CI smoke/ui-walk SHALL retain existing action identities/counts, setup/build/static roots and timeouts; fetch verified omp without a new cache action, start their own controlled loopback upstream before compiled app, pass explicit OMP_BIN/OMP_STATE_DIR/SANDBOX_ROOT and fake MODEL_UPSTREAM values, and invoke the existing Make target. `.github/scripts/ci-fake-upstream.sh` SHALL launch the existing Node fixture, not duplicate it. Existing cancellation/process-group/cleanup failure semantics SHALL remain; all job-owned upstream/omp processes SHALL be reaped on success, failure and cancellation. Two harness jobs SHALL not reference secrets or real model upstreams; existing secret-scan token is explicitly preserved by user decision.

#### Scenario: Independent jobs remain isolated
- WHEN smoke and ui-walk each execute with job-local paths and ports
- THEN verified binary and ready controlled upstream precede app readiness, harness result is propagated, owned children are gone after teardown and unrelated processes remain untouched

#### Scenario: Prerequisite and cleanup failures are visible
- WHEN fetch validation fails, upstream fails to start/readiness or exits early, app or harness fails, cancellation arrives, or owned children resist termination
- THEN the wrapper exits nonzero with bounded cleanup and credential-free diagnostics rather than silently skipping or substituting fake-omp

### Requirement: UI 走查对话步骤
The existing Playwright production journey SHALL create a session through UI, send its fixed prompt template with an isolated test correlation UUID, observe a bash step and nonempty assistant prefix, and reload while the actual server session and captured assistant remain running. The test upstream gate SHALL remain held through reload; fresh REST and DOM SHALL identify the same session and prefix before release, with a new native SSE connection observed. Explicit release SHALL produce the exact original fixed reply, done bash/session, and one user plus one assistant message. A second reload after completion SHALL preserve the identical complete messages and done state. Browser route fulfillment, fake EventSource, delayed display of already completed server state and arbitrary timing sleeps SHALL NOT substitute for the real in-flight window.
Before release, the post-open recovery messages response SHALL finish and contain the running prefix, with no messages GET still in flight. From release until final suffix/done DOM assertions, any further messages GET SHALL fail the walkthrough, so completed REST cannot impersonate resumed native SSE. The later deliberate completed-page reload is outside this interval.
The preexisting login/four-route/theme/logout journey and browser error classifier SHALL remain unchanged: exactly two expected `/api/auth/me`401 and no unexpected console/page errors, including reconnect. Tests SHALL clean their gate in finally and consume caller-owned app/upstream without starting/stopping them.

#### Scenario: Real running reload and durable completion
- WHEN real pinned omp18.0.10, compiled app and controlled upstream serve the extended make ui-walk
- THEN running prefix and same session are observed before and after in-flight reload, release completes exact text and done state, completed reload retains both messages, and all prior journey/error assertions pass

#### Scenario: False progress cannot satisfy the oracle
- WHEN response was already terminal before reload, gate identity differs, restored prefix is lost, reconnect fails to deliver remaining text, final text differs or unexpected browser error occurs
- THEN the walkthrough fails rather than accepting a snapshot-only or fabricated success

- AND a candidate that establishes the new native connection and running recovery snapshot but suppresses subsequent stream data SHALL fail on missing suffix/completion

