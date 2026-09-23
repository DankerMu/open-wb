## Why
#128 makes the already-implemented workspace and audit modules reachable through production createApp/server. The startup record must describe the real seven-module composition, not merely gain two strings.

## What Changes
- Compose one store, bound canonical audit and synchronous sandbox after sessions; register workspaces then accounts before catch-all/static routes.
- Reuse runtime.sandboxRoot and caller DB; preserve lazy roots and all startup/permission/sink contracts.
- Atomically migrate explicit module registrations and synthetic exact-path HTTP fixtures to the real composition.
- Rebase parent startup delta on promoted main spec: old parent text would regress idle upper bound, bearer precedence, sticky failure and model-publication signal handling.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `http-service-skeleton`: full 服务启动与装配 and Shared agent module assembly requirements, seven-module composition and production workspace/audit behavior. Existing #120/#126 policies referenced, not reimplemented.

## Impact
Production app.ts/server.ts; assembly/startup tests; accounts/workspaces HTTP test helpers and synthetic parser tests; configuration tests only if their existing contract changes (otherwise run unchanged). No new production configuration, dependency, route implementation or CI changes.
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: production assembly exposes sandbox/auth/audit boundary).
Blast radius: duplicate routes, wrong root/DB identity, missing or unaudited sandbox denial, regressions across all createApp callers.
Selected risk packs: API/entry, Config, FileIO, Auth/secrets, Ordering, Legacy, Error, Docs.
Evidence floor: semantic RED/GREEN real createApp and compiled entry; real DB/FS tenant+denial audit; full server suite; independent Main HTTP smoke and exact-head protected CI.
