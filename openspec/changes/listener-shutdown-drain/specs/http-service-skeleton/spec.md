## ADDED Requirements

### Requirement: Bounded lossless listener shutdown
From the start of shutdown, each response that completes SHALL trigger reclamation of idle keep-alive connections, so a request that finishes after `preClose` does not hold shutdown until the keep-alive timeout. The drain SHALL be bounded by a named listener budget (default 2000 ms) armed when the listener close begins after the `preClose` phase, so it never shortens the native runtime shutdown budget; neither the reclamation nor the budget SHALL depend on every `preClose` hook succeeding or finishing in time. Only when the budget expires with connections still open SHALL the app force-close remaining connections and invoke its optional force-close callback exactly once; the injectable app SHALL NOT write the record itself. The production entry SHALL supply that callback so its application-owned stderr receives exactly one LF-terminated exact JSON `{"event":"listener_force_close"}` with no extra keys, written through the managed writer; this SHALL NOT change the shutdown exit code. Once a startup failure has been decided, the production entry SHALL NOT emit this record, so a failed startup keeps only its generic failure record. The listener SHALL NOT force-close connections by default, and the runtime → listener → database shutdown order SHALL be preserved.

#### Scenario: Request completing after preClose
- **WHEN** an ordinary REST request is in flight when shutdown starts and completes only after the module preClose hooks have run
- **THEN** the client receives the complete 200 response and the listener closes within 2 s, without a forced close record

#### Scenario: A module preClose hook fails
- **WHEN** a module preClose hook fails during shutdown while an ordinary REST request completes after the preClose phase
- **THEN** the client still receives the complete response, the listener closes within 2 s and shutdown still reports the teardown failure

#### Scenario: Request outliving the budget
- **WHEN** an accepted request is still unfinished when the listener budget expires
- **THEN** remaining connections are force-closed, the production entry writes exactly one `{"event":"listener_force_close"}` stderr line and shutdown completes with its existing exit code
