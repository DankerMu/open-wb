# Spec delta: chat-harness（S1c A 修改）

> 本 delta 按仓内先例**整段重述**被修改的 Requirement（含其全部 Scenario）；归档时以本文整段替换 promoted 的同名 Requirement，未在此重述的 Requirement 不变。

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
`smoke/chat.hurl` SHALL independently start with empty cookies, login, create a session201 and send one prompt202. Because omp now runs with `--approval-mode write`, the controlled upstream's leading bash call blocks on an approval: when Hurl variable `skip_turn_control` is `false` the file SHALL poll messages GET with bounded retries until the captured assistant's `approval` is pending (`decision` null), capture its `id` and answer `POST /api/sessions/:id/approvals/:approvalId {"decision":"allow"}` expecting 200 with `decision` `allow`; every approval-answer and turn-control entry carries `[Options]` `skip: {{skip_turn_control}}` (templated `skip`, supported by Hurl 8) so the same file serves both targets without conditionals. It SHALL then poll only messages GET with bounded per-entry retries whose total wait covers the 60s auto-allow window (so a `skip_turn_control=true` run relying on timeout auto-allow still completes; this widened bound also applies to `make smoke`, where a genuine failure therefore surfaces later) until the captured assistant and session are done; assert content matches `content_pattern`, bash step count is at least `min_bash_steps`, and every step is done. With `skip_turn_control` `false` it SHALL then exercise turn control: `POST /api/sessions/:id/stop` on the first, done session → exact 204 with empty body; because the controlled upstream issues its bash call only on a session's first upstream round (`hasToolRole`), the file SHALL create a **second** session201, prompt it202 and poll messages until that assistant's approval is pending (the deterministic running point, since omp blocks on the select); `POST …/stop` on it → exact 202; poll messages until that session's status is `stopped`, the captured assistant status is `stopped`, its `approval.decision` is `deny` and no step is still `running`; then a further prompt on that stopped session → exact 202, polled to done with content matching `content_pattern` but no approval step and no bash-count assertion (that round has no tool call), so no running turn is left behind. It SHALL logout, login as another account, verify session access404, logout, then verify bearer-free POST `/v1/chat/completions`401. It SHALL not require earlier smoke files or leave live authentication sessions/running turns. `make smoke` SHALL pass exact anchored fake reply, min_bash_steps1 and `skip_turn_control=false`; existing smoke-live passes nonempty shape, min_bash_steps0 and `skip_turn_control=true` through the same file (a real model may not call bash, so approval and stop entries are skipped there and any real approval completes by 60s auto-allow within the widened poll window).

#### Scenario: Real pinned runtime completes dialogue
- WHEN compiled app uses verified real omp18.0.10 and the existing controlled upstream, and make smoke runs twice
- THEN public/auth/chat all pass with exact reply `你好，这是 WorkBuddy 的第一条流式回复。`, at least one done bash step, completed captured assistant/session and account/proxy boundaries intact

#### Scenario: Oracle rejects false completion
- WHEN response text differs, captured assistant is not done, bash is missing or failed, a foreign account can read the session, or bearer-free proxy accepts the request
- THEN the chat oracle fails for the corresponding semantic assertion and does not retry the POST prompt

#### Scenario: 审批作答后完成对话
- **WHEN** make smoke (`skip_turn_control=false`) sends the first prompt against real omp in `--approval-mode write` and the controlled upstream
- **THEN** the messages poll observes the captured assistant with a pending `approval` whose `tool` is `bash`, the allow POST returns 200 with `decision` `allow`, and the subsequent poll reaches the exact reply, one done bash step and done session well before the 60s auto-allow

#### Scenario: 停止用例
- **WHEN** make smoke issues stop on the done first session, then creates a second session, prompts it, waits for its pending approval and issues stop on it
- **THEN** the first stop is exact 204; the second is exact 202; the messages poll reaches session `stopped`, assistant `stopped`, approval `decision` `deny` and no running step without any error status; the follow-up prompt on the stopped session is accepted 202 and completes to done with matching content, leaving both sessions terminal at logout

#### Scenario: smoke-live 跳过回合控制
- **WHEN** smoke-live runs the same file with `skip_turn_control=true` against a real upstream
- **THEN** approval-answer and stop entries are skipped, the done poll tolerates up to the 60s auto-allow per approval, and the remaining assertions (nonempty content, min_bash_steps0, foreign account404, bearer-free401) are unchanged

### Requirement: UI 走查对话步骤
The existing Playwright production journey SHALL create a session through UI, send its fixed prompt template with an isolated test correlation UUID, answer the approval bar that real omp in `--approval-mode write` raises for the bash step (real omp emits `tool_execution_start` before the wrapper's select, so the running bash step and the approval bar headed `需要你的确认` with `允许`/`拒绝` are visible together; click `允许`, assert the header becomes `已允许执行` and the bash step reaches `已完成`), observe the bash step and nonempty assistant prefix, and reload while the actual server session and captured assistant remain running. The test upstream gate SHALL remain held through reload; fresh REST and DOM SHALL identify the same session and prefix before release, with a new native SSE connection observed. Explicit release SHALL produce the exact original fixed reply, done bash/session, and one user plus one assistant message. A second reload after completion SHALL preserve the identical complete messages and done state (the settled approval bar still reads `已允许执行` after reload). After that completed reload the walkthrough SHALL add a stop step on the same session: arm a second gate, send a second templated prompt (the controlled upstream issues no tool call on a session's later rounds, so no approval is raised), wait until the gate reports `held` (a controlled running turn), click the composer `停止` button (aria-label `停止`, in place of `发送`), assert `Toast` `已停止生成`, the session status element `<title> 已停止`, the second assistant message status `已停止` and the composer unlocked with `发送` back; the held response is destroyed by disconnect and the gate is deleted in finally, without releasing it. Browser route fulfillment, fake EventSource, delayed display of already completed server state and arbitrary timing sleeps SHALL NOT substitute for the real in-flight window.
Before release, the post-open recovery messages response SHALL finish and contain the running prefix, with no messages GET still in flight. From release until final suffix/done DOM assertions, any further messages GET SHALL fail the walkthrough, so completed REST cannot impersonate resumed native SSE. The later deliberate completed-page reload is outside this interval.
The preexisting login/four-route/theme/logout journey and browser error classifier SHALL remain unchanged: exactly two expected `/api/auth/me`401 and no unexpected console/page errors, including reconnect. Tests SHALL clean their gates (both) in finally and consume caller-owned app/upstream without starting/stopping them.

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

#### Scenario: 停止按钮走查
- **WHEN** after the completed reload a second gated prompt is sent on the same session (no tool round, hence no approval) and the gate is `held`
- **THEN** the composer shows `停止` and `生成中` instead of `发送`; clicking `停止` shows `Toast` `已停止生成`, the sidebar status becomes `<title> 已停止`, the second assistant message reads `已停止` with no error text, the composer shows `发送` again, no unexpected console/page error is recorded, and the gate is deleted in finally
