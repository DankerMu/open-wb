## Why
#318 — with the sidebar collapsed on desktop, a failed logout renders `logoutError` as `<p className="ui-alert sidebar-footer-note" role="alert">` (`web/src/features/auth/footer.tsx:64-68`), which `web/src/routes/shell/sidebar.css:132-147` floats as a `position: fixed` 240px note at `z-index: 1100` over the bottom-left of `main`. It has no dismiss control, and in the authenticated state `logoutError` is cleared only by a new session or the next logout attempt (`web/src/features/auth/provider.tsx:377`, `:401` writes it). Route changes, menu use or time never clear it, so it keeps covering main content. Introduced by `db4d13f` (PR #317 round-1 fix). After PR #322 the ≤760 path is a Drawer overlay that is always expanded, so only the desktop collapsed path floats; the Drawer remounts `AuthFooter` on every open.

Decision among the issue's options: **(b) an explicit dismiss button**, with dismissal held in `AuthProvider`. (a) "reopening the user menu dismisses it" is not discoverable and cannot be wired without changing the `Menu` primitive: Radix opens the trigger on Enter/Space keydown and prevents the synthetic click, so a trigger `onClick` misses keyboard opens and a new `Menu` `onOpenChange` prop would be required. (c) auto-expanding overrides the user's persisted collapse preference. Holding the state in the provider (not footer-local) keeps a dismissal across the Drawer's footer remounts, as #318's comment requires.

## Triage
Issue type: bugfix
Fixture level: compact
Upstream suggested level: absent (compact: `AuthContext` is not exported, nothing `vi.mock`s the provider and no code outside it constructs `AuthContextValue`; all consumers destructure fields, so adding a method cannot break a caller — not a shared entrypoint/public API here. No request/storage/route change)
Blast radius: sidebar footer logout feedback; a wrong fix could swallow a later failure, lose focus to `body`, or change the alert text other tests read.
Selected risk packs: Error handling (failure feedback lifecycle: dismiss, re-show on next failure); Legacy compatibility — existing UI test assertions only, no legacy callers/formats (alert text/role/class, retry semantics, pending note, expanded/Drawer presentation).
Evidence floor: new jsdom cases RED on pre-change source, GREEN after; existing sidebar, settings-footer and app-shell-responsive suites unchanged and green; `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
design.md omitted (compact).

## What Changes
- `provider.tsx`: `AuthContextValue` gains `dismissLogoutError(): void`, implemented with `useCallback(..., [])` (`setState` is stable; biome useExhaustiveDependencies rejects it as a dependency): when authenticated and `logoutError` is non-null it sets it to `null`, otherwise returns `current` unchanged (no request, no other state change); added to the context `useMemo` value and its dependency array. (There is no default context value — `createContext<AuthContextValue | null>(null)` and `useAuth` throws outside the provider.) Dismissal needs no reset: the next logout clears `logoutError` at start and writes it on failure, and `footer.tsx`'s `logoutError` effect fires on null→message regardless of text.
- `footer.tsx` (`Button`, `Icon` imported from `../../ui/index.js`): inside the existing `role="alert"` note, after the message text, a `Button variant="ghost" size="icon" aria-label="关闭提示"` with `Icon name="x"` (the `Dialog` close-button pattern). Clicking it calls `dismissLogoutError()` and moves focus to the `用户菜单` trigger (`triggerRef`) so focus never drops to `body`. Rendered in every presentation (expanded, collapsed, Drawer) — one code path, no collapsed-only branch. This intentionally goes beyond the issue's out-of-scope note on the expanded presentation: a collapsed-only button would need a presentation branch the issue itself wanted to avoid. The icon has no text, so the alert's `textContent` stays exactly the message.
- `sidebar.css`: only `.sidebar-footer-note.ui-alert` gets the row layout (flex, message grows, button aligned end); the shared-class `ui-muted` pending note is untouched, and the collapsed floating rule values (`position: fixed; width: 240px;`, opaque alert background) stay.

Must preserve: alert `role="alert"`, class `sidebar-footer-note` and `textContent === message` (read by `sidebar.test.tsx` 折叠态退出失败, `settings-page.test.tsx:207,223`, `app-shell-responsive.test.tsx:395` R9b'); `settings-footer.test.tsx:535-541` static contract that `footer.tsx` still contains `ConfirmDialog` and `returnFocus`; `useAuth` consumers (verified: probes read fields or `toMatchObject`, no context snapshot — `auth-router.test.tsx:111-118`, `auth-session-client.test.tsx`, `settings-footer.test.tsx:40-48`); retry after failure (`settings-footer.test.tsx` "keeps the shell and enables retry after %s"); the pending `role="status"` note (no dismiss control, it self-clears); collapsed state and `localStorage.workbuddy-sidebar` untouched by dismiss; the collapsed floating CSS contract. Out of scope: ConfirmDialog behavior (#315), Drawer redesign, pending-note presentation.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `spa-shell`: ADDED requirement for a dismissible logout failure note (ADDED rather than MODIFIED because the active `s1e-frontend-parity` change restates the sidebar/logout requirements wholesale).

## Impact
`web/src/features/auth/provider.tsx`, `web/src/features/auth/footer.tsx`, `web/src/routes/shell/sidebar.css`, tests in `web/test/sidebar.test.tsx` (and `web/test/app-shell-responsive.test.tsx` for the Drawer remount case). No server, API or CI change.
