# chat-harness Specification

## Purpose
Define manual smoke gates and automated dialogue acceptance: credential-free Hurl invocation, exact or shape-only assertions over a caller-owned service, real pinned-omp CI integration, bounded job-owned process cleanup, and browser walkthroughs proving native streaming across genuine in-flight reload and durable completed reload.

## Requirements

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
`smoke/chat.hurl` SHALL independently start with empty cookies, login, create a session201 and send one prompt202. Because omp now runs with `--approval-mode write`, the controlled upstream's leading bash call blocks on an approval: when Hurl variable `skip_turn_control` is `false` the file SHALL poll messages GET with bounded retries until the captured assistant's `approvals` holds exactly one entry and that entry is pending (`decision` null), capture its `id` and answer `POST /api/sessions/:id/approvals/:approvalId {"decision":"allow"}` expecting 200 with `decision` `allow`. Every approval-answer entry (the pending-approval polls and the allow POSTs, for the first prompt and for both regenerates below) is gated by the same Hurl variable as every turn-control entry (stop, regenerate and the second-session entries): each carries `[Options]` `skip: {{skip_turn_control}}` (templated `skip`, supported by Hurl 8), so the same file serves both targets without conditionals and smoke-live (`skip_turn_control=true`) skips all of them. It SHALL then poll only messages GET with bounded per-entry retries whose total wait covers the 60s auto-allow window (so a `skip_turn_control=true` run relying on timeout auto-allow still completes; this widened bound also applies to `make smoke`, where a genuine failure therefore surfaces later) until the captured assistant and session are done; assert content matches `content_pattern`, bash step count is at least `min_bash_steps`, and every step is done. With `skip_turn_control` `false` it SHALL then exercise turn control, in this order: (1) stop on the already-done first session: `POST /api/sessions/:id/stop` → exact 204 with empty body; (2) regenerate on that first session: `POST /api/sessions/:id/regenerate` → exact 202 capturing `assistantMessageId`, which SHALL differ from the first captured assistant id; because `branch` rewinds the omp history to before the only user message, the controlled upstream again issues its bash call (no `tool` role in history, `hasToolRole`), so the file polls until the new assistant's `approvals` holds one pending entry, answers it `allow` (200) and polls messages until the session and the new assistant are done; the messages SHALL then contain exactly one user and exactly one assistant message, that assistant's id equals the regenerate-captured id (not the first captured id), its content matches `content_pattern` and its bash step is done; (4) because the controlled upstream issues its bash call only on a round whose history has no tool result (`hasToolRole`), the file SHALL create a **second** session201, prompt it202 and poll messages until that assistant's `approvals` holds one pending entry (the deterministic running point, since omp blocks on the select); `POST …/stop` on it → exact 202 with body `{}`; poll messages until that session's status is `stopped` and the captured assistant status is `stopped` (not `failed`), its sole approval's `decision` is `deny`, no step is `running`, and its bash step is `failed` (the Deny answer makes omp end the tool with `isError`, which settles the step `failed` before the abort ends the turn `stopped`); then `POST …/regenerate` on that stopped session (its stopped assistant is the last message, immediately preceded by the session's only user message) → exact 202 capturing an `assistantMessageId` that differs from the stopped assistant's id; because `branch` rewinds that session's omp history to before its only user message (whose entry SHALL therefore be present in omp's history although its turn was stopped, otherwise regenerate answers 502), the controlled upstream again issues its bash call, so the file polls until the new assistant's `approvals` holds one pending entry, answers it `allow` (200) and polls messages until the session and the new assistant are done; the messages SHALL then contain exactly one user and exactly one assistant message, that assistant's id equals this regenerate-captured id, its content matches `content_pattern` and its bash step is done; then a further prompt on that session → exact 202, polled to done with content matching `content_pattern` but no approval step and no bash-count assertion (its history already holds a tool result, so that round has no tool call), so no running turn is left behind. It SHALL logout, login as another account, verify session access404, logout, then verify bearer-free POST `/v1/chat/completions`401. It SHALL not require earlier smoke files or leave live authentication sessions/running turns. `make smoke` SHALL pass exact anchored fake reply, min_bash_steps1 and `skip_turn_control=false`; existing smoke-live passes nonempty shape, min_bash_steps0 and `skip_turn_control=true` through the same file (a real model may not call bash, so approval-answer, stop and regenerate entries, including the second session's follow-up prompt, are skipped there and any real approval completes by 60s auto-allow within the widened poll window).
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

#### Scenario: 停止用例
- **WHEN** make smoke issues stop on the already-done first session, then creates a second session, prompts it, waits for its pending approval and issues stop on it, then regenerates the stopped assistant and prompts that session once more
- **THEN** the first stop is exact 204; the second is exact 202; the messages poll reaches no running step, the bash step `failed` (denied), the sole approval `decision` `deny`, and the assistant and session both `stopped` — not `failed`; the regenerate on the stopped session returns exact 202 with an `assistantMessageId` different from the stopped assistant's, its pending bash approval is answered `allow` (200) and it completes to done with exactly one user and one assistant message (the regenerate-captured id), content matching the exact reply and a done bash step; the follow-up prompt is then accepted 202 and completes to done with matching content, leaving both sessions terminal at logout

#### Scenario: 重新生成用例
- **WHEN** make smoke (`skip_turn_control=false`), after the first session is done and its stop returned 204, issues `POST /api/sessions/:id/regenerate` on that session
- **THEN** the response is exact 202 whose `assistantMessageId` differs from the first captured assistant id; the new assistant raises one pending bash approval that the file answers `allow` (200); the poll reaches session and new assistant `done`, and the messages then contain exactly one user and exactly one assistant message, that assistant's id being the regenerate-captured id, with content matching the exact reply and a done bash step
- **WHEN** a candidate returns 202 but keeps the old assistant row, appends a second assistant row or reuses the old id
- **THEN** the exactly-one-assistant / changed-id assertion fails without retrying the regenerate POST

#### Scenario: smoke-live 跳过回合控制
- **WHEN** smoke-live runs the same file with `skip_turn_control=true` against a real upstream
- **THEN** every entry gated by `skip_turn_control` — the approval-answer polls/POSTs and the stop and regenerate entries including the second session's stop, regenerate and follow-up prompt — is skipped, the done poll tolerates up to the 60s auto-allow per approval, and the remaining assertions (nonempty content, min_bash_steps0, foreign account404, bearer-free401) are unchanged

### Requirement: Real-runtime CI harness ownership
CI smoke/ui-walk SHALL retain existing action identities/counts, setup/build/static roots and timeouts; fetch verified omp without a new cache action, start their own controlled loopback upstream before compiled app, pass explicit OMP_BIN/OMP_STATE_DIR/SANDBOX_ROOT and fake MODEL_UPSTREAM values, and invoke the existing Make target. `.github/scripts/ci-fake-upstream.sh` SHALL launch the existing Node fixture, not duplicate it. Existing cancellation/process-group/cleanup failure semantics SHALL remain; all job-owned upstream/omp processes SHALL be reaped on success, failure and cancellation. Two harness jobs SHALL not reference secrets or real model upstreams; existing secret-scan token is explicitly preserved by user decision.

#### Scenario: Independent jobs remain isolated
- WHEN smoke and ui-walk each execute with job-local paths and ports
- THEN verified binary and ready controlled upstream precede app readiness, harness result is propagated, owned children are gone after teardown and unrelated processes remain untouched

#### Scenario: Prerequisite and cleanup failures are visible
- WHEN fetch validation fails, upstream fails to start/readiness or exits early, app or harness fails, cancellation arrives, or owned children resist termination
- THEN the wrapper exits nonzero with bounded cleanup and credential-free diagnostics rather than silently skipping or substituting fake-omp

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

### Requirement: 对话验证控制面同步
AGENTS.md、constraints.yaml 与 Makefile 页头 SHALL 同步对话验证职责：omp-fetch 是官方 v18.0.10 二进制供给 prerequisite，evidence 为版本与 SHA 校验；smoke-live 是 caller-owned 真实上游手动验证，evidence 为非空 done 回复与退出码，Enforcement Index 为 review-only，不能作为已运行真实上游的声明。原 smoke/ui-walk SHALL 保持 block。constraints verification.surfaces SHALL 从八个增为十个。S0b 同 uid 凭证风险的登记 SHALL 按 ADR0010 在正式 merged-master uid-isolation job 与 aggregate 全绿后关闭；active strictness_profile.downgrades 不再含 s0b_same_uid_credential_exposure，其他三条登记保持不变，AGENTS.md 以 uid 隔离 block 行指向正式CI门禁。环境白名单本身仍不证明隔离，且此关闭不宣称任意生产部署已验收。

#### Scenario: 新增镜像完整且旧行为不变
- **WHEN** 执行 source-derived CI contract oracle 与 make test-guardrails
- **THEN** 四条命令的 matrix、constraints 与 Make targets 一致，新增条目有 command/evidence/required_at，server/ 与 smoke/ 目录描述包含对话，页头无延后 #107
- **AND** 不修改 Make recipes、CI workflow、产品代码、门禁阈值或既有 smoke/ui-walk block

#### Scenario: 文档伪镜像被拒绝
- **WHEN** 独立删除或改错新增条目、等级、页头职责，或重新引入已关闭的 same-uid downgrade，或只在注释/其他 owner 中放置替代文本，或添加任一四个目标的 spaced duplicate
- **THEN** oracle 非零，恢复合法源后通过；不把源码中仍有同名关键词当作有效镜像
