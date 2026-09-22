## ADDED Requirements
### Requirement: Supervisor dispatch and generation binding
SessionSupervisor SHALL implement the existing prompt(sessionId,text):Promise<void> port using the already-admitted store.runtimeState active pair, owner and resume metadata. It SHALL neither admit nor compensate a pair itself. It SHALL reject duplicate supervisor admission and close new admission during shutdown. Runtime SessionBusyError SHALL become canonical session_busy; AgentUnavailableError and OmpProtocolError SHALL become agent_unavailable. Storage, registry and unknown adapter faults SHALL remain generic failures: acquisition-specific adapter provenance SHALL take precedence over the runtime's sanitized error.
The supervisor SHALL await the exact runtime dispatch receipt and persist the validated sessionFile before resolving the REST port, without consuming business frames first. Pre-progress failure SHALL retire/discard that runtime before rejecting so REST can compensate. No post-progress error SHALL reject the already-accepted REST operation.
Every runtime generation acquisition, including idle re-spawn and crash recovery, SHALL increment stream_epoch exactly once via the existing store method before shared-token issuance; reuse of a live generation SHALL not increment it. Failed acquisition may advance epoch independently of REST compensation. Runtime SHALL retain token-revocation ownership; native exit SHALL make that generation token invalid, without stale callbacks revoking a newer token. No requestId SHALL be guessed from an ACK.
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
### Requirement: Supervisor ordered persistence and publication
The supervisor SHALL initialize the canonical pure mapper with the exact admitted assistant id and dispatch requestId. It SHALL consume the full runtime iterator, preserving arrival order including frames before ACK. toolCallId SHALL map to numeric startStep results using zero-based per-turn ordinals; public events SHALL carry numeric stepId only. Steps SHALL be persisted before publication; text SHALL enter the existing store buffer unchanged. A terminal transaction SHALL complete before turn.end publication.
Post-dispatch transport/native failure SHALL flush residual content and settle running steps/message/session failed, emit error before one failed turn.end, then discard/retire the runtime. Queued deltas SHALL be drained before failure settlement. Mapper terminal fencing SHALL prevent duplicate/late settlement; upstream stopReason:error SHALL become failed without requiring child death. Runtime-validated clean local-only completion without mapper terminal SHALL finish done and publish one done turn.end without waiting for agent_end.
All background tasks SHALL contain infrastructure/store/observer/cleanup failures and report them through the owned error sink, including synchronous persistence failures and store background flush notifications. Successfully settled modeled crash/upstream/protocol failures SHALL use only public error+turn.end and SHALL NOT also poison infrastructure error retention or shutdown. Persistence failure SHALL NOT publish a terminal commit that did not occur, silently lose pending content or cause automatic retry loops. Runtime retirement and error-sink exceptions SHALL not produce unhandled detached rejections. Shutdown SHALL await all tasks/native children even if one fails, and surface collected infrastructure errors without claiming successful cleanup.
#### Scenario: Normal actual-child turn
- WHEN real fake-omp produces at least three text deltas, one bash tool start/end and terminal success
- THEN messages returns the exact concatenated assistant body, exactly one numeric-ID done bash step and done session, while observer events preserve order and terminal observers can read the committed terminal state
#### Scenario: Crash with unflushed residual
- WHEN real fake-omp emits two sub-threshold deltas and exits before the timer flush
- THEN both deltas survive in failed assistant content, running steps are settled, error precedes one failed turn.end, runtime is discarded, and a subsequent prompt resumes at epoch+1; successful modeled-failure settlement alone does not notify onError or fail shutdown
#### Scenario: Local-only and exact-id error
- WHEN runtime confirms a local-only prompt with no agent_end, or reports a matching prompt failure after accepted dispatch
- THEN local-only completes once as done, matching failure completes once as failed with error first, and unrelated response ids cannot fail the turn
#### Scenario: Flush or terminal database failure
- WHEN a real SQLite fault prevents a background/threshold/step/terminal write after dispatch
- THEN the task is contained, the runtime is retired, owner receives the error, no uncommitted turn.end is published, pending data remains recoverable through the existing explicit store repair/finish/close path, and no automatic retry loop or unhandled rejection occurs
### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens and runtime options, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly.
#### Scenario: Reconcile before route acceptance
- WHEN the module is registered on a real app with stale running rows
- THEN all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged and a new prompt can be accepted
#### Scenario: Shutdown ordering and isolation
- WHEN app.close runs with active sessions or a task/storage failure
- THEN new supervisor prompts are rejected, all children/tokens and pumps settle before store close, failures are propagated honestly and the caller DB remains usable
