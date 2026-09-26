## Risk Packs
- Concurrency / state ownership — selected: the `pinned` writer set gains "settle, true only, at ≤4px"; `settle` never unpins and never writes `scrollTop` while unpinned (`design.md`) → 1.1, 1.2.
- Legacy compatibility — selected: F1–F8, R1–R5, F5 hysteresis `(4, clientHeight]`, the no-`ResizeObserver` fallback and the session remount reset are unchanged → 1.2, 2.2.
- Public API, Config, Schema, File IO, Auth/secrets, Resource limits, Error handling, Accessibility, Documentation, Release — not selected.

## 1. Implementation
- [x] 1.1 `web/src/features/chat/scroll-follow.tsx` `settle()` (`:22-32`): in the unpinned path, compute `distance` once. If `distance <= PIN_TOLERANCE_PX`, set `pinned.current = true` and call `setShowJump(false)`. Otherwise keep `if (distance > el.clientHeight) setShowJump(true)`. Update the comment above `settle` to state the new rule: it may pin at the bottom but never unpins, and it never writes `scrollTop` while unpinned. Replace both "Read-only recompute" and "never writes it".
- [x] 1.2 `web/test/chat-scroll-follow.test.tsx` `(R)` describe: add cases using the existing R-series harness (spied RO, mocked metrics).
  - (a) Bottom reached by resize, per `design.md` Seams: the button is gone, `scrollTop` is unchanged, and a following content update pins the transcript to the bottom.
  - (b) Hysteresis on resize: the button stays and `scrollTop` is unchanged.

  Write them first and show (a) RED on the unchanged code. (b) passes on both, as a regression guard.
- [x] 1.3 `web/e2e/ui-walk.spec.ts`: add `W-scroll 4` after `W-scroll 3` (`:470-500`) for both projects.
  - **Placement:** inside the same `withViewport(step1Height)` callback as W-scroll 3 (`:426-500`), using direct `setViewportSize` calls like W-scroll 3. The outer `finally` restores the viewport. Outside that block the viewport is already back to its original height, and on mobile 844 the transcript may not overflow, so the precondition would be lost.
  - **Precondition:** start from the state W-scroll 3 leaves (scrolled up). If `回到最新` is not visible, scroll to top and shrink the viewport until distance > `clientHeight`, keeping `clientHeight >= 80`. If no height in that window works, stop and report. Then assert the button is visible.
  - **Grow:** `setViewportSize` to a taller height, estimated as the current height plus `scrollHeight - clientHeight`, capped at 2000px (if that is not enough, stop and report). `expect.poll` until `scrollHeight <= clientHeight` (or distance ≤4). Do not use `expectClientHeight` exact values, and do not call `expectForcedOverflow`, which requires overflow.
  - **Assert:** wait two frames, then assert `回到最新` has count 0. Log the heights used.
  - Reuse the existing helpers (`transcriptMetrics` and friends).

## 2. Verification
- [x] 2.1 RED: 1.2(a) fails before 1.1; record the failure. After 1.1, everything passes.
- [x] 2.2 `web/test/chat-scroll-follow.test.tsx` existing F1–F8 and R1–R5 pass unchanged. Local ui-walk with the CI recipe (fresh temp dir) exits 0 for both projects; record the W-scroll 4 log line.
- [x] 2.3 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. `openspec validate scroll-follow-bottom-on-resize --strict --no-interactive` passes.
