## ADDED Requirements

### Requirement: Bounded lossless listener shutdown
After the last module `preClose` hook completes, the app SHALL close its listener as soon as every accepted request has completed: each response that completes while the app is closing SHALL trigger reclamation of idle keep-alive connections, so a request that finishes after `preClose` does not hold shutdown until the keep-alive timeout. The drain SHALL be bounded by a named listener budget (default 2000 ms) armed only after the module `preClose` hooks, so it never shortens the native runtime shutdown budget. Only when the budget expires with connections still open SHALL the app force-close remaining connections and invoke its optional force-close callback exactly once; the injectable app SHALL NOT write the record itself. The production entry SHALL supply that callback so its application-owned stderr receives exactly one LF-terminated exact JSON `{"event":"listener_force_close"}` with no extra keys, written through the managed writer; this SHALL NOT change the shutdown exit code. The listener SHALL NOT force-close connections by default, and the runtime → listener → database shutdown order SHALL be preserved.

#### Scenario: Request completing after preClose
- **WHEN** an ordinary REST request is in flight when shutdown starts and completes only after the module preClose hooks have run
- **THEN** the client receives the complete 200 response and the listener closes within 2 s, without a forced close record

#### Scenario: Request outliving the budget
- **WHEN** an accepted request is still unfinished when the listener budget expires
- **THEN** remaining connections are force-closed, the production entry writes exactly one `{"event":"listener_force_close"}` stderr line and shutdown completes with its existing exit code
