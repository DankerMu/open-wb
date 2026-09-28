# Spec delta: chat-harness（#481，父 tasks 8.1a、8.2a）

> - 「手动真实上游冒烟入口」：父 delta 同名块逐字，本刀全量交付。
> - 「HTTP 冒烟对话用例」：以主 spec 为底，并入父 delta 的首轮作答句、放宽轮询句、Note 与 Scenario「审批作答后完成对话」（逐字）；`skip` 模板句与末句变量子句裁到首轮作答条目，Scenario「smoke-live 跳过回合控制」保留标题、THEN 裁到作答条目。回合控制 (1)–(4) 与 Scenario「停止用例」归 #482（8.1b），「重新生成用例」归 #483（8.1c），「分叉用例」归 8.1d——后续切片以父文整句替换。
> - 「UI 走查对话步骤」：以主 spec 为底，并入父 delta 的作答子句（括注按真实 omp v18.0.10 实测次序改写：先 select、后 `tool_execution_start`，见 design E0-2；父 delta 与父 design.md:103 的反向表述待归档 PR 修正）、完成后 reload 仍 `已允许执行` 子句、双 project 句（裁到审批与 reload 两步）与 Scenario「审批条走查」（逐字）。停止/重新生成/分叉三步与其 Scenario 归 #484（8.2b）、#485（8.2c）、8.2d。

## MODIFIED Requirements

### Requirement: 手动真实上游冒烟入口
`make smoke-live` SHALL consume an already-running service without build/start/stop. If MODEL_UPSTREAM_BASE_URL or MODEL_UPSTREAM_API_KEY is absent or empty, it SHALL exit nonzero and identify the missing variable without printing its value or executing Hurl. Required values SHALL be transferred literally through Make and quoted shell expansion, without evaluating Make/shell syntax in their bytes. After gates, missing Hurl SHALL produce explicit installation guidance. Hurl SHALL run in a clean child environment containing only PATH, with `--test --jobs 1 --retry 0`, `base_url` from raw SMOKE_BASE_URL, `content_pattern=^.+$`, `min_bash_steps=0`, `skip_turn_control=true`, and only `smoke/chat.hurl`. Upstream gate values SHALL NOT appear in Hurl args/environment or diagnostics. Hurl failure SHALL propagate nonzero. The existing `make smoke` recipe SHALL change only by gaining `--variable "skip_turn_control=false"` (S1c A); the Make oracle SHALL pin both updated recipes.
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
`smoke/chat.hurl` SHALL independently start with empty cookies, login, create a session201 and send one prompt202. Because omp now runs with `--approval-mode write`, the controlled upstream's leading bash call blocks on an approval: when Hurl variable `skip_turn_control` is `false` the file SHALL poll messages GET with bounded retries until the captured assistant's `approvals` holds exactly one entry and that entry is pending (`decision` null), capture its `id` and answer `POST /api/sessions/:id/approvals/:approvalId {"decision":"allow"}` expecting 200 with `decision` `allow`. Every approval-answer entry (the pending-approval poll and the allow POST for the first prompt) carries `[Options]` `skip: {{skip_turn_control}}` (templated `skip`, supported by Hurl 8), so the same file serves both targets without conditionals and smoke-live (`skip_turn_control=true`) skips them. It SHALL then poll only messages GET with bounded per-entry retries whose total wait covers the 60s auto-allow window (so a `skip_turn_control=true` run relying on timeout auto-allow still completes; this widened bound also applies to `make smoke`, where a genuine failure therefore surfaces later) until the captured assistant and session are done; assert content matches `content_pattern`, bash step count is at least `min_bash_steps`, and every step is done. It SHALL logout, login as another account, verify session access404, logout, then verify bearer-free POST `/v1/chat/completions`401. It SHALL not require earlier smoke files or leave live authentication sessions/running turns. `make smoke` SHALL pass exact anchored fake reply, min_bash_steps1 and `skip_turn_control=false`; existing smoke-live passes nonempty shape, min_bash_steps0 and `skip_turn_control=true` through the same file (a real model may not call bash, so the approval-answer entries are skipped there and any real approval completes by 60s auto-allow within the widened poll window).
Note (non-normative): under smoke-live a real model may call bash several times in one turn; each unanswered approval then waits for the 60s auto-allow, so the worst-case wait is 60s×N. smoke-live is a manual target and this is accepted rather than answered.

#### Scenario: Real pinned runtime completes dialogue
- WHEN compiled app uses verified real omp18.0.10 and the existing controlled upstream, and make smoke runs twice
- THEN public/auth/chat all pass with exact reply `你好，这是 WorkBuddy 的第一条流式回复。`, at least one done bash step, completed captured assistant/session and account/proxy boundaries intact

#### Scenario: Oracle rejects false completion
- WHEN response text differs, captured assistant is not done, bash is missing or failed, a foreign account can read the session, or bearer-free proxy accepts the request
- THEN the chat oracle fails for the corresponding semantic assertion and does not retry the POST prompt

#### Scenario: 审批作答后完成对话
- **WHEN** make smoke (`skip_turn_control=false`) sends the first prompt against real omp in `--approval-mode write` and the controlled upstream
- **THEN** the messages poll observes the captured assistant with exactly one pending entry in `approvals` whose `tool` is `bash`, the allow POST returns 200 with `decision` `allow`, and the subsequent poll reaches the exact reply, one done bash step and done session well before the 60s auto-allow

#### Scenario: smoke-live 跳过回合控制
- **WHEN** smoke-live runs the same file with `skip_turn_control=true` against a real upstream
- **THEN** every entry gated by `skip_turn_control` — the approval-answer poll and POST for the first prompt — is skipped, the done poll tolerates up to the 60s auto-allow per approval, and the remaining assertions (nonempty content, min_bash_steps0, foreign account404, bearer-free401) are unchanged

### Requirement: UI 走查对话步骤
The existing Playwright production journey SHALL create a session through UI, send its fixed prompt template with an isolated test correlation UUID, answer the approval bar that real omp in `--approval-mode write` raises for the bash step (real omp v18.0.10 emits the approval select and then `tool_execution_start` without waiting for the answer, so the running bash step and the approval bar headed `需要你的确认` with `允许`/`拒绝` are visible together, in no asserted order; click `允许`, assert the header becomes `已允许执行` and the bash step reaches `已完成`), observe the bash step and nonempty assistant prefix, and reload while the actual server session and captured assistant remain running. The test upstream gate SHALL remain held through reload; fresh REST and DOM SHALL identify the same session and prefix before release, with a new native SSE connection observed. Explicit release SHALL produce the exact original fixed reply, done bash/session, and one user plus one assistant message. A second reload after completion SHALL preserve the identical complete messages and done state (the settled approval bar still reads `已允许执行` after reload). The whole journey — approval and reload steps — SHALL run in both Playwright projects, `desktop-light` (1440×900) and `mobile-dark` (390×844), each with its own sessions and gates. Browser route fulfillment, fake EventSource, delayed display of already completed server state and arbitrary timing sleeps SHALL NOT substitute for the real in-flight window.
Before release, the post-open recovery messages response SHALL finish and contain the running prefix, with no messages GET still in flight. From release until final suffix/done DOM assertions, any further messages GET SHALL fail the walkthrough, so completed REST cannot impersonate resumed native SSE. The later deliberate completed-page reload is outside this interval.
The preexisting login/four-route/theme/logout journey and browser error classifier SHALL remain unchanged: exactly two expected `/api/auth/me`401 and no unexpected console/page errors, including reconnect. Tests SHALL clean their gate in finally and consume caller-owned app/upstream without starting/stopping them.

#### Scenario: Real running reload and durable completion
- WHEN real pinned omp18.0.10, compiled app and controlled upstream serve the extended make ui-walk
- THEN running prefix and same session are observed before and after in-flight reload, release completes exact text and done state, completed reload retains both messages, and all prior journey/error assertions pass

#### Scenario: False progress cannot satisfy the oracle
- WHEN response was already terminal before reload, gate identity differs, restored prefix is lost, reconnect fails to deliver remaining text, final text differs or unexpected browser error occurs
- THEN the walkthrough fails rather than accepting a snapshot-only or fabricated success

- AND a candidate that establishes the new native connection and running recovery snapshot but suppresses subsequent stream data SHALL fail on missing suffix/completion

#### Scenario: 审批条走查
- **WHEN** the journey's first prompt is accepted by real omp in `--approval-mode write`
- **THEN** the assistant message shows a running bash step and a group named `需要你的确认` containing `允许` and `拒绝`; clicking `允许` disables both, the header becomes `已允许执行`, the bash step reaches `已完成` and the existing held-gate reload flow proceeds; after the completed reload the bar still reads `已允许执行`
