## Risk Packs
- Public API/Schema selected: named DTO/reducer/connector consumption, no server/API changes (1.1–1.3,2.1).
- Auth selected: epoch-bound client, current401 login, renewal/logout invalidation (1.3,2.1–2.2).
- Concurrency selected: create→URL→prompt handoff, before202 terminal, stale async, initial snapshot/open ordering and StrictMode (1.1–1.3,2.1–2.2).
- Resource limits selected: one current source, request abort and rejection ownership; existing1000cap remains connector-owned (1.3,2.1).
- Legacy compatibility selected: root consumers, files/settings/footer/canonicalization and unchanged session wire (1.2,2.1–2.3).
- Error handling selected:409/502/business error/current401/404/terminal transport; safe refresh guidance (1.1–1.3,2.1–2.2).
- Documentation selected: exact source/acceptance receipts, parent shell delta and archive (3.1).
- Config/File IO/Release not selected: no configs/paths/deps/CI or deployment behavior changes.
- Domain selected browser navigation/runtime+account lifecycle:query/Back/refresh/lifecycle and realpage evidence (2.1–2.2).
- Domain selected server/web envelope+cross-service/offline:relative same-origin client/nativeEventSource, realHTTP proof, no public dependency (2.2).
- Domain not selected tenant sandbox/process credential/SQLite migration:unchanged server/native test producer used only as oracle.

## 1. Implementation
- [ ] 1.1 TDD vertical tracer: real ApiClient+fake EventSource page test before production; empty/deep-link page and safe message/step rendering through existing stream owner.
- [ ] 1.2 Atomic root route/manifest/page cutover and affected routes/main/settings-footer fixtures; selection/new/composer/title/order, authoritative accepted-turn reconciliation with no speculative failed messages.
- [ ] 1.3 Complete page-owned account/query/request/source lifecycle and errors: before202 terminal, create navigation handoff, double-send guard, stale ignored-abort results,404empty/current401, successful/failedlogout and terminal refresh guidance.

## 2. Verification
- [ ] 2.1 Parent runs deterministic focused regressions, semantic failing-before/green-after evidence and wrong-candidate qualification for ordering/ownership, preserving raw output and exactsource/oracle identities.
- [ ] 2.2 Parent exercises actual compiled page in Chromium with real HTTP/SQLite and controlled native child:streaming/tool/error, URLrefresh, switch/unmount/logout; screenshots and zero new browser errors. This is not permanent#106 walkthrough or realomp18 proof.
- [ ] 2.3 Web coverage suite, scoped Biome/types/build/drift, strict child+parent specs; protected dependency/config/API/stream identities unchanged unless separately justified.
- [ ] 2.4 Expanded read-only source reviews with boundedfixgate and exact-head requiredCI pass.

## 3. Delivery
- [ ] 3.1 Sync parent completion, merge sourcePR/closeissue and prepare canonical archive with evidence. Independent archivePR/CI+merge is an external workflow gate before #94.
