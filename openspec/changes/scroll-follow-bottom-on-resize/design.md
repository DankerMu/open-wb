# Design: scroll-follow-bottom-on-resize (#411)

## Decision: settle may set `pinned` to true, never to false
- The archived #373 design (`openspec/changes/archive/2026-09-25-scroll-follow-resize/design.md`) kept `settle` read-only on `pinned`. It rejected option (b), "recompute `pinned` from distance in the observer", because that option has to tell a container shrink (re-stick) from content growth (unpin) in order to decide when to **unpin**.
- This change adds only the monotone half: `distance <= 4px → pinned = true`. It never unpins, so the shrink-vs-growth ambiguity that sank (b) does not arise.
  - Reaching the bottom by a size change is indistinguishable, for the user, from reaching it by scrolling. `onScroll` already treats that case as pinned.
  - No RO write loop: the branch writes no layout (no `scrollTop`), and `setShowJump(false)` only removes an absolutely-positioned button outside the scroll container (`.chat-transcript-frame > .chat-jump-latest`). That removal does not resize the observed elements.
- Why pinning matches what users see:
  - An unpinned transcript can reach ≤4px without a scroll event only through a taller container or shorter content. Content growth only increases the distance.
  - Any further change clamps `scrollTop` and fires a scroll event, which `onScroll` already pins.
  - The recommended option leaves a gap at the non-clamping edge: "at the bottom but not following".
  - `会话页` defines following by distance ("at the bottom (within 4px) before the update"), so pinning here moves closer to the spec.
- Consequence: once settle has pinned, a later container shrink takes the pinned branch (`scrollTop = scrollHeight`), exactly like R1. This is intended and is not a "yank"; W-scroll 4's viewport restore goes down this path.
- Rejected alternative: the issue's "recommended" option, clearing the button only. The user would be visibly at the bottom, but the next delta would not follow, and the button would only return once content outgrows a screen.

## Governing invariant (replaces #373's)
After any layout change (content update, container resize, content resize):
- a pinned transcript is at the bottom (distance ≤4px);
- an unpinned transcript's `scrollTop` is unchanged by the recompute;
- the recompute may raise `showJump` (distance > `clientHeight`), or pin and clear it (distance ≤4px);
- it never unpins.

`pinned` writers:
- user scroll (≤4px → true, otherwise false);
- the `回到最新` click (true);
- settle (true only, at ≤4px).

## Seams under test
- jsdom, with a spied `ResizeObserver` per the existing R-series harness in `web/test/chat-scroll-follow.test.tsx`:
  - Setup: `scrollTop 0`, distance > `clientHeight`, fire scroll → the button shows.
  - Then mock `clientHeight >= scrollHeight` (distance 0) and fire the RO callback → the button is gone and `scrollTop` is unchanged. RED before the fix.
  - Then a content update (a new delta or `historyView` change) → the transcript follows: assert `distance() <= 4`, not `scrollTop === scrollHeight`, because the mock setter clamps to `scrollHeight - clientHeight`.
  - Hysteresis: shown button, and the RO callback at distance in `(4, clientHeight]` → the button stays and `scrollTop` is unchanged.
- ui-walk `W-scroll 4` (both projects), after `W-scroll 3`:
  - with the transcript scrolled up and the button visible, raise the viewport height until the transcript no longer overflows (`scrollHeight <= clientHeight`);
  - wait two frames;
  - assert that `回到最新` has count 0.
