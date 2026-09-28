# Spec delta: chat-sessions（#467 regenerate REST、prompt 受理前占用拒绝与 REST prompt 增量）

> 只含本 issue（父 tasks 5.1b）交付的部分：
> - 「会话 REST」，以主 spec（#475/#468 推进后）为底：
>   - 路由清单只加 `POST /api/sessions/:id/regenerate`，fork → #469（5.2b）；
>   - 按 carry-forward 恢复父文的 stop+regenerate 合写 bodyless 段，整段替换 #475 的 stop 单数段，不是追加。这一段顺带并入「which holds the session's control claim for the call」。这是 #465 已交付的行为（`supervisor.stop` 在 `ControlClaims.during` 内执行），chat-sessions 此前没有 owner；
>   - 并入父文 regenerate 段（逐字）；fork 段 → #469；
>   - GET messages 句中的 `stopped` 联合句与 `parent_session_id`/`omp_session_file` 不暴露括注不归本刀（carry-forward :78，#476 归档或 #486），保持主 spec 原样；
>   - Scenario「Owner and authentication isolation」：第一个 WHEN 只加 regenerate（fork → #469）；401 的 WHEN 保持主 spec，父文「on any of the eight routes」→ #469；
>   - Scenario「Stop is accepted…」末个 WHEN 取父文「stop or regenerate」；
>   - 新增 Scenario「Regenerate replaces only the last assistant message」（父文逐字）。其末个 WHEN 中的 fork 注入已由 #466 在 supervisor 层交付（`session-fork.test.ts` R4），本刀补 prompt 与 regenerate 的 REST 注入。Scenario「Fork copies history…」→ #469。
> - 「REST prompt 受理与补偿」：父 delta 同名块逐字（整块交付），即控制占用 409 且检查与受理之间无 await、`agent_capacity` → 503、`stopped` 可发。#463（omp-pool-admission 偏离 10）已把后两项指派给本刀。
> - 「Supervisor dispatch and generation binding」：以主 spec 为底，只把 Scenario「Regenerate on a reclaimed session」的 WHEN 换为父文 REST 面（「the owner posts regenerate」）。首段「Regenerate and fork (Requirement「会话 REST」)」的引注同时指向 fork 路由，→ #469；Scenario「Fork temporary runtime is not a generation」的 REST 面 WHEN → #469。

## MODIFIED Requirements

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop, POST /api/sessions/:id/regenerate and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign session ids SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,approvals,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. `approvals` SHALL be present on every message as an array of all `chat_approvals` rows of that message in ascending id order, each `{id,tool,title,requestedAt,expiresAt,decision}` with `decision` ∈ `allow|deny|timeout|null`; it SHALL be `[]` for a user message and for an assistant message without approval rows. Several pending (`decision:null`) entries MAY coexist on one message (parallel tool calls); a later approval request never replaces an earlier entry. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop and POST /api/sessions/:id/regenerate SHALL be bodyless content-parser owners (the logout precedent): any parsed body (including `{}`), empty-or-malformed JSON, unsupported media or an envelope above their minimal body limit SHALL return400 bad_request after authorization and before any supervisor call, frame or write. When the session is `running`, stop SHALL call supervisor.stop(sessionId) — which holds the session's control claim for the call, first settles every pending approval of that turn, if any exist (the pending set is the snapshot read on entry; it is not re-read before the `abort` frame), as `deny` (per approval: persist decision/decided_at and its `session.approval` audit row in one transaction → answer `Deny` → publish `approval.resolved`) and then writes the `abort` frame; when the turn's prompt frame is not yet written, stop instead records a stop intent and the supervisor writes `abort` right after that prompt's dispatch receipt resolves (after the stop call has returned), so stop neither cancels the dispatch nor compensates the accepted rows and the prompt request still returns its normal202 body (a failed acquisition or dispatch still follows the ordinary prompt compensation, and the intent never rewrites a terminal status another path reached first) — and return202 with body exactly `{}` without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/regenerate: a `running` session, or a session whose control claim is held by another regenerate, fork or stop, SHALL return409 session_busy. A session whose history does not end with an assistant message immediately preceded by a user message SHALL return400 bad_request. Otherwise it SHALL call supervisor.regenerate(sessionId), which registers the session's control claim with the last assistant message id read by the precheck and releases it once dispatch completes or the response returns: acquire the session's process — reusing a live one, or through the same lazy acquisition as prompt (a normal new generation, stream_epoch+1 with a fresh ring) when it has been reclaimed — through the process cap (`agent_capacity` → 503), `get_branch_messages`, pick the entry whose position is last and whose `text` equals the stored last user message content (any mismatch → 502 agent_unavailable with no row change), `branch{entryId}`, `get_state`, then in one SQLite transaction — which SHALL first recheck that the session status is not `running` and its last assistant message id still equals the precheck's, otherwise write nothing, retire the process and return409 session_busy — delete the old assistant row (steps and approvals cascade), insert a new empty `running` assistant row, set `omp_session_file` to the new file and session status `running`, and dispatch the branch-returned text as the prompt; it SHALL return202 {assistantMessageId} of the new row. Runtime failure before the transaction SHALL leave every row unchanged and map to502 agent_unavailable; dispatch failure after the transaction SHALL settle the new assistant row and session as `failed`, return502 agent_unavailable (rows are already terminal, nothing is compensated) and SHALL NOT resurrect the deleted row.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session; a non-canonical approvalId SHALL be rejected before body parsing, and an approvalId not owned by this session SHALL be rejected after body parsing but before any write, answer frame or publish. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/regenerate/approvals on it
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- **WHEN** an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- **THEN** list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields, every message carrying an `approvals` array (`[]` when it has no approval rows)

#### Scenario: Stop is accepted while running and idempotent otherwise
- **WHEN** the owner posts stop on a running session backed by the real fake (`abort-ok`), then posts stop again after the turn has ended, and posts stop on an idle session
- **THEN** the first call returns202 with body exactly `{}` and no-store before the turn ends and the session/assistant/running steps subsequently read `stopped` with `turn.end{status:"stopped"}` published; the later calls return204 without writes; a subsequent prompt on the stopped session returns202
- **WHEN** a stop is posted while an approval of that turn is pending
- **THEN** the approval row reads `deny` and its `session.approval` audit row is committed with it, the child receives `Deny` before the `abort` frame (fake probe order), `approval.resolved{decision:"deny"}` precedes `turn.end{status:"stopped"}`
- **WHEN** stop or regenerate is posted by the owner with a JSON body `{}`, malformed JSON, an empty JSON body, an unsupported media type or an oversized body
- **THEN** 400 bad_request with no-store is returned with no supervisor call, no frame and no write

#### Scenario: Regenerate replaces only the last assistant message
- **WHEN** the owner posts regenerate on a done/failed/stopped session whose last two messages are user U then assistant A, backed by the real fake (`branch`)
- **THEN** 202 {assistantMessageId} names a new running assistant row, A and its steps are gone, U and earlier rows are unchanged, `omp_session_file` equals the branch-created file, and the new turn runs with U's text
- **WHEN** the session is running, or its history is empty/ends with a user message, or `get_branch_messages` yields no entry whose text equals U
- **THEN** 409 session_busy, 400 bad_request or 502 agent_unavailable respectively, with no row change
- **WHEN** the session's process was reclaimed by idle before regenerate
- **THEN** 202 is returned, `streamCursor.epoch` is the previous value plus one and the new generation's SSE delivers turn.start then turn.end for the new assistant row
- **WHEN** a prompt, regenerate or fork for the same session arrives between regenerate's RPCs, or a test-injected write changes the session status or last assistant id before the final transaction
- **THEN** the concurrent request returns409 session_busy with no row change; a failed final recheck returns409 session_busy, writes nothing and retires the process

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner reads the snapshot, then posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the snapshot's running assistant message carries `approvals:[{id,tool:"bash",title,requestedAt,expiresAt,decision:null}]` while user messages carry `approvals:[]`; the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** no answer arrives within 60s of the injected clock
- **THEN** the row reads `timeout`, the child receives `Approve`, `approval.resolved{decision:"timeout"}` is published and the snapshot shows `decision:"timeout"`
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the snapshot lists both in ascending id order, the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently

### Requirement: REST prompt 受理与补偿
The prompt route SHALL accept only application/json and an object with exactly message:string. It SHALL trim the string once and require nonempty text of at most32768 UTF-8 bytes. Invalid shape, media, malformed JSON or oversized parser envelope SHALL return400 bad_request; decoded valid escape-heavy text SHALL NOT be rejected merely because its wire JSON exceeds32768 bytes. The existing bounded parser envelope remains distinct from the semantic message limit.
The route SHALL use store.acceptPrompt(sessionId,principal.id,text) for the atomic admission and then await supervisor.prompt(sessionId,text). The owned SessionSupervisorPort SHALL expose prompt(sessionId:string,text:string):Promise<void>; resolution means dispatch accepted, not turn finished. Successful admission SHALL return202 {userMessageId,assistantMessageId} from that exact store admission. Running sessions SHALL return409 session_busy without added rows or dispatch; so SHALL a session whose supervisor control claim is held by an in-progress regenerate, fork or stop — the claim check and admission SHALL run without an intervening await; idle/done/failed/stopped SHALL be eligible.
Supervisor rejection SHALL compensate the unprogressed accepted pair through store.rollbackPrompt before returning the canonical error. HttpError agent_unavailable SHALL produce502, HttpError session_busy SHALL produce409, HttpError agent_capacity SHALL produce503; unknown failures SHALL remain generic5xx. Compensation failure SHALL propagate as generic5xx, not be masked as502/409/503. The supervisor SHALL NOT reject after publishing/persisting progress; post-dispatch failures belong to supervisor lifecycle. No retries or real runtime/SSE implementation are part of this boundary.

#### Scenario: Accepted prompt and concurrent busy
- **WHEN** a valid prompt is admitted while the stub supervisor is held pending
- **THEN** the real store has one user-done and one empty assistant-running message, with trimmed text and title; a concurrent second prompt returns409 without changing rows
- **WHEN** the pending supervisor resolves
- **THEN** the first request returns202 with precisely those two IDs, without waiting for terminal turn completion
- **WHEN** a valid prompt arrives while a regenerate, fork or stop holds that session's control claim
- **THEN** 409 session_busy is returned with no added rows and no dispatch

#### Scenario: Input boundaries
- **WHEN** message is empty after trim, has a wrong type, is in an array/null/extra-key object, or exceeds32768 decoded UTF-8 bytes, or the request has wrong media/malformed JSON/oversized envelope
- **THEN** 400 bad_request/no-store occurs without admission or dispatch
- **WHEN** trimmed text is exactly32768 UTF-8 bytes, including multibyte and JSON-escaped content
- **THEN** 202 is possible and the same trimmed text reaches storage and supervisor

#### Scenario: Failed dispatch restores prior state
- **WHEN** the stub supervisor rejects with canonical agent_unavailable, session_busy or agent_capacity after a new admission from idle/done/failed/stopped
- **THEN** 502, 409 or 503 respectively is returned, prior title/status/updatedAt/history is preserved and the admitted pair removed; a later prompt can succeed
- **WHEN** admission itself rejects
- **THEN** the supervisor is not called and another active turn is not rolled back

#### Scenario: Unknown and compensation failures
- **WHEN** the supervisor throws an untyped error, including a forged status/code shape
- **THEN** its unprogressed admission is compensated and the response is generic5xx without leaking raw error data
- **WHEN** rollback itself fails
- **THEN** generic5xx is returned without falsely reporting restored state or masking the storage failure as agent_unavailable

#### Scenario: Terminal sessions can prompt again
- **WHEN** the real store completes an accepted turn as done, failed or stopped, and the owner sends another valid prompt
- **THEN** the next prompt returns202 with new IDs, retaining previous history and the established title

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner and resume metadata. On the prompt path it SHALL neither admit nor compensate a pair itself. Regenerate and fork are supervisor-owned admission and compensation paths: the supervisor SHALL perform their single final SQLite transaction (including the control-claim recheck) and their failure compensation (retiring the process, shutting down a fork's temporary process, or settling a dispatched regenerate assistant row `failed`). The supervisor SHALL hold a per-session control claim for regenerate, fork and stop from a passed precheck until dispatch completes or the response is returned; while it is held, prompt, regenerate and fork on that session SHALL be rejected with session_busy (a stop after regenerate has dispatched proceeds normally because the session is then `running`), and the claimed session's process counts as in-turn for the process cap. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error. On the regenerate and fork paths the failure mapping of turn-control「重新生成 REST」and「从此处分叉 REST」takes precedence over this rule: a storage fault of their final transaction, and any regenerate dispatch failure after that transaction commits, SHALL reject with agent_unavailable; a failed control-claim recheck SHALL reject with session_busy.
The supervisor SHALL await the exact runtime dispatch receipt and persist the validated sessionFile before resolving the REST port, without consuming business frames first. Pre-progress failure SHALL retire/discard that runtime before rejecting so REST can compensate. No post-progress error SHALL reject the already-accepted REST operation.
Every runtime generation acquisition, including idle re-spawn, crash recovery and a regenerate on a session whose process has been reclaimed or evicted, SHALL increment stream_epoch exactly once via the existing store method before shared-token issuance; reuse of a live generation SHALL not increment it. Regenerate SHALL acquire that normal generation (epoch+1, a fresh ring) through the same lazy acquisition path as prompt. A fork's temporary runtime is not a generation: it SHALL NOT bump either session's stream_epoch, own a ring, publish events or bind a session slot, and counts only against the process cap. Failed acquisition may advance epoch independently of REST compensation. Runtime SHALL retain token-revocation ownership; native exit SHALL make that generation token invalid, without stale callbacks revoking a newer token. No requestId SHALL be guessed from an ACK.
#### Scenario: Cold start and reuse
- WHEN an owner prompts a new session and later prompts the same healthy runtime again
- THEN both requests return202 after dispatch, sessionFile is stored, one generation/epoch/token is used and no duplicate native child is spawned
#### Scenario: Failed acquisition compensation
- WHEN binary acquisition or nonempty-sessionFile handshake fails
- THEN prompt returns502, no business frames are persisted/published, the child/token is retired and REST restores prior pair/title/status/history while independent generation metadata may advance
#### Scenario: Idle and crash re-spawn
- WHEN a runtime is retired by idle or by a mid-turn crash and another prompt arrives
- THEN the next generation uses the persisted resume path, epoch increases once, the old token is invalid and its late callbacks cannot revoke the new token
#### Scenario: Retiring instance cannot revoke replacement
- WHEN a transport-failed runtime's native exit is delayed and a new prompt is admitted for that session
- THEN replacement acquisition waits for prior retirement/pump settlement, no replacement token is issued while the old instance can revoke, and later stale callbacks cannot invalidate the replacement; other sessions remain usable
#### Scenario: Generation adapter failure provenance
- WHEN epoch persistence or shared-registry issuance throws during runtime acquisition
- THEN the original generic failure is retained despite runtime sanitization, REST does not report502, its unprogressed admission is compensated, and no token/child remains leaked
#### Scenario: Dispatch metadata storage fault
- WHEN the prompt write succeeds but persisting validated sessionFile fails before any business frame is consumed
- THEN the runtime is retired, REST receives a generic failure and compensates its unprogressed admission; no background work continues against removed rows

#### Scenario: Regenerate on a reclaimed session
- **WHEN** a done session's process has been retired by idle or eviction and the owner posts regenerate
- **THEN** the process is re-acquired through the prompt path with `--resume`, `streamCursor.epoch` is the previous value plus one, and an SSE subscriber of the new generation receives turn.start followed by turn.end for the new assistant message

#### Scenario: Fork temporary runtime is not a generation
- **WHEN** fork is called for a session with a live idle process and the fork succeeds
- **THEN** the source's live idle process was retired before the temporary process started, neither the source nor the new session's `stream_epoch` changed, no event was published to any ring and the temporary process has exited before the response

#### Scenario: Control claim excludes concurrent turn operations
- **WHEN** a regenerate or fork holds the control claim (the fake held between `get_branch_messages` and `branch`, and between `branch` and `get_state`) and a prompt, regenerate or fork arrives for the same session
- **THEN** each concurrent request returns409 session_busy with no row, file or process change; after the claimed operation finishes the claim is released and a later prompt is admitted
