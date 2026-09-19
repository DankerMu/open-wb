## 1. Implement and prove
- [x] 1.1 Capture semantic RED and implement demo-subset mdRender with semantic snapshot, DOM injection tests and literal code/inert-link regressions.
- [x] 1.2 Implement simple CSV parser, CsvTable, CodeView and PreviewPane; prove row counts, JSON fallback, Markdown toggle/reset, metadata, image, unsupported/error and truncation states.
- [x] 1.3 Preserve source provenance; parent full web test/typecheck/build, scoped Biome, knip/jscpd/size and real Chromium component smoke with screenshot plus zero new console/page errors.
- [ ] 1.4 Independent expanded review and exact-head CI, merge then archive only preview-component requirement; parent Epic stays active.
## Risk packs
- Selected Public API / CLI / script entry: renderer/components public behavior through DOM tests (1.1–1.2).
- Not selected Config / project setup: no toolchain/config changes.
- Selected File IO / path safety / overwrite: untrusted file content rendering only, no filesystem; path text escaped (1.1–1.2).
- Selected Schema / columns / units / field names: derive preview success type, byte totals and CSV/code rows (1.2).
- Selected Auth / permissions / secrets: input cannot inject executable DOM or active destinations; no auth changes (1.1,1.3).
- Selected Concurrency / shared state / ordering: local Markdown mode reset by file identity; async loading belongs129 (1.2).
- Selected Resource limits / large input / discovery: component borrows URL and renders supplied already-bounded text; no global caches or extra URL allocation (1.2); server limits out of scope.
- Selected Legacy compatibility / examples: documented demo subset/corrected code-context behavior, existing frontend suite (1.1–1.3).
- Selected Error handling / rollback / partial outputs: JSON fallback, supplied error and unsupported states (1.2).
- Not selected Release / packaging / dependency compatibility: no dependencies or packaging changes; build covered1.3.
- Selected Documentation / migration notes: provenance comments, isolated visual proof scope, API-only parent requirement remains intact (1.3–1.4).
