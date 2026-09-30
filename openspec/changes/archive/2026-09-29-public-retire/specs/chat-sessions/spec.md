## MODIFIED Requirements

### Requirement: Session module registration and teardown
registerSessions SHALL construct the store/supervisor from caller-owned DB, shared tokens and runtime options, pass the store the `core/audit` emit bound to that same DB (the workspace-store precedent) for approval-settlement audit rows, wire store flush notifications into supervisor ownership, reconcile stale running sessions/messages/steps (settling their pending approvals as reconcileOnStartup defines) before exposing REST, and return its store/supervisor handles. It SHALL register a preClose hook that waits for all supervisor runtime/pump cleanup before closing the store, never closing the caller DB. Optional event observation SHALL publish actual numeric-ID events; this change SHALL NOT claim SSE/replay or global startup assembly. The supervisor SHALL expose a public `retire(sessionId)` used by session deletion: it SHALL run the existing bounded retire sequence of that session's live generation (stdin close and signal escalation, token revocation, process-cap release, generation sealing), await native exit, drop the session's slot and event ring, and end every SSE subscriber of that session without publishing a further event; for a session without a live generation it SHALL only drop ring/subscriber state and resolve. retire SHALL NOT write any SQLite row.

#### Scenario: Reconcile before route acceptance
- **WHEN** the module is registered on a real app with stale running rows
- **THEN** all three running row categories become failed before a request is admitted, terminal rows and caller data remain unchanged except the approval settlement defined by reconcileOnStartup (each pending approval of a failed message reads `deny` with `decided_at` and one `session.approval` audit row), and a new prompt can be accepted

#### Scenario: Shutdown ordering and isolation
- **WHEN** app.close runs with active sessions or a task/storage failure
- **THEN** new supervisor prompts are rejected, all children/tokens and pumps settle before store close, every approval still pending on a turn finalized by shutdown reads `deny` with one audit row, failures are propagated honestly and the caller DB remains usable

#### Scenario: Public retire for deletion
- **WHEN** retire(sessionId) is called for an idle session with a live real-fake child and two open SSE subscribers, and separately for a session with no live generation
- **THEN** the child exits, its token no longer authenticates at the model proxy, the process cap is released, both subscriber responses end without another event, no SQLite row changes, and a later prompt on that still-existing session acquires a new generation with `stream_epoch` plus one; the second call resolves without spawning, writing or bumping the epoch
