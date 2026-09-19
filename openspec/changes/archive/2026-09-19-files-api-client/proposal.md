## Why
Issue #118 supplies the six network-client operations consumed by later files UI slices without requiring unfinished server routes to run.
## What Changes
Extend existing web/src/lib/api.ts and its tests; preserve auth/info behavior and expose workspace, tree, preview and audit responses.
## Capabilities
### New Capabilities
- `files-web`: API 客户端扩展 only, from the unfinished parent Epic delta.
### Modified Capabilities
None.
## Impact
Issue type: feature
Fixture level: expanded
Upstream suggested level: compact (override: exported shared network API, response reader, authentication callback and image URL resources trigger expanded).
Blast radius: auth provider and future #119/#129 files consumers; no server source changes.
Selected risk packs: public API, path serialization, wire schema, auth, concurrency/cancellation, resource lifetime, compatibility, error handling, docs.
Evidence floor: semantic RED/GREEN through createApiClient, web full suite/typecheck/build, drift/static checks, parent runtime client smoke, independent review and CI.
