## MODIFIED Requirements

### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner, resume metadata and workspace binding. runtimeState SHALL report the session's `workspaceId` (the `workspace_id` column) and the supervisor SHALL resolve the cwd from it: when `workspace_id` is non-NULL, the root returned by the workspace store's owner-scoped `rootOf` called with the session's `owner_id` as principal id; otherwise the owner root `<SANDBOX_ROOT>/<ownerId>` used before this change. Every spawn of a session generation and every fork temporary runtime SHALL pass that cwd as omp `--cwd`; a non-NULL `workspace_id` for which `rootOf` returns null SHALL fail the acquisition as a generic failure (compensated like other acquisition failures) and SHALL NOT fall back to the owner root; when `rootOf` returns a root that does not exist as a directory at acquisition time, the supervisor SHALL NOT create it (no mkdir of a workspace root) and SHALL NOT spawn or fall back, and the acquisition SHALL fail as agent_unavailable (REST 502 with the ordinary prompt compensation); a failure thrown while resolving the bound root (including `rootOf` rejecting a root that exists but is not a plain directory, or any fault inside that resolution) SHALL likewise fail as agent_unavailable, a narrow exception to generic storage-fault provenance. The binding is immutable, so a resumed generation's cwd equals the one recorded when the session file was created. On the prompt path it SHALL neither admit nor compensate a pair itself. Regenerate and fork (Requirement「会话 REST」) are supervisor-owned admission and compensation paths: the supervisor SHALL perform their single final SQLite transaction (including the control-claim recheck) and their failure compensation (retiring the process, shutting down a fork's temporary process, or settling a dispatched regenerate assistant row `failed`). The supervisor SHALL hold a per-session control claim for regenerate, fork and stop from a passed precheck until dispatch completes or the response is returned; while it is held, prompt, regenerate and fork on that session SHALL be rejected with session_busy (a stop after regenerate has dispatched proceeds normally because the session is then `running`), and the claimed session's process counts as in-turn for the process cap. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error. On the regenerate and fork paths the failure mapping of turn-control「重新生成 REST」and「从此处分叉 REST」takes precedence over this rule: a storage fault of their final transaction, and any regenerate dispatch failure after that transaction commits, SHALL reject with agent_unavailable; a failed control-claim recheck SHALL reject with session_busy.
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
- **WHEN** the owner forks a session with a live idle process and the fork succeeds
- **THEN** the source's live idle process was retired before the temporary process started, neither the source nor the new session's `stream_epoch` changed, no event was published to any ring and the temporary process has exited before the response

#### Scenario: Control claim excludes concurrent turn operations
- **WHEN** a regenerate or fork holds the control claim (the fake held between `get_branch_messages` and `branch`, and between `branch` and `get_state`) and a prompt, regenerate or fork arrives for the same session
- **THEN** each concurrent request returns409 session_busy with no row, file or process change; after the claimed operation finishes the claim is released and a later prompt is admitted

#### Scenario: Spawn cwd follows the workspace binding
- **WHEN** the owner prompts a session bound to workspace W and, separately, an unbound session, each backed by the real fake whose probe reports `cwd=`
- **THEN** the bound session's child reports W's root (below `<SANDBOX_ROOT>/<ownerId>/`) and the unbound one reports `<SANDBOX_ROOT>/<ownerId>`; after an idle retire the next prompt's resumed child reports the same cwd as before
- **WHEN** a test makes `rootOf` return null for a bound session before its first prompt
- **THEN** the prompt fails with a generic5xx, its admission is compensated and no child was spawned with the owner root
- **WHEN** a bound session's workspace root directory has been removed outside the application before its next prompt
- **THEN** the prompt returns502 agent_unavailable, its admission is compensated, no child is spawned and the workspace root still does not exist

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens, runtime options and the workspace store's owner-scoped `rootOf` (the same workspace store createApp builds; sessions SHALL NOT construct a second workspace store or compute workspace roots itself), pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps (settling their pending approvals as reconcileOnStartup defines) before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly. The supervisor SHALL expose a public `retire(sessionId)` used by session deletion: it SHALL run the existing bounded retire sequence of that session's live generation (stdin close and signal escalation, token revocation, process-cap release, generation sealing), await native exit, drop the session's slot and event ring, and end every SSE subscriber of that session without publishing a further event; for a session without a live generation it SHALL only drop ring/subscriber state and resolve. retire SHALL NOT write any SQLite row.

#### Scenario: Reconcile before route acceptance
- **WHEN** the module is registered on a real app with stale running rows
- **THEN** all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged except the approval settlement defined by reconcileOnStartup (each pending approval of a failed message reads `deny` with `decided_at` and one `session.approval` audit row), and a new prompt can be accepted

#### Scenario: Shutdown ordering and isolation
- **WHEN** app.close runs with active sessions or a task/storage failure
- **THEN** new supervisor prompts are rejected, all children/tokens and pumps settle before store close, every approval still pending on a turn finalized by shutdown reads `deny` with one audit row, failures are propagated honestly and the caller DB remains usable

#### Scenario: Public retire for deletion
- **WHEN** retire(sessionId) is called for an idle session with a live real-fake child and two open SSE subscribers, and separately for a session with no live generation
- **THEN** the child exits, its token no longer authenticates at the model proxy, the process cap is released, both subscriber responses end without another event, no SQLite row changes, and a later prompt on that still-existing session acquires a new generation with `stream_epoch` plus one; the second call resolves without spawning, writing or bumping the epoch
