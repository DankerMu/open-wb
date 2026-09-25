## Risk Packs
- Concurrency / shared state / ordering — selected: hook order relative to module preClose; re-drain vs in-flight requests → 1.1, 2.1, 2.4.
- Resource limits — selected: keep-alive sockets and the budget timer must not leak or keep the process alive → 2.1, 2.2.
- Error handling — selected: escalation path, throwing notifier, exit code unchanged → 1.2, 2.2, 2.3.
- Legacy compatibility — selected: shutdown order, SSE closing gate, inject-only apps, `forceCloseConnections` default → 2.4.
- Public API — selected: new optional `createApp` options `listenerCloseBudgetMs` (validated) and `onListenerForceClose` → 1.1, 2.2 (invalid value throws).
- Config — not selected: no env/config key (explicit non-goal).
- Schema, File IO, Auth/secrets, Release, Documentation — not selected: no data, path, credential, dependency or doc surface.

## 1. Implementation
- [x] 1.1 `app.ts`: first root preClose hook (closing flag) and `server.close` wrapper (budget timer), completed-response re-drain while closing, onClose timer cleanup; `LISTENER_CLOSE_BUDGET_MS = 2_000`; options `listenerCloseBudgetMs` (validated) and `onListenerForceClose` (guarded).
- [x] 1.2 `server.ts`: pass `onListenerForceClose` writing one `{"event":"listener_force_close"}` stderr line via `writeManagedLine`; exit code semantics unchanged.

## 2. Verification
- [x] 2.1 Real-listen re-drain test per design (barrier released from a post-createApp probe preClose hook or after `listening === false`; budget ≥10 s and notifier never called) — RED on pre-fix source (2 s deadline), GREEN after; record settle ms; 200 body complete before close.
- [x] 2.2 Budget escalation test (short budget, never-finishing request): forced close once, notifier once; normal close never notifies; invalid budget option throws.
- [x] 2.3 Entry-level stderr record + exit code 0 on forced close (state the chosen seam).
- [x] 2.4 `server-startup-order.test.ts` order contract, SSE tests and full `npm --workspace server run test` green; `make lint`, `make typecheck`, `make anti-drift` exit 0.
