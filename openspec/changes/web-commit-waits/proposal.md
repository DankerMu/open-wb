## Why
- #369 — `web/test/chat-page.test.tsx:431` (W5): `:444` `await expectChatLocation(...)` waits only for `window.location`; `:445` then synchronously asserts the `快捷任务` chip group is gone. react-router pushes history synchronously but commits the React location inside `startTransition` (`react-router/dist/development/lib/components.js:145-149`), so under parallel load `:445` reads the pre-commit DOM (4× load reproduced 3/4 red with `expected <fieldset …> to be null`, not a timeout). Same mechanism as closed #235.
- #375 — `web/test/login-form.test.tsx:594`: `:606` `findByText("受保护内容")` sees the new tree, `:607` synchronously reads `infoSignal.aborted`. The abort lives in `QuickLogin`'s passive-effect cleanup (`web/src/features/auth/quick-login.tsx:29`); login success commits on DefaultLane, whose passive effects React schedules as a separate Scheduler task, so the DOM can commit before the cleanup runs (observed once red under full `make check` + coverage). Different mechanism, same class: a synchronous assertion on an effect that is committed later than the signal awaited.
- Both are test-timing defects that make "web unit tests green" an unreliable gate; no product defect (verified in the issues).

## Triage
Issue type: test
Fixture level: compact
Upstream suggested level: absent (compact: two isolated test assertions, no production change; one review seat)
Blast radius: test-only; a wrong fix could weaken the handoff/abort assertions or pass vacuously.
Selected risk packs: Concurrency / ordering (router transition commit, passive-effect cleanup); Legacy compatibility (assertion semantics unchanged).
Evidence floor: deterministic seam RED before / GREEN after for each fix (seams not committed, results in PR); both files green; `npm test --workspace web` green; lint/typecheck/anti-drift exit 0.
design.md omitted (compact).

## What Changes
- `chat-page.test.tsx` W5: replace the synchronous `:445` with `await waitFor(() => expect(queryByRole("group",{name:"快捷任务"})).toBeNull())`, then keep `expect(welcomeInput()).toBe(input)` after it (identity asserted only after the handoff committed). Not `waitForElementToBeRemoved` (throws if already gone).
- `login-form.test.tsx` quick-login unmount case: `:607` becomes `await waitFor(() => expect(infoSignal.aborted).toBe(true))`.

Must preserve: every existing assertion (chip group absent, same textarea element, protected content shown, in-flight `/api/info` signal aborted); no deleted/commented assertions; no timeout/retry/pool change in `web/vitest.config.ts` or `vitest.shared.mjs`; no `web/src` change; `expectChatLocation` helper unchanged.
Out of scope: react-router transition configuration; `quick-login.tsx` abort implementation; other `expectChatLocation` callers (#369 audit: none reads post-navigation DOM synchronously; the URL-wait-then-synchronous-negative assertions at `chat-page-ownership.test.tsx:205-209,:219-220` cannot false-red but may pass before commit — #369 lists them as optional evaluation, not done here).

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: ADDED requirement that web test assertions on a committed UI outcome or effect-cleanup side effect wait for that outcome itself, not for an earlier proxy signal.

## Impact
`web/test/chat-page.test.tsx`, `web/test/login-form.test.tsx`. No production or CI change.
