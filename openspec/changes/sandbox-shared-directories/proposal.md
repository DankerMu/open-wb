## Why
Implement #113, shared-directory permissions from Epic #111 design D3 and ADR-0010. New directories must support the shared group without changing existing deployment permissions.
## What Changes
Add synchronous ensureSharedDir(absPath): void and real-filesystem tests. No consumers, chown, global umask changes, dependencies, or HTTP changes.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- sandbox-core: add the shared-directory permission requirement; preserve resolve unchanged.
## Impact
server/src/core/sandbox/dirs.ts and one paired test. Future consumers #123, #125, #126 own integration.
## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: filesystem permission boundary)
Blast radius: permissions of workspace and omp shared directories.
Selected risk packs: Public API; File IO/path safety; Auth/permissions; Error handling; Concurrency/shared state.
Evidence floor: real temp directories with exact mode 2770, existing mode preservation/idempotence, no chown or umask mutation, failure propagation; semantic RED/GREEN; full server suite and CI.
Human review: deferred to Epic final functional acceptance by user decision https://github.com/DankerMu/open-wb/issues/111#issuecomment-5741112841 ; independent agent reviews and CI retained.
