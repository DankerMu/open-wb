# Design: session-list-sidebar (#424)

## Decisions

### D1. The page reports a rendered node; the Sidebar renders it inside its own React tree

This answers the issue's first open point. Fixture review iteration 1 rejected a portal. Radix `DismissableLayer` decides "inside" through React-tree `onPointerDownCapture` (`node_modules/@radix-ui/react-dismissable-layer/dist/index.mjs:66-75,313-314`). A list portalled from `ChatPage` into the Drawer would be React-outside, so clicking any non-button spot in it would dismiss the overlay.

`web/src/lib/sidebar-slot.tsx` provides:
- `SidebarSlotProvider`, in `AppShell` next to `TopbarProvider`. It uses two contexts:
  - a stable setter context;
  - a value context holding `ReactNode | null`.
- `useSidebarSlot(node)`, used by `ChatPage`. It reports through the setter in a layout effect and clears on unmount, following the `useTopbar` pattern (`web/src/lib/topbar.tsx:28-35`). `ChatPage` subscribes only to the setter, so it cannot loop: the node changes every render, but setting it re-renders only the value consumers.
- `useSidebarSlotContent()`, used by `Sidebar` to read the node.
- `SidebarNavigateContext`: `Sidebar` wraps the rendered node in this context with its `onNavigate`. `SessionNav` reads it with `useSidebarNavigate()` and calls it after select or `新建会话` (D5). Hooks resolve at the render location, which is inside `Sidebar`.

Lifecycle:
- The node is reported during the same commit (layout effect), before paint, so the list does not flash.
- On unmount or when leaving `/`, the node is cleared.
- Collapsed sidebar and closed Drawer do not render it.
- A narrow/wide swap simply renders it in the new `Sidebar` instance.

The list's data, fences and callbacks stay in `ChatPage` closures; the shell only places the element. Outside a provider (bare `ChatPage` tests), `useSidebarSlot` is a no-op, like `useTopbar`, and tests that assert the list use a slot host helper.

### D2. Collapsed sidebar (48px) renders no list area and no icon new-session

This answers the second open point. It matches demo:241 (`.sidebar-main` is `display:none` when collapsed). A user can still start a conversation by sending from the welcome composer, which uses the existing create-on-send path. This keeps the change YAGNI: no new icon control and no tooltip.

### D3. Card row: nowrap at ≥761, wrap kept at ≤760

This answers the third open point.
- **≥761.** `.chat-playbooks-row { flex-wrap: nowrap }` without `overflow: hidden`, and `li { flex: 1 1 0; min-width: 0; max-width: 220px }` (demo:408-409). `flex: 1 1 0; min-width: 0` already prevents horizontal overflow. `overflow: hidden` would clip the global focus ring (`web/src/styles.css:84-88`, 2px outline + 2px offset), so it is not used; fixture review flagged this. The card title and description must stay inside the card: `.chat-playbook-title` is a flex container, so its text needs its own ellipsis span or clamping (≥761 narrowest card ≈75px).
- **≤760.** Keep the current wrap (`flex: 1 1 140px`). The demo has no narrow rule and squeezes each card to about 60px (unreadable, seen in the demo 390 shot).

With the list block gone, the 390×844 welcome state fits the disclaimer in the first screen. This must be proven by E3, not assumed.

### D4. Sidebar layout

The list area is `<div className="sidebar-main">` between `<nav aria-label="主导航">` and the footer, rendered when not collapsed:
- `flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px` (demo:274);
- the footer keeps `margin-top: auto`.

`SessionNav` keeps `<nav aria-label="会话列表" className="chat-session-nav">`, the `新建会话` button and the list classes.
- **Removed:** the `.chat-sidebar` card wrapper (background, border, radius). The list sits directly on `--wb-sidebar-bg`.
- **Kept:** row styles (dot, title, current item).
- **Sticky button:** `新建会话` stays full width at the top of the area, and the list below it scrolls.

On `/files`, `/settings` and `/center` nothing is reported, so the area is empty.

The existing `.sidebar nav`, `.sidebar nav ul` and overlay `nav` rules (`sidebar.css:45-60,263-265`) would also match `nav.chat-session-nav` with higher specificity. They are narrowed to the main nav (for example `.sidebar-nav` or `nav[aria-label="主导航"]`).

### D5. Overlay

In the overlay variant, `Sidebar` provides `onNavigate` (the existing `closeNav`) through `SidebarNavigateContext` around the list node (D1).
- **Close timing.** `SessionNav` calls it after `selectSession` and immediately on `新建会话` click, the same moment a nav link closes it. Because the list is React-inside the Drawer, Radix never auto-dismisses on list clicks, so a closing overlay proves `onNavigate` is wired.
- **Focus.** Drawer close returns focus to `打开导航` (existing Radix behavior).
- **Collapse preference.** The overlay never reads or writes `workbuddy-sidebar` (unchanged).

### D6. Chat main

- `.chat-layout` keeps `display:grid` with `grid-template-columns: minmax(0, 1fr)` and the existing padding, so `.chat-main` still fills and scrolls without moving the `≤760` flex rules into the base.
- `.chat-main` spans the full width; the welcome and transcript max-widths are unchanged.
- The `≤760` list-stack rules (`chat.css:474-484`) are deleted.
- The `.chat-sidebar` rules are deleted.
- CSS text tests that read these rule bodies (`web/test/chat-composer.test.tsx:161-215`) are updated to the new rules.

## Must preserve
List semantics as proposal lists; ownership/generation/abort fences (`page.tsx:115-150,662-683`); topbar breadcrumb flow (`useTopbar`); spa-shell overlay rules and storage rules; locator names; no horizontal overflow (ui-walk/ui-shots oracles).

## Governing invariant
The list is owned and rendered by the chat feature; the shell only hosts a place for it. There is exactly one list on screen and never inside `main`, and none on non-chat routes or in the collapsed sidebar.

## Sibling surfaces
- Shell: `app-shell.tsx:18-45` (providers, Drawer), `sidebar.tsx:44-111`, `sidebar.css` (overlay variant :288-300).
- Chat: `conversation-view.tsx:178-248`, `page.tsx:686-726`, `chat.css:20-147,243-302,474-484`.
- Harness:
  - ui-walk: `web/e2e/ui-walk.spec.ts:266` (`walkHeldDialogue`), `:615` (`selectedSessionStatus`), any other `会话列表`/`新建会话` usage; `ui-walk-layout.ts` `withViewport`.
  - ui-shots: `web/e2e/ui-shots.mjs:263-279`. Only the first cell (1440-light, desktop) reads the list in `createDoneSession`. The other cells, including 390, only `goto` plus `waitDoneConversation` (`:254-261`, article/form status), so no overlay handling is needed there.
- jsdom:
  - Most chat tests use the full AppShell (`web/test/render-app-router.tsx:10-21`; jsdom has no matchMedia, so the sidebar is wide/inline) and need little change.
  - Bare-`ChatPage` helpers in `web/test/chat-page-lifecycle-support.tsx:95-135` are used by `chat-page-lifecycle.test.tsx:114,275` and `topbar.test.tsx:245-257` (T7 asserts list `aria-current`). They need the slot host.
  - Also: `chat-composer.test.tsx:161-215` (CSS text), `routes.test.tsx:187`, `sidebar.test.tsx`, `app-shell-responsive.test.tsx`.
- Specs/docs:
  - spa-shell + chat-web main and parent deltas;
  - parent proposal #7;
  - checklist CH-15 (`:180`) and CH-07 (`:172`, evidence column).

## Seams under test
- jsdom full app (`AppShell` + routes) for placement, collapsed and overlay behavior.
- jsdom `ChatPage` with the slot host helper for list semantics.
- CSS text tests for the row/layout rules.
- ui-walk real browser (desktop-light, mobile-dark, plus 1024×768 via `withViewport`).
- ui-shots real browser (60 shots) plus orchestrator visual review of chat-welcome/chat-done at 1440/1024/390.

## Required evidence
- **E1 RED (before implementation).** Add the new ui-walk layout step and run it on master with both projects in their normal order: desktop-light first, which creates a session, then mobile-dark. The 390 overflow margin with an empty list is only about 23px. It must fail with cards on two or more rows at 1024 and the disclaimer below the fold at 390. Record the failing lines. The step also checks the disclaimer at 1440×900 (expected to pass before and after).
  - The step checks, at 1024×768 and in the welcome state, that the five cards share one `offsetTop` and that the disclaimer's `getBoundingClientRect().bottom <= innerHeight`.
  - On the mobile-dark project it checks the same disclaimer condition at 390×844.
- **E2 jsdom shell.** On `/` (expanded):
  - `新建会话` and `会话列表` are inside `aside[aria-label="侧栏"]`, after `主导航` and before the footer;
  - `main` contains neither.

  Also:
  - collapsed: the list is absent;
  - `/files` and `/settings`: no list;
  - overlay: the list comes after the nav; selecting a session closes the dialog, sets the URL `?session=` and returns focus to `打开导航`; `新建会话` closes it too;
  - overlay: pointerdown + click on a non-interactive spot of the list area (nav padding, loading text) does NOT close the dialog (guards D1);
  - overlay closed: the list is not in the DOM;
  - storage is untouched.
- **E3 ui-walk green (both projects).** Covers the E1 step, updated journeys (390 opens the overlay before `新建会话` and before reading list status) and the list-in-sidebar placement check on desktop.
- **E4 jsdom chat semantics.** Existing chat-page, ownership and lifecycle suites pass through the slot host with the same assertions: aria-current, status names/pulse, title sync, account-switch isolation, list error/loading.
- **E5 ui-shots.** Local `make ui-shots` run: 60/60, exit 0. The orchestrator reviews chat-welcome/chat-done at 1440/1024/390 app vs demo for structure (sidebar = nav + list + user; main single column).
- **E5b CSS.** Text assertions: `.chat-playbooks-row` at ≥761 has `flex-wrap: nowrap` and no `overflow: hidden`; the `≤760` block keeps wrap; `.chat-layout` has a single column; the main-nav selectors no longer match `.chat-session-nav`.
- **E6 gates.** `make check`, both `openspec validate --strict` (this change and `s1e-frontend-parity`).

## Non-goals
Grouping, pinning, item menus, filter and search (S1c); collapsed icon new-session; SH-01 (#420).

## Review focus
1. Fences and ownership unchanged: no list state moved into shell, and `shell` does not import chat.
2. Slot lifecycle: node report/clear on unmount and route change, narrow/wide swap, StrictMode double mount, and no stale or duplicate lists.
3. Overlay close and focus behavior, with overlay storage rules intact.
4. Layout at 1440/1024/390: no horizontal overflow, cards single row at ≥761, disclaimer in view.
5. Specs: main and parent wording is identical where required, and the parent archive does not revert.
