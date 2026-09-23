## Why
#126 completes the filesystem-permission slice of Epic #111: private SQLite state must never start group-readable, while omp-owned shared trees need setgid group access.

## What Changes
- Prepare non-memory DB main and existing WAL/SHM modes before openDb; retain existing failure cleanup.
- Replace both spawn and managed-model directory creators with canonical ensureSharedDir.
- Prove real entry cold/restart modes, pre-open ordering, fail-closed errors and all new shared levels.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-uid-isolation`: add 自有状态不对组可读 only; preserve #120 requirements.

## Impact
server.ts startup, sessions/omp/process.ts, model-proxy/models-yml.ts and paired tests. No dependencies, CI or schema changes.
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree; actual triggers are startup ordering, private state and permissions; Linux /proc proof belongs to #131).
Blast radius: disclosure of DB/WAL contents; inaccessible shared sessions; startup resource leaks.
Selected risk packs: API/entry, Config, FileIO, Auth/secrets, Ordering, Legacy, Error/partial outputs, Docs.
Evidence floor: semantic RED/GREEN at actual compiled entry and spawn boundary; Main acceptance plus exact-head protected CI.
