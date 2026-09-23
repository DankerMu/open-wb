## 1. Fixture and semantic red evidence

- [x] 1.1 Read #129 and #118/#119 handoffs; approve expanded override in independent fixture review; strict validate before source edits.
- [x] 1.2 Add public AppRouter/Provider fetch-boundary tests first; capture semantic RED on current production (not missing imports/symbol failures), including full browsing/create flow, empty state, URL restore/fallback/replace, exact folder validation/conflict strings.
- [x] 1.3 Add session/concurrency/resource tests: current 401 including malformed/non-JSON; canceled/old same-account-session 401 ignored; concurrent requests; cross-workspace late responses; same-file mode refresh; image replacement/unmount/stale allocation and StrictMode cleanup.

## 2. Atomic implementation

- [x] 2.1 Introduce provider-owned session-bound client factory without changing me/login/logout/info single-slot semantics; remove incidental context shape test pin in favor of behavior.
- [x] 2.2 Implement /files page, list/URL reconciliation, switcher search/current marker, exact two-item plus menu, dialogs and empty states; blank dir omitted; async mutation ownership retained.
- [x] 2.3 Implement lazy tree/cache and loaded-directory dropdown, existing PreviewPane integration, unsupported zero-request gate, request cleanup and all Blob URL owner releases.
- [x] 2.4 Wire route/manifest and atomically migrate routes/main/auth-router/settings-footer fetch fixtures and existing ui-walk assertions without broad error suppression or weakened auth call counts.

## 3. Verification and promotion

- [x] 3.1 Main runs npm test --workspace web with unchanged full coverage scope; npm run build --workspace web; npm run typecheck --workspaces; scoped Biome plus deadcode/duplicate/naming/size checks. Preserve outputs and RED→GREEN evidence.
- [x] 3.2 Main builds server and launches real service with pre-provisioned 2770 SANDBOX_ROOT; run existing make ui-walk unchanged journey with new page assertions. Fresh account shows empty copy with no unexpected browser errors.
- [x] 3.3 Main performs throwaway Chromium real-HTTP journey: create/select workspace, expand, preview md/csv/png/zip, new directory and URL reload/fallback; save screenshots and browser/request evidence; unsupported and invalid workspace targets receive zero file/tree requests. Intentional initial auth/me 401 is narrowly correlated, never blanket console suppression.
- [x] 3.4 Freeze commit; expanded correctness, test-evidence+spec-compliance, invariant-state parallel static review; all reviewers end before any fix. Main executes bounded adjudication/fix gate and exact-head CI before automatic merge under Epic waiver. PR229 merged daf018f; final 4127d32, CI35846461252 eight jobs green; one fix pass, fresh round2 clean.
- [x] 3.5 Archive only this child after merge; preserve unrelated main requirements and active S0b/S1a. Update parent 4.3 completion and coordinate final parent reconciliation, not premature chat route promotion. This archive follow-up promotes only two files-web additions and two spa-shell modifications.

## Risk pack mapping

- Selected — Public API / CLI / script entry: shared Provider and route entry; 1.2/1.3/2.1/2.4/3.1 verify observable calls/status, not context shape.
- Not selected — Config / project setup: no config or setup change; production sandbox precondition only in external smoke.
- Not selected — File IO / path safety / overwrite: browser sends relative paths through existing API; server enforcement unchanged. 1.2/3.3 verify correct request targets, not re-prove server sandbox.
- Not selected — Schema / columns / units / field names: no persisted/API schema change; reuse existing types.
- Selected — Auth / permissions / secrets: 1.3/2.1 current and stale/aborted 401 including same-account renewal, existing auth consumers 2.4/3.1; no credentials added.
- Selected — Concurrency / shared state / ordering: 1.3/2.2/2.3 workspace/request/session generations, concurrent tree/preview, late mutation and mode identity.
- Selected — Resource limits / large input / discovery: 1.3/2.3 release all Blob owners; lazy-only discovery and no recursive dropdown fetching; existing preview limits/64-layer canonical renderer unchanged.
- Selected — Legacy compatibility / examples: 2.4/3.1/3.2 all five existing test consumer surfaces and canonical URL handling retained.
- Selected — Error handling / rollback / partial outputs: 1.2/1.3/2.2 exact form messages, inline non-401/fallback, terminal current 401 and stale-response discard.
- Not selected — Release / packaging / dependency compatibility: no dependency/package changes; build 3.1 confirms reachability.
- Selected — Documentation / migration notes: 3.5 selective archive, current-main route baseline and parent coordination; manifest updated atomically.
