# Spec delta: chat-harness（#492，父 tasks 8.2d）

> 「UI 走查对话步骤」：以当前主 spec 原文（#485 归档后）为底，并入父 delta 余下的全部差异：
> - 分叉步骤句（「The walkthrough SHALL then add a fork step … with no prompt POST issued for the new session.」逐字），接在重新生成步骤句之后；
> - 双 project 句的枚举「stop and regenerate steps」→「stop, regenerate and fork steps」；
> - 禁止区间句的枚举「the stop and regenerate steps」→「the stop, regenerate and fork steps」；
> - Scenario「分叉走查」（逐字），接在 Scenario「重新生成走查」之后。
>
> 本刀之后整块与父 delta 同名块逐字一致（design「Spec 对账」），#484/#485 留下的两处部分交付句由父文整句替换。父块不缺主 spec 已有的任何文字；其余文字与五个既有 Scenario 保持主 spec 原样。

## MODIFIED Requirements

### Requirement: UI 走查对话步骤
The existing Playwright production journey SHALL create a session through UI, send its fixed prompt template with an isolated test correlation UUID, answer the approval bar that real omp in `--approval-mode write` raises for the bash step (real omp v18.0.10 emits the approval select and then `tool_execution_start` without waiting for the answer, so the running bash step and the approval bar headed `需要你的确认` with `允许`/`拒绝` are visible together, in no asserted order; click `允许`, assert the header becomes `已允许执行` and the bash step reaches `已完成`), observe the bash step and nonempty assistant prefix, and reload while the actual server session and captured assistant remain running. The test upstream gate SHALL remain held through reload; fresh REST and DOM SHALL identify the same session and prefix before release, with a new native SSE connection observed. Explicit release SHALL produce the exact original fixed reply, done bash/session, and one user plus one assistant message. A second reload after completion SHALL preserve the identical complete messages and done state (the settled approval bar still reads `已允许执行` after reload). After that completed reload the walkthrough SHALL add a stop step on the same session: arm a second gate, send a second templated prompt (the controlled upstream issues no tool call on a session's later rounds, so no approval is raised), wait until the gate reports `held` (a controlled running turn), click the composer `停止` button (aria-label `停止`, in place of `发送`), assert `Toast` `已停止生成`, the session status element `<title> 已停止`, the second assistant message's trailing `role="status"` badge `已停止` (accessible name `助手消息 已停止`, chat-web `会话页`) with no error text, and the composer unlocked with `发送` back; the held response is destroyed by disconnect (the abort closes omp's upstream request, which removes the gate) and the gate is deleted in finally, without releasing it. The walkthrough SHALL then add a regenerate step on the same session: before clicking, it SHALL delete the second gate (its DELETE answers 204 when the gate still exists or 404 when the abort already destroyed it; both are accepted) and assert that the gate's GET then answers 404, so the regenerated round can never meet a still-`held` gate (which would answer 409 and fail the round); the stopped second assistant is the last message, so its `重新生成` button (accessible name `重新生成`) is visible; clicking it SHALL show `Toast` `正在重新生成…`, and — because the regenerated round replays the second templated prompt whose gate no longer exists, and its history already carries the first round's tool result so the controlled upstream issues no tool call and no approval — the transcript SHALL settle to two user and two assistant messages in which the last assistant has a new identity (its `已停止` badge gone), the exact original fixed reply and done state, with the session status element `<title> 已完成` and the composer unlocked. The walkthrough SHALL then add a fork step: clicking `从此处分叉` (accessible name `从此处分叉`) on the first user message SHALL navigate to `?session=<new id>` different from the walked session, show an empty transcript (zero messages, no `重新生成`), list the new session in the sidebar with status element `<title> 未开始`, and fill the composer draft with exactly the first templated prompt text, with no prompt POST issued for the new session. The whole journey — approval, reload, stop, regenerate and fork steps — SHALL run in both Playwright projects, `desktop-light` (1440×900) and `mobile-dark` (390×844), each with its own sessions and gates. Browser route fulfillment, fake EventSource, delayed display of already completed server state and arbitrary timing sleeps SHALL NOT substitute for the real in-flight window.
Before release, the post-open recovery messages response SHALL finish and contain the running prefix, with no messages GET still in flight. From release until final suffix/done DOM assertions, any further messages GET SHALL fail the walkthrough, so completed REST cannot impersonate resumed native SSE. The later deliberate completed-page reload and the stop, regenerate and fork steps (whose page reconciliation legitimately issues messages GETs) are outside this interval.
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
- **THEN** the composer shows `停止` and `生成中` instead of `发送`; clicking `停止` shows `Toast` `已停止生成`, the sidebar status becomes `<title> 已停止`, the second assistant message shows the `role="status"` badge named `助手消息 已停止` with no error text, the composer shows `发送` again, no unexpected console/page error is recorded, and the gate is deleted in finally

#### Scenario: 重新生成走查
- **WHEN** in each Playwright project (`desktop-light` 1440×900, `mobile-dark` 390×844), after the stop step, the walkthrough deletes the second gate, observes it absent, and then clicks `重新生成` on the stopped last assistant message
- **THEN** `Toast` `正在重新生成…` appears, no approval bar is raised, the last assistant loses its `助手消息 已停止` badge and reaches the exact original fixed reply and done state, the transcript holds exactly two user and two assistant messages, the sidebar status becomes `<title> 已完成`, the composer is unlocked and no unexpected console/page error is recorded

#### Scenario: 分叉走查
- **WHEN** in each Playwright project (`desktop-light` 1440×900, `mobile-dark` 390×844), after the regenerate step, the walkthrough clicks `从此处分叉` on the first user message
- **THEN** the URL selects a new `?session=<id>` different from the walked session, the transcript is empty with no `重新生成`, the sidebar lists the new session with status `<title> 未开始`, the composer draft equals the first templated prompt text exactly, no prompt POST is issued for the new session, and no unexpected console/page error is recorded
