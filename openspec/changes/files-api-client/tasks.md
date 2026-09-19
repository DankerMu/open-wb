## 1. Implementation and verification
- [x] 1.1 Add six-method public client tests, preserve semantic RED before implementation, cover URL/body contracts and canonical error/401 behavior.
- [x] 1.2 Extend existing API client with typed workspace/tree/audit responses and text/image previews, using canonical helpers; preserve all existing consumers.
- [x] 1.3 Prove header/body size distinction, exact image bytes and URL ownership, empty preview, malformed response/error precedence; run web suite/typecheck/build, scoped Biome, knip/jscpd/size guard and parent runtime smoke.
- [ ] 1.4 Independent expanded review, exact-head CI and merge; archive this API-only delta and keep Epic active.
## Risk packs
- Selected Public API / CLI / script entry: six exported client methods and auth-provider sibling compatibility (1.1–1.3).
- Not selected Config / project setup: no config changes.
- Selected File IO / path safety / overwrite: URL argument serialization only; no local filesystem access (1.1).
- Selected Schema / columns / units / field names: exact network shapes, numeric bytes/time, header metadata (1.1–1.3).
- Selected Auth / permissions / secrets: same-origin credentials and unchanged 401 callback; no server authorization claims (1.1,1.3).
- Selected Concurrency / shared state / ordering: per-call signal and error-before-body/URL ordering, no client cache (1.1,1.3).
- Selected Resource limits / large input / discovery: original versus truncated size and Blob URL transfer/disposal; server enforces limits, no invented client streaming limits (1.3).
- Selected Legacy compatibility / examples: auth/info/logout tests and provider suite (1.3).
- Selected Error handling / rollback / partial outputs: canonical ApiError, malformed metadata/body rejection and no error-path URL allocation (1.1,1.3).
- Not selected Release / packaging / dependency compatibility: unchanged toolchain/dependencies; normal web build (1.3).
- Selected Documentation / migration notes: API source ownership comment and schema-only archive coordination (1.2,1.4).
