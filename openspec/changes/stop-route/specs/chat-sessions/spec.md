# Spec delta: chat-sessions（#475 停止 REST 路由）

> 只含本 issue（父 tasks 5.1a）交付的部分：「会话 REST」以当前主 spec（#468 推进）原文为底，路由清单只加 `POST /api/sessions/:id/stop`，并入父 delta 的 stop 段。未并入（保持主 spec 原样）：
> - stop 段：父文把 stop 与 regenerate 合写为「bodyless content-parser owners」，这里只写 stop（单数改写，regenerate → #467 5.1b 原位补回）；「which holds the session's control claim for the call,」→ #465 4.4。
> - regenerate/fork 路由与段落（→ #467 5.1b、#469 5.2b）；GET messages 的 `approvals` 字段、多条 pending 并存与 `stopped` 状态联合句（→ #476 5.3 与 stopped 相关切片）；`parent_session_id`/`omp_session_file` 不暴露句（→ 5.2b）。
> - Scenario「Owner and authentication isolation」第一个 WHEN 只加 stop（regenerate/fork 由对应切片补回）；第二个 WHEN 保持主 spec 原文（不写路由计数）。
> - Scenario「Stop is accepted while running and idempotent otherwise」保留父标题：第一个 WHEN/THEN 逐字；「a stop is posted while an approval of that turn is pending」WHEN/THEN（决定/审计断言）→ #474 4.6；第三个 WHEN 只写 stop（regenerate → #467）。
> - Scenario「Stable public history and recent order」「Approval answer, snapshot and settled conflict」保持主 spec 原文。

## MODIFIED Requirements

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt, POST /api/sessions/:id/stop and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign session ids SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/stop SHALL be a bodyless content-parser owner (the logout precedent): any parsed body (including `{}`), empty-or-malformed JSON, unsupported media or an envelope above its minimal body limit SHALL return400 bad_request after authorization and before any supervisor call, frame or write. When the session is `running`, stop SHALL call supervisor.stop(sessionId) — which first settles every pending approval of that turn, if any exist (the pending set is the snapshot read on entry; it is not re-read before the `abort` frame), as `deny` (per approval: persist decision/decided_at and its `session.approval` audit row in one transaction → answer `Deny` → publish `approval.resolved`) and then writes the `abort` frame; when the turn's prompt frame is not yet written, stop instead records a stop intent and the supervisor writes `abort` right after that prompt's dispatch receipt resolves (after the stop call has returned), so stop neither cancels the dispatch nor compensates the accepted rows and the prompt request still returns its normal202 body (a failed acquisition or dispatch still follows the ordinary prompt compensation, and the intent never rewrites a terminal status another path reached first) — and return202 with body exactly `{}` without waiting for the turn to end; for any other status it SHALL return204 with no writes and no supervisor call. The stopped turn ends with `turn.end{status:"stopped"}` and session/assistant/running steps read `stopped`.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session; a non-canonical approvalId SHALL be rejected before body parsing, and an approvalId not owned by this session SHALL be rejected after body parsing but before any write, answer frame or publish. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls stop/approvals on it
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- WHEN an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- THEN list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields

#### Scenario: Stop is accepted while running and idempotent otherwise
- **WHEN** the owner posts stop on a running session backed by the real fake (`abort-ok`), then posts stop again after the turn has ended, and posts stop on an idle session
- **THEN** the first call returns202 with body exactly `{}` and no-store before the turn ends and the session/assistant/running steps subsequently read `stopped` with `turn.end{status:"stopped"}` published; the later calls return204 without writes; a subsequent prompt on the stopped session returns202
- **WHEN** stop is posted by the owner with a JSON body `{}`, malformed JSON, an empty JSON body, an unsupported media type or an oversized body
- **THEN** 400 bad_request with no-store is returned with no supervisor call, no frame and no write

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently
