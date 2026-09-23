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
- [x] 1.1 TDD vertical tracer: real ApiClient+fake EventSource page test before production; empty/deep-link page and safe message/step rendering through existing stream owner.
- [x] 1.2 Atomic root route/manifest/page cutover and affected routes/main/settings-footer fixtures; selection/new/composer/title/order, authoritative accepted-turn reconciliation with no speculative failed messages.
- [ ] 1.3 Complete page-owned account/query/request/source lifecycle and errors: before202 terminal, create navigation handoff, double-send guard, stale ignored-abort results,404empty/current401, successful/failedlogout and terminal refresh guidance.

## 2. Verification
- [x] 2.1 Parent runs deterministic focused regressions, semantic failing-before/green-after evidence and wrong-candidate qualification for ordering/ownership, preserving raw output and exactsource/oracle identities.
- [x] 2.2 Parent exercises actual compiled page in Chromium with real HTTP/SQLite and controlled native child:streaming/tool/error, URLrefresh, switch/unmount/logout; screenshots and zero new browser errors. This is not permanent#106 walkthrough or realomp18 proof.
- [x] 2.3 Web coverage suite, scoped Biome/types/build/drift, strict child+parent specs; protected dependency/config/API/stream identities unchanged unless separately justified.
- [ ] 2.4 Expanded read-only source reviews with boundedfixgate and exact-head requiredCI pass.

## 3. Delivery
- [ ] 3.1 Sync parent completion, merge sourcePR/closeissue and prepare canonical archive with evidence. Independent archivePR/CI+merge is an external workflow gate before #94.

Local receipts: `/tmp/open-wb-issue104-evidence/`. Fifteen new page tests; complete web suite 449 tests passes. Six disposable ownership mutants are rejected and restored15/15; accepted202+snapshot503 has actual-browser RED then GREEN and historical-source permanent RED. Desktop geometry rejects the prior one-column page; restored actual page and one dedicated stability trial pass, exact33-character NUL/BOM/Unicode/HTML-literal content retained, tool running/done/failed, running/completed refresh, two prompts, create/Back, navigation/logout cleanup and zero browser errors. First tracer RED was missing composer at the real placeholder boundary. Early fixture mistakes (consumed Responses, premature DOM assertions, stale authoritative data, mislabeled one-POST second-send case) were corrected with raw evidence retained; the genuine two-POST case rejects missing mutation release. Static repair accidentally removed step detail; existing assertions caught it and it was restored. Current401 cleanup now waits for owned close after login commit, matching passive cleanup semantics. Task1.3 and final selected-pack completeness await independent review; source and independent archive CI gates remain pending.
