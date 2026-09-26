## Risk Packs
- None selected: e2e test-order change only, with no runtime, API or product change. The evidence is the causal ordering plus repeated local runs → 2.1, 2.2.

## 1. Implementation
- [x] 1.1 In `web/e2e/ui-walk.spec.ts` `walkHeldDialogue` (`:298-301`), reorder to:
  1. `held` poll;
  2. `await expectRunningPrefix(page, project, sessionId, prompt)`;
  3. `fetchSessionSnapshot`;
  4. `expectRunningSnapshot`.

  Keep `expectReducedMotionToggle` right after the snapshot assertion, still while held. Add a one-line comment stating why the prefix gates the snapshot: `held` flips before the chunk reaches the store, while the supervisor persists before it publishes. Change nothing else.

## 2. Verification
- [x] 2.1 Make the race deterministic with a temporary fake-upstream delay. It is local only and must be reverted, with `git diff --stat server` empty at the end.
  - In `server/test/support/fake-upstream.mjs` `holdFinal` (`:265-272`), keep `gate.phase = "held"` synchronous. Wrap the `writeSseHeaders` call and the `writeSseFrames` call that carries `REPLY_PARTS[0]` in `setTimeout(…, 1000)`.
  - RED: with the delay and the **old** order, run ui-walk. Record the failure at `expectRunningSnapshot`.
  - GREEN: with the delay and the **new** order, run ui-walk again; it passes (`expect.poll`'s default 5 s absorbs the 1 s).
  - Revert the delay.
  - Also record the supervisor ordering evidence (`#commit` → `persistEvent` → `#publish`) in the report.
- [x] 2.2 Without the delay, local ui-walk with the CI recipe (`bash .github/scripts/ci-compiled-server.sh ui-walk` with the CI env) exits 0 for both projects in 5 consecutive full runs. Each run uses a **fresh** temp dir: `--repeat-each` is not possible, because the script forwards only `$1` and the files walk asserts that `walk-out-<project>` does not exist yet. Record the pass counts.
- [x] 2.3 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. `openspec validate ui-walk-held-snapshot-order --strict --no-interactive` passes.
