## ADDED Requirements

### Requirement: 会话 REST
registerSessionRoutes(app,{store,supervisor}) SHALL register GET/POST /api/sessions, GET /api/sessions/:id/messages and POST /api/sessions/:id/prompt. All SHALL use the existing cookie guard and authenticated principal.id; all matched responses SHALL carry Cache-Control:no-store without changing sibling routes. Unauthenticated requests SHALL return401 before body parsing. Unknown or foreign id-scoped requests SHALL return identical404 not_found before body parsing, with no writes or supervisor dispatch.
Id-scoped authorization SHALL use the existing owner-scoped store.getMessages(sessionId,principal.id) null result before parsing; acceptPrompt SHALL independently recheck ownership on admission. REST SHALL NOT use the trusted-supervisor-only runtimeState accessor for authorization.
POST /api/sessions SHALL return201 {id,title:null,status:"idle",createdAt,updatedAt}. GET /api/sessions SHALL return200 {sessions:[...]} restricted to the owner and ordered updatedAt descending with the store's stable tie-break. GET messages SHALL return200 {session,messages:[{id,role,content,status,createdAt,steps:[{id,ordinal,name,detail,status}]}]}, ordered createdAt/id and step ordinal. Session views SHALL contain only id,title,status,createdAt,updatedAt; internal ownership/runtime fields and step timing fields SHALL NOT leak.

#### Scenario: Create list and empty history
- WHEN an authenticated account creates a session and reads its list and history
- THEN create returns201 idle/null-title, list includes that session, history returns the same public session and empty messages, all with no-store

#### Scenario: Owner and authentication isolation
- WHEN a second account lists sessions or reads/prompts the first account's session, including an invalid prompt body
- THEN its list excludes that session and id-scoped requests return404 with no-store and no supervisor call or database mutation, identical to an unknown id
- WHEN no valid cookie is supplied, including malformed/oversized bodies
- THEN401 with no-store occurs before parsing or mutation

#### Scenario: Stable public history and recent order
- WHEN an owner admits a prompt on an older session, and the real store has messages and steps with terminal states
- THEN list reflects store updatedAt ordering, history preserves content/status/IDs and chronological/ordinal ordering, and contains only the declared public fields

### Requirement: REST prompt 受理与补偿
The prompt route SHALL accept only application/json and an object with exactly message:string. It SHALL trim the string once and require nonempty text of at most32768 UTF-8 bytes. Invalid shape, media, malformed JSON or oversized parser envelope SHALL return400 bad_request; decoded valid escape-heavy text SHALL NOT be rejected merely because its wire JSON exceeds32768 bytes. The existing bounded parser envelope remains distinct from the semantic message limit.
The route SHALL use store.acceptPrompt(sessionId,principal.id,text) for the atomic admission and then await supervisor.prompt(sessionId,text). The owned SessionSupervisorPort SHALL expose prompt(sessionId:string,text:string):Promise<void>; resolution means dispatch accepted, not turn finished. Successful admission SHALL return202 {userMessageId,assistantMessageId} from that exact store admission. Running sessions SHALL return409 session_busy without added rows or dispatch; idle/done/failed SHALL be eligible.
Supervisor rejection SHALL compensate the unprogressed accepted pair through store.rollbackPrompt before returning the canonical error. HttpError agent_unavailable SHALL produce502, HttpError session_busy SHALL produce409; unknown failures SHALL remain generic5xx. Compensation failure SHALL propagate as generic5xx, not be masked as502/409. The supervisor SHALL NOT reject after publishing/persisting progress; post-dispatch failures belong to supervisor lifecycle. No retries or real runtime/SSE implementation are part of this boundary.

#### Scenario: Accepted prompt and concurrent busy
- WHEN a valid prompt is admitted while the stub supervisor is held pending
- THEN the real store has one user-done and one empty assistant-running message, with trimmed text and title; a concurrent second prompt returns409 without changing rows
- WHEN the pending supervisor resolves
- THEN the first request returns202 with precisely those two IDs, without waiting for terminal turn completion

#### Scenario: Input boundaries
- WHEN message is empty after trim, has a wrong type, is in an array/null/extra-key object, or exceeds32768 decoded UTF-8 bytes, or the request has wrong media/malformed JSON/oversized envelope
- THEN400 bad_request/no-store occurs without admission or dispatch
- WHEN trimmed text is exactly32768 UTF-8 bytes, including multibyte and JSON-escaped content
- THEN202 is possible and the same trimmed text reaches storage and supervisor

#### Scenario: Failed dispatch restores prior state
- WHEN the stub supervisor rejects with canonical agent_unavailable or session_busy after a new admission from idle/done/failed
- THEN502 or409 respectively is returned, prior title/status/updatedAt/history is preserved and the admitted pair removed; a later prompt can succeed
- WHEN admission itself rejects
- THEN the supervisor is not called and another active turn is not rolled back

#### Scenario: Unknown and compensation failures
- WHEN the supervisor throws an untyped error, including a forged status/code shape
- THEN its unprogressed admission is compensated and the response is generic5xx without leaking raw error data
- WHEN rollback itself fails
- THEN generic5xx is returned without falsely reporting restored state or masking the storage failure as agent_unavailable

#### Scenario: Terminal sessions can prompt again
- WHEN the real store completes an accepted turn as done or failed, and the owner sends another valid prompt
- THEN the next prompt returns202 with new IDs, retaining previous history and the established title
