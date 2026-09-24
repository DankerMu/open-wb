## ADDED Requirements

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
