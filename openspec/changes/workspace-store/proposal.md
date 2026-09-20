## Why
#125 provides owner-scoped workspace persistence and lazy account/workspace directories after schema/errors/audit/dirs prerequisites. SQLite rollback alone cannot undo directory creation; adopted data must survive every failure.

## What Changes
- Add createWorkspaceStore(db,{sandboxRoot,ensureSharedDir,emit}) with list(ownerId), create(principal,{name,dir?}), rootOf(principal,workspaceId).
- Validate names/dirs against schema+demo, insert within an owned transaction, create lazy roots, emit workspace.create on the same DB, commit before returning.
- Compensate only newly created empty directories on ordinary failures, preserve existing data, report cleanup failures; real DB/tempfilesystem test-first proof.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- workspaces: add store/lazy-root/compensation requirement only; existing schema/helper requirements stay unchanged, HTTP remains #127.

## Impact
store.ts + paired tests, no schema/auth/helper/HTTP changes or dependencies. Core resolver is reused for path checks; no duplicate sandbox policy. #127/#128 consume the store and synchronous rootOf.

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: tenant paths + SQLite and filesystem failure boundary)
Blast radius: cross-owner lookup, lost adopted data, unaudited or partially created workspace.
Selected risk packs: Public API; File IO; Schema; Auth; Ordering; Error handling; Legacy compatibility; Documentation.
Evidence floor: vertical semantic RED/GREEN with real migrated DB and temp roots, adversarial path/rollback/commit/compensation cases, fullserver/static/build, compiled real-store smoke, independent review and CI.
Interpretation: issue125 explicitly says audit failure leaves no row/directory; this is best-effort filesystem compensation, not crash-atomicity. Deployment SANDBOX_ROOT is pre-provisioned (parent D3), trusted and stable; no external path replacement during an operation. No crash journal/retry framework.
