## Risk Packs
- Error handling — selected: failure feedback lifecycle (dismiss removes it, a later failure re-shows it, dismissal survives Drawer remount) → 1.1, 1.2, 2.1, 2.2, 2.3.
- Legacy compatibility — selected (existing UI test assertions only): alert role/class/textContent, retry after failure, pending status note without dismiss, collapse persistence, collapsed floating CSS contract → 2.4, 2.6.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Concurrency, Resource limits, Release, Documentation — not selected: presentation-state field in the auth context; no request, storage, route or auth-semantics change.

## 1. Implementation
- [x] 1.1 `provider.tsx`: add `dismissLogoutError` to `AuthContextValue`; implement with `useCallback(..., [])` (stable `setState`; biome rejects it as a dep) (authenticated and non-null → `logoutError: null`, else return `current`); include it in the context `useMemo` value and dependency array.
- [x] 1.2 `footer.tsx`: `Button`/`Icon` from `../../ui/index.js`; `关闭提示` icon button (`Button variant="ghost" size="icon"`, `Icon name="x"`) inside the alert note; onClick → `dismissLogoutError()` then `triggerRef.current?.focus()`.
- [x] 1.3 `sidebar.css`: row layout on `.sidebar-footer-note.ui-alert` only; `ui-muted` pending note and collapsed floating rule values unchanged.

## 2. Verification
- [x] 2.1 `sidebar.test.tsx`: collapsed → 403 logout → click `关闭提示` → `within(aside).queryByRole("alert")` null, `document.activeElement` is `用户菜单`, `data-collapsed === "true"`, `localStorage.workbuddy-sidebar === "collapsed"`, no extra fetch. RED on pre-change source (no `关闭提示` button), GREEN after.
- [x] 2.2 `sidebar.test.tsx`: after 2.1, logout again with a second 403 carrying the **same** message → alert reappears with `textContent === message` (catches message-keyed dismissal). A different-message variant is optional extra.
- [x] 2.3 `app-shell-responsive.test.tsx` (≤760 matchMedia mock): in the Drawer, logout fails → dismiss → close the Drawer (Escape) → reopen → no `role="alert"` in the overlay. RED on a footer-local-state variant is not required; GREEN required.
- [x] 2.4 Pending note has no dismiss control: extend the 「折叠态退出进行中」 case pattern (`sidebar.test.tsx` ~:281) — while the logout is pending, `queryByRole("button", { name: "关闭提示" })` is null.
- [x] 2.6 Existing suites pass without assertion changes: `sidebar.test.tsx` (「折叠态退出失败…」 textContent, 「折叠态 note 以 fixed 浮出 overflow 裁剪」), `settings-footer.test.tsx` (incl. `:535-541` static contract), `settings-page.test.tsx:207,223`, `app-shell-responsive.test.tsx` (incl. R9b' `:395`).
- [x] 2.5 `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
