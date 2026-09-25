# Design: scroll-follow-resize (#373)

Change surface: `web/src/features/chat/scroll-follow.tsx` (`useScrollFollow`, `FollowTranscript`); tests `web/test/chat-scroll-follow.test.tsx`; real-browser steps `web/e2e/ui-walk.spec.ts`.

Must preserve:
- `pinned` written only by user scroll (≤4px → true, else false) and `回到最新` click (→ true); the settle path only reads it (archived `chat-scroll-follow` governing invariant).
- `showJump` set true only when distance > `clientHeight`, cleared only by reaching bottom or click.
- F1–F7 behavior; session `key` remount resets to pinned/no button; welcome state has no follow hook.
- Environments without `ResizeObserver` keep working. Note: `chat-scroll-follow.test.tsx` already runs on the no-op `ResizeObserver` from `web/test/radix-platform.ts` (via `chat-page-support.tsx` → `render-app-router.tsx`), so F1–F7 exercise a no-op RO; only R5 proves the undefined-RO path.
- W5 (`web/test/chat-page.test.tsx:438`): the composer textarea stays the same node across the welcome→session handoff.
- DOM structure `.chat-transcript > section.chat-thread` unchanged with no wrapper in between (the content root is `el.firstElementChild`).

Must add/change:
- `settle(el)`: `if (pinned.current) { el.scrollTop = el.scrollHeight; return; } if (distanceFromBottom(el) > el.clientHeight) setShowJump(true);` — used by the `[content]` layout effect and the observer callback.
- Observer: created once per mount if `typeof ResizeObserver !== "undefined"`; observes the scroll container; in the `[content]` layout effect, unobserve the previous content root and observe `el.firstElementChild` (if any). Callback → `settle(el)`. Cleanup `disconnect()`.

Follow semantics decision — (a) keep following when content grows while pinned:
- (a) preserves the invariant (observer never writes `pinned`), treats expansion by a user who was at the bottom like any other growth (the spec says follow when at the bottom *before* the update), and fixes the "yank on the next delta" surprise by making the follow immediate and consistent.
- (b) would recompute `pinned` from distance inside the observer; it must then tell container shrink (should re-stick) from content growth (should unpin), and the observer becomes a third `pinned` writer. Rejected for complexity.
- Consequence: expanding the last card's `原始输出` while at the bottom scrolls to the end of the expanded output; programmatic `scrollTop` fires a scroll event that keeps `pinned` true.

Governing invariant: after any layout change (content update, container resize, content resize), a pinned transcript is at the bottom (distance ≤4px) and an unpinned transcript's `scrollTop` is unchanged by the recompute; `settle` may only set `showJump` true (when distance > `clientHeight`) and never clears it — `showJump` is cleared only by reaching the bottom (≤4px) via scroll or by clicking `回到最新` (F5 hysteresis, archived chat-scroll-follow design).

Sibling surfaces:
- Producers of size change: alerts above the transcript (`conversation-view.tsx` historyError/promptError/streamError), `<details>` toggles in step cards, viewport/breakpoint changes, `historyView` updates (already via layout effect). Composer has fixed rows — not a source.
- Consumers: `FollowTranscript` only (no other `scrollTop/scrollHeight` users in `web/src`).
- Lifecycle: `key={requestedSessionId}` remount; `historyView === null` (no content root).
- Failure path: missing `ResizeObserver` → layout-effect-only behavior (today's).

Seams under test:
- jsdom: `FollowTranscript` with a spy `ResizeObserver` class (records observe/unobserve/disconnect, exposes a trigger) and mocked `scrollHeight/clientHeight/scrollTop` as in F1–F7.
- Real browser: ui-walk, the running app after the completed reply.

Required evidence:
- jsdom R1: pinned, `clientHeight` shrinks, RO callback fires → `scrollTop === scrollHeight - clientHeight`-equivalent bottom (distance ≤4). RED on pre-change source (no observer → unchanged).
- jsdom R2: unpinned (scrolled up > one viewport), content grows, RO fires → `scrollTop` unchanged, `回到最新` visible.
- jsdom R3: pinned, content root grows (details-like) → follows to bottom (semantics (a)).
- jsdom R4: unmount and session switch → `disconnect` called; after `historyView` goes null→non-null the new content root is observed.
- jsdom R5: `ResizeObserver` explicitly deleted from `globalThis` before mount and restored after → renders, F1-style follow on content change still works, no throw.
- jsdom spy seam: override `globalThis.ResizeObserver` with a spy class before mount and restore the original (the radix-platform no-op) in `afterEach`; the trigger helper is a no-op when no instance exists, so pre-change RED is an assertion failure, not a crash.
- ui-walk W-scroll (both projects), placed inside `walkHeldDialogue`'s `try` after the completed reply and before `clickRoute("设置")`, wrapped in the `withViewport` pattern from `web/e2e/ui-walk-layout.ts:82-95` (export it or copy it): save `page.viewportSize()`, change **height only** (width unchanged so the 760px breakpoint is not crossed), restore in `finally`.
  - Heights are derived from measurements, never fixed: read `.chat-transcript` `clientHeight` and `section.chat-thread` `offsetHeight` at the original viewport, then pick a viewport height that leaves the transcript overflowing by a clear margin (e.g. `scrollHeight - clientHeight >= 60`) with `clientHeight >= 80`; assert both preconditions before any distance assertion, and assert `document.scrollingElement.scrollHeight <= innerHeight + 1` so the page itself does not scroll (styles.css body overflow).
  - Step 1 (container shrink): before shrinking assert distance ≤4; after shrinking `expect.poll` distance ≤4 (pre-change: distance equals the shrink amount, RED).
  - Step 2 (`原始输出`, semantics (a)): assert the bash region contains the `原始输出` summary; assert distance ≤4 and the summary is fully inside the transcript's visible rect, then click it — if it is not fully visible, set `details.open = true` via `evaluate` instead (a Playwright click scroll-into-view would fire a scroll that unpins); assert `section.chat-thread` height grew; `expect.poll` distance ≤4 (pre-change: distance = growth, RED).
  - Step 3 (not yanked): the Step 1 viewport persists here. In one `page.evaluate`, set the transcript `scrollTop` to a position with distance >4 (e.g. `0`) and await that element's next `scroll` event before returning (deterministic unpin, no sleep/tick). Then **shrink the height further** from the Step 1 height (e.g. −40px) — never grow it: distance can only increase, so `scrollTop` cannot clamp and the F5 hysteresis (settle never clears `showJump`) cannot make the button check order-dependent. Re-assert the preconditions (overflow margin, `clientHeight >= 80`, no page scroll) after the shrink; Step 1's target height must leave room for this. `expect.poll` until `clientHeight` equals the new value, read `scrollTop` once and assert it is unchanged, then assert `回到最新` is visible iff distance > `clientHeight`. Whether that visibility is reached depends on content height in each project; the "scrolled up more than one viewport → button visible" scenario is pinned deterministically by jsdom R2.
  - Restore the original viewport in `finally`; later steps (sidebar collapse, theme persistence, logout, layout checks) run at the original size; no new console errors (existing exact oracle).
Non-goals: real-browser reproduction of the `streamError` alert itself (no fault-injection hook in the fake upstream; the alert and a viewport shrink both reach `settle` through the container observer, which jsdom R1 pins); D8 parameter changes.

Review focus:
1. The observer never writes `pinned`; no scroll-write loop (settle on pinned only sets scrollTop; the resulting scroll event keeps pinned true). No RO loop: settle writes only `scrollTop` and a deferred `setShowJump`, and `.chat-jump-latest` is absolutely positioned in the frame outside the observed `.chat-transcript`, so no observed element changes size in the callback; if a loop error surfaced as a page error the existing oracle would fail the walk. Every `observe()`/rebind fires an initial callback; settle is idempotent so it is harmless, and rebinding is skipped when the content root is the same node.
2. Content-root rebinding across `historyView` null↔non-null and `key` remounts; disconnect on unmount.
3. Graceful degrade without `ResizeObserver`.
4. ui-walk steps are deterministic in both projects (overflow actually forced; waits use `expect.poll`, not sleeps) and restore viewport state.
