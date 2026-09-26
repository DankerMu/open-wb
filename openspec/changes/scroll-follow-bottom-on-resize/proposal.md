## Why
#411: the user scrolls up, so `回到最新` appears. A later size change can then bring the transcript within 4px of the bottom (viewport taller, an alert above it closing, content shorter) without clamping `scrollTop`, and therefore without a scroll event. The button then stays visible until the user clicks it or scrolls. The typical case is a transcript that no longer overflows: clicking the button scrolls nothing and only hides it.
- Cause: `settle()` (`web/src/features/chat/scroll-follow.tsx:22-32`) only ever raises `showJump`, and does nothing when the transcript is unpinned but within 4px of the bottom.
- Spec gap: `openspec/specs/chat-web/spec.md` `会话页` says the button stays "until the transcript reaches the bottom (within 4px) or the button is clicked". The `#373` design narrowed that to "scroll or click".
- The issue also infers that `pinned` stays `false` in this state, so later deltas do not auto-follow even though the user is visibly at the bottom.

## Triage
Issue type: bug (chat UX)
Fixture level: compact
Upstream suggested level: absent (compact: one branch in `settle()`, spec and design text, jsdom and one ui-walk step)
Blast radius: `FollowTranscript` / `useScrollFollow` only (#373 grep-verified that there are no other `scrollTop/scrollHeight` users).
Selected risk packs:
- Concurrency / state ownership: the `pinned` writer set changes. This is the reason for `design.md`.
- Legacy compatibility: F1–F8 and R1–R5, and F5 hysteresis `(4, clientHeight]`, are unchanged.
Evidence floor:
- RED-first jsdom case: RO callback at distance 0 hides the button, and a subsequent delta follows;
- jsdom hysteresis case;
- a ui-walk "taller viewport" step in both projects;
- existing scroll-follow tests unchanged and green;
- `make check` green.

## What Changes
- `settle()` unpinned branch: if `distanceFromBottom(el) <= PIN_TOLERANCE_PX`, set `pinned.current = true` and `setShowJump(false)`, mirroring `onScroll`'s bottom branch. Otherwise the existing `> clientHeight → setShowJump(true)` applies. `scrollTop` is never written in this branch.
- Chosen over the issue's "recommended" option (clear the button only, keep `pinned` false). With that option a user who is visibly at the bottom would not follow the next delta, and the button would only reappear after content grows by more than a screen. See `design.md`.
- Tests: jsdom cases in `web/test/chat-scroll-follow.test.tsx` (new `R`-series ids) and a ui-walk `W-scroll 4` step.
- Spec: chat-web MODIFIED `转录区尺寸变化触发贴底重算` states the new writer and adds two scenarios. The archived #373 design text is kept as history and not edited; this change's `design.md` supersedes its governing invariant. The active parent change `s1e-frontend-parity` does not contain this requirement.

Must preserve:
- F5 hysteresis;
- the 4px tolerance and the one-screen threshold (D8);
- no `scrollTop` write while unpinned;
- a size change never sets `pinned` to false;
- the no-`ResizeObserver` fallback;
- session-key remount reset;
- DOM structure.

Out of scope: tolerance and threshold values, the shrink/expand paths already covered by #373, other chat surfaces.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-web`: MODIFIED `转录区尺寸变化触发贴底重算`.

## Impact
- `web/src/features/chat/scroll-follow.tsx`
- `web/test/chat-scroll-follow.test.tsx`
- `web/e2e/ui-walk.spec.ts` (W-scroll block)
