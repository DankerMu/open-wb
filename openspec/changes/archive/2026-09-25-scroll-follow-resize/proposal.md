## Why
#373 (PR #371 / #290 review follow-up) — `web/src/features/chat/scroll-follow.tsx` recomputes follow state only on user scroll, `回到最新` click, and `useLayoutEffect([content])` (`content` = `historyView` from `conversation-view.tsx`). Size changes without a `historyView` change produce no scroll event and no recompute:
1. **Container shrinks** — `streamError`/`promptError` alerts render in `.chat-main` above the transcript; `clientHeight` drops by the alert height, `scrollTop` stays, the last lines fall below the fold. `onError` is terminal (`stream.ts` `fail()` closes the source), so no later delta repairs it. Headless-Chromium probe from the issue: `clientHeight 472→424`, distance `0→48`, 0 scroll events.
2. **Content grows outside React** — expanding a step card's `<details>` `原始输出` is pure DOM; `scrollHeight` grows (probe: distance `0→900` > `clientHeight`), `pinned` stays true, and the next delta then yanks the user to the bottom while `回到最新` never shows.
Introduced in `37ef4f5` (#290); jsdom tests mock dimensions and cannot see layout.

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: adds real-browser steps to the ui-walk Playwright harness — a project expanded-trigger — and changes an observer lifecycle tied to session remounts)
Blast radius: chat transcript scrolling for every session; a wrong fix could yank users who scrolled up, loop scroll writes, leak observers across session switches, or break jsdom tests lacking `ResizeObserver`.
Selected risk packs: Concurrency / ordering (layout effect vs observer callback vs scroll events); Resource limits (observer lifecycle, no leak across `key` remounts); Legacy compatibility (F1–F7 semantics, D8 parameters, jsdom environments without `ResizeObserver`); Public API / script entry (ui-walk harness steps, both projects).
Evidence floor: jsdom RED→GREEN for the recompute paths with a spy `ResizeObserver`; ui-walk real-Chromium steps green in both projects; `npm test --workspace web`, `make lint`, `make typecheck`, `make anti-drift` exit 0; CI `ui-walk` green.

## What Changes
- `scroll-follow.tsx`: extract the layout effect body into one read-only `settle(el)` (pinned → `scrollTop = scrollHeight`; else show `回到最新` when distance > `clientHeight`). A `ResizeObserver` watching the scroll container and its current content root (`el.firstElementChild`) calls `settle`. The content root is re-bound on every `content` change (it is `null` while `historyView` is `null`). Disconnect on unmount / `key` remount. When `ResizeObserver` is undefined the hook skips observing (graceful degrade; no jsdom global setup change).
- Follow semantics for content growing while pinned: **(a) keep following** (see design.md). `pinned` stays written only by scroll and click — the archived governing invariant is unchanged.
- `web/test/chat-scroll-follow.test.tsx`: spy `ResizeObserver` cases (container shrink while pinned re-sticks; growth while scrolled up shows the button without moving; disconnect on unmount/session switch; content-root rebinding; no-RO degrade).
- `web/e2e/ui-walk.spec.ts`: real-Chromium steps after the completed reply (both projects).

Must preserve: F1–F7 in `chat-scroll-follow.test.tsx` unchanged; D8 parameters (4px tolerance, one-viewport threshold); `key={requestedSessionId}` reset semantics; welcome state (no `FollowTranscript`); existing ui-walk steps and exact browser-error oracle; `radix-platform.ts` shim unchanged. Out of scope: moving alerts into the transcript; `<details>` interaction itself; tolerance/threshold changes.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-web`: ADDED requirement that size changes of the transcript container or its content trigger the same follow recompute (ADDED rather than MODIFIED because the active `s1e-frontend-parity` change restates `会话页` wholesale).

## Impact
`web/src/features/chat/scroll-follow.tsx`, `web/test/chat-scroll-follow.test.tsx`, `web/e2e/ui-walk.spec.ts` (possibly a small helper in `web/e2e/ui-walk-layout.ts`). No server, API or CI config change.
