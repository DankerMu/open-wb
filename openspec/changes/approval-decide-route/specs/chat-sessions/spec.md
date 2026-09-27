# Spec delta: chat-sessions（#468 审批作答 REST 路由）

> 只含本 issue（父 tasks 5.2a）交付的部分：「会话 REST」以主 spec 为底，路由清单只加 `POST /api/sessions/:id/approvals/:approvalId`，并入父 delta 的 approvals 作答段（逐字）。未并入（保持主 spec 原样）：stop/regenerate/fork 路由与段落（→ #475 5.1a、#467 5.1b、#469 5.2b）；GET messages 的 `approvals` 字段、多条 pending 并存与 `stopped` 状态联合句（→ #476 5.3 与 stopped 相关切片）；`parent_session_id`/`omp_session_file` 不暴露句（→ 5.2b）。
> - Scenario「Owner and authentication isolation」第一个 WHEN 只加 approvals（父文的 stop/regenerate/fork 由对应切片补回）；第二个 WHEN 保持主 spec 原文（不写路由计数）。
> - Scenario「Approval answer, snapshot and settled conflict」保留父标题，只收作答面：去掉「reads the snapshot」及其 THEN 子句、超时 WHEN/THEN 整条（超时结算由 #464 交付、快照可见性 → #476，二者由 #476 补回）与并行 WHEN 中的快照子句（→ #476）。
> - Scenario「Stable public history and recent order」保持主 spec 原文（`approvals` 数组子句 → #476）。
> - 第一段「Unknown or foreign id-scoped requests … before body parsing」的 id-scoped 指会话 id；`approvalId` 行归属 404 的时机（body 解析之后、任何写入与发帧之前）见 tool-approval delta 引注（proposal 偏离 2）。

## MODIFIED Requirements

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages, POST /api/sessions/:id/prompt and POST /api/sessions/:id/approvals/:approvalId. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,output,status}]}],streamCursor:{epoch,seq}}, ordered createdAt/id and step ordinal; step output SHALL be a string, empty for a running step or a stored NULL. Session views SHALL contain only id,title,status,createdAt,updatedAt; Only the declared streamCursor boundary SHALL expose the generation epoch; other internal ownership/runtime fields and step timing fields SHALL NOT leak. The complete owner-scoped tree and synchronous supervisor.streamCursor(sessionId) SHALL be captured together in the same preParsing stack before done, with no await between them; the handler SHALL serialize only that cached pair. streamCursor SHALL NOT replace owner authorization.
POST /api/sessions/:id/approvals/:approvalId SHALL accept only application/json and an object with exactly decision:"allow"|"deny"; other shapes/media/malformed JSON SHALL return400 bad_request. `approvalId` SHALL be a canonical positive decimal integer naming a `chat_approvals` row whose message belongs to this session, otherwise404 not_found identical to a missing session. A row whose `decision` is already set SHALL return409 approval_settled with no writes. A pending row SHALL be settled in this order: in one transaction persist decision/decided_at and its `session.approval` audit row → answer the child (`Approve` for allow, `Deny` for deny) and cancel its timeout timer → publish `approval.resolved` → return200 with the settled approval object `{id,tool,title,requestedAt,expiresAt,decision}` (one element of the snapshot's `approvals` array).

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session, empty messages and streamCursor {epoch:0,seq:null}, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body, or calls approvals on it
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- WHEN an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- THEN list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields

#### Scenario: Approval answer, snapshot and settled conflict
- **WHEN** the real fake (`approval`) requests approval during a turn and the owner posts {decision:"allow"} to that approvalId, then posts {decision:"deny"} again
- **THEN** the first answer returns200 with `decision:"allow"` after the row and its audit row are committed together, and the child receives `Approve`; the second returns409 approval_settled with no writes; a non-canonical approvalId (`01`, `abc`) or an approval of another session returns404
- **WHEN** the real fake (`approval-parallel`) raises two approvals in one turn and the owner answers only the second
- **THEN** the second reads `allow` while the first stays `decision:null`, and answering the first later settles it independently
