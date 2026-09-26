## MODIFIED Requirements

### Requirement: Web assertions await the committed outcome they check
Web unit-test assertions on DOM that changes only after a route transition commits, or on a side effect performed in a React passive-effect cleanup, SHALL wait for that outcome itself with a bounded retrying wait (`waitFor`/`findBy*`), not assert it synchronously after awaiting an earlier proxy signal such as `window.location` or the appearance of the next tree. Such waits SHALL NOT be implemented by raising timeouts, adding test retries, or deleting assertions, and assertions that depend on the handoff (for example element identity) SHALL run after the wait. The same rule applies to the `make ui-walk` controlled turn: a server snapshot read over REST SHALL be taken only after an observable precondition proves the content it asserts has reached the store. The fake upstream gate reaching `held` is not such a precondition, because it flips before the first chunk has crossed the model proxy, omp and the supervisor. The browser rendering the first reply part is such a precondition, because the supervisor's commit path persists each event (`persistEvent` → `store.appendDelta`) before it publishes that event to the ring and SSE subscribers (`#publish`).

#### Scenario: Route commit lags the URL
- **WHEN** a test navigates, the URL already reflects the new location, and React commits the new location in a later transition
- **THEN** the assertion that the previous view's DOM is gone retries until the commit and passes, and the dependent identity assertion runs afterwards

#### Scenario: Passive cleanup lags the committed tree
- **WHEN** a successful login replaces the login form with protected content and the form's in-flight request is aborted in a passive-effect cleanup scheduled after the commit
- **THEN** the abort assertion retries until the cleanup runs and passes, without a timeout or retry change

#### Scenario: Pre-reload snapshot follows the rendered first part
- **WHEN** `walkHeldDialogue` has the prompt accepted (202) and the fake upstream gate reports `held`
- **THEN** the walk first waits for the running UI prefix (`expectRunningPrefix`: status `运行中`, the assistant body starting with the first reply part, and the `bash` step), and only then fetches the pre-reload REST snapshot and runs `expectRunningSnapshot` with unchanged strength (`running`, user/assistant ids, `content` starting with the first reply part)
