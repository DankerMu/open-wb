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
- [x] 1.3 Complete page-owned account/query/request/source lifecycle and errors: before202 terminal, create navigation handoff, double-send guard, stale ignored-abort results,404empty/current401, successful/failedlogout and terminal refresh guidance.

## 2. Verification
- [x] 2.1 Parent runs deterministic focused regressions, semantic failing-before/green-after evidence and wrong-candidate qualification for ordering/ownership, preserving raw output and exactsource/oracle identities.
- [x] 2.2 Parent exercises actual compiled page in Chromium with real HTTP/SQLite and controlled native child:streaming/tool/error, URLrefresh, switch/unmount/logout; screenshots and zero new browser errors. This is not permanent#106 walkthrough or realomp18 proof.
- [x] 2.3 Web coverage suite, scoped Biome/types/build/drift, strict child+parent specs; protected dependency/config/API/stream identities unchanged unless separately justified.
- [x] 2.4 Expanded read-only source reviews with boundedfixgate and exact-head requiredCI pass. PR247 head `2e0cd34095b5b91e81fe8f5c72559684aee2e722`: round3 clean after two fix passes; CI35905992078 all eight jobs successful.

## 3. Delivery
- [x] 3.1 Sync parent completion, merge sourcePR/closeissue and prepare canonical archive with evidence. PR247 merged; independent archivePR/CI+merge remains the external workflow gate before #94.

Initial pre-review receipts: `/tmp/open-wb-issue104-evidence/`. Fifteen new page tests and449 total were GREEN at that checkpoint; later review fixes and final counts follow below. Six initial ownership mutants were rejected; accepted202+snapshot503 had actual-browser RED/GREEN and historical-source permanent RED. Desktop geometry rejected the prior one-column page; restored actual page and dedicated stability passed, exact33-character NUL/BOM/Unicode/HTML-literal content retained, tool running/done/failed, running/completed refresh, two prompts, create/Back, navigation/logout cleanup and zero browser errors. First tracer RED was missing composer at the real placeholder boundary. Early fixture mistakes (consumed Responses, premature DOM assertions, stale authoritative data, mislabeled one-POST second-send case) were corrected with raw evidence retained. Static repair accidentally removed step detail; existing assertions caught it and it was restored. Current401 cleanup waits for owned close after login commit, matching passive cleanup semantics.

Review fix receipts: round1 corrected render-time client/session history ownership, session-bound alerts and exact pre-acceptance draft retention; historical source rejects all four associated assertions. Fast-terminal proof now uses a distinct accepted pair and observes terminal content before held202, then verifies ordered reconciled articles after a separate held snapshot; a reordered-pair mutant fails. Page-level renewal/late GET and concurrent-create tests were added. The initial global-window Profiler oracle misattributed pre-router-commit DOM; the final observer closes over committed useLocation and rejects the old source. Round2 added explicit post-response setImmediate settlement inside async act before late404/401 assertions; wrong page navigation and wrong provider auth mutation are rejected in disposable copies, restoration and a dedicated stability run pass. Removing one redundant inner busy guard survived and is not claimed rejected; duplicate POST injection is rejected. New-session action remains available after list503, with old-view RED/new-view GREEN. Final local suite: 458 tests/24 files,24 new page cases; static/types/build/drift pass and both actual-browser probes pass again. Final review round, source CI/merge and independent archive delivery remain pending.

Final source acceptance: PR247 merged after round3 clean and exact-head CI35905992078 success. All selected page scenarios are evidenced by the final source/test/boundary receipts above; source task gates are complete. Independent archive validation, CI and merge remain tracked outside this fixture.
