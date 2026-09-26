## Why
#424 — user decision 2026-09-25: "会话列表放侧栏". The chat page renders its own session-list column inside `main` (`web/src/features/chat/conversation-view.tsx:178-208`, grid `web/src/features/chat/chat.css:20-29`, mobile stack `chat.css:474-484`). Next to the 288px shell sidebar this squeezes the welcome state:
- at 390×844 the list block (~170px) pushes the disclaimer below the first screen (checklist CH-07);
- at 1024 the five best-practice cards wrap 2+2+1, because the card row wraps (`chat.css:289-302`) while the demo row is single-line (`resource/workbuddy-live-demo.html:408-409`).

Removing the column alone does not fix 1024: the remaining 680px < 740px, so the cards would still wrap 4+1. The card row must follow the demo's nowrap rule as well. The demo keeps the list in the sidebar below the nav (demo:274 `.sidebar-main`, markup :1797, rendered only on the chats tab :1852, hidden when collapsed :241).

## Triage
Issue type: enhancement (demo-parity layout)
Fixture level: expanded
Upstream suggested level: absent (expanded: shell + chat feature structure, two spec pairs in main and the active parent change, e2e harness locators)
Blast radius: every `/` render (desktop, collapsed, narrow overlay), ui-walk journeys in both projects, ui-shots chat states, ~10 jsdom files.
Selected risk packs: Legacy compatibility (list semantics, ownership fences, locators); Accessibility (overlay close and focus return, landmark placement); Concurrency / state ownership (list state stays in ChatPage; fences unchanged); Documentation (spa-shell + chat-web main and parent deltas, parent proposal deviation #7, checklist CH-15/CH-07).
Evidence floor: RED ui-walk layout assertions (1024 cards one row, disclaimer in first viewport at 1024/390) before the change; jsdom sidebar list-area cases; `make check`, `make ui-walk`, local `make ui-shots` 60/60 with orchestrator visual check.

## What Changes
- **Slot** — new `web/src/lib/sidebar-slot.tsx`, at the same layer as `lib/topbar.tsx` and following the `useTopbar` pattern: `ChatPage` reports its rendered list node (`新建会话` + `会话列表`); `Sidebar` renders it inside its own React tree, so the Radix Drawer treats list clicks as inside; the overlay variant supplies a close callback through context. There is no inline fallback.
- **Sidebar** — renders the list area between `主导航` and the user area. The area is not rendered when collapsed, and appears after the nav in the overlay. Selecting or creating a session in the overlay closes it.
- **Chat page** — `.chat-layout` becomes a single full-width column and the in-main `aside.chat-sidebar` is removed; list styles move to the sidebar context.
- **Card row** — nowrap at `≥761px` per demo:408-409 (without the demo's `overflow: hidden`, which would clip focus rings); wrap is kept at `≤760px`.
- **Tests** — ui-walk and ui-shots locators updated for the new location (390: open the overlay first); jsdom tests given a slot host.
- **Specs**
  - spa-shell MODIFIED `路由 IA 与侧栏`: list-area sentence, scenario tweaks, new scenario `侧栏会话列表区`.
  - chat-web MODIFIED `会话页`: first sentence, playbook row and disclaimer rule, `欢迎态与静态引导` THEN.
  - The active parent deltas get the same sentences (spa-shell list sentence and scenarios; chat-web three clauses identical).
  - Parent proposal gains deviation #7.
- **Docs** — `docs/acceptance/demo-parity-checklist.md` CH-15 rewritten: sidebar placement becomes an S1e sign-off item, grouping stays S1c not-applicable.

Must preserve:
- Every list behavior of chat-web `会话页`:
  - owner-only list, `updatedAt` desc, server title or `新会话`;
  - `role=status` names `<title> 运行中|已完成|失败|未开始` and `ui-pulse` on running;
  - `aria-current="true"` on the current item;
  - title/status sync with history (`page.tsx:662-683`);
  - `?session=` writes that keep other search/hash;
  - list loading/error alerts;
  - account-switch and unmount fences and abort ownership (`page.tsx:115-150`).
- spa-shell rules:
  - shell never reads chat data;
  - `workbuddy-sidebar` read/write rules; the overlay never touches it;
  - overlay close and focus rules;
  - no horizontal overflow at any viewport.
- Locator names `nav[aria-label="会话列表"]` and `新建会话` stay.
Out of scope: grouping/pinning/item menus/filter/search (S1c), SH-01 dark background (#420), any backend change.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `spa-shell`: MODIFIED `路由 IA 与侧栏`.
- `chat-web`: MODIFIED `会话页`.

## Impact
`web/src/lib/sidebar-slot.tsx` (new), `web/src/routes/shell/{app-shell.tsx,sidebar.tsx,sidebar.css}`, `web/src/features/chat/{conversation-view.tsx,page.tsx,chat.css}`, `web/e2e/{ui-walk.spec.ts,ui-walk-*.ts,ui-shots.mjs}`, jsdom tests (chat-page*, chat-composer, routes, sidebar, app-shell-responsive, helpers), `docs/acceptance/demo-parity-checklist.md`, parent change `s1e-frontend-parity` (proposal + spa-shell/chat-web deltas).
