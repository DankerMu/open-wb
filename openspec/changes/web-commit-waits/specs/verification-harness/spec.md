## ADDED Requirements

### Requirement: Web assertions await the committed outcome they check
Web unit-test assertions on DOM that changes only after a route transition commits, or on a side effect performed in a React passive-effect cleanup, SHALL wait for that outcome itself with a bounded retrying wait (`waitFor`/`findBy*`), not assert it synchronously after awaiting an earlier proxy signal such as `window.location` or the appearance of the next tree. Such waits SHALL NOT be implemented by raising timeouts, adding test retries, or deleting assertions, and assertions that depend on the handoff (for example element identity) SHALL run after the wait.

#### Scenario: Route commit lags the URL
- **WHEN** a test navigates, the URL already reflects the new location, and React commits the new location in a later transition
- **THEN** the assertion that the previous view's DOM is gone retries until the commit and passes, and the dependent identity assertion runs afterwards

#### Scenario: Passive cleanup lags the committed tree
- **WHEN** a successful login replaces the login form with protected content and the form's in-flight request is aborted in a passive-effect cleanup scheduled after the commit
- **THEN** the abort assertion retries until the cleanup runs and passes, without a timeout or retry change
