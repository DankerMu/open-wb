## Why
#395: `make ui-walk` desktop-light intermittently fails at `expectRunningSnapshot` (`web/e2e/ui-walk.spec.ts:300`, formerly `:283`). The assistant `content` in the pre-reload REST snapshot does not yet start with the first reply part.
- CI evidence: PR #393 run `36163197994` attempt 1, and PR #425 head `3958156`. In both cases a rerun of only the failed job passed.
- A collateral `post-logout-reload GET /api/auth/me 401 … got 0` follows, because the journey aborts before logout.

**Root cause.** `walkHeldDialogue` (`:298-301`) uses the fake upstream gate reaching `held` as a proxy for "the first chunk is visible server-side", then snapshots immediately.
- `holdFinal` (`server/test/support/fake-upstream.mjs:265-272`) sets `held` *before* writing the first part to its socket.
- The chunk still has to cross the model proxy, omp, the RPC frame and the supervisor before `store.appendDelta` (`server/src/sessions/supervisor.ts:652-653`) runs.
- It is not the DB flush timer: the snapshot read path merges `turn.pending` (`server/src/sessions/store.ts:231`).

## Triage
Issue type: bug (CI flake, test-order race)
Fixture level: compact
Upstream suggested level: absent (compact: reorder two statements in one e2e spec)
Blast radius: `web/e2e/ui-walk.spec.ts` `walkHeldDialogue` pre-reload segment only. No product, server or fake-upstream change (the fake-upstream delay in 2.1 is temporary and not committed).
Selected risk packs: none beyond test evidence.
Evidence floor:
- the reorder is justified by the supervisor call order: `persistEvent` → `appendDelta` runs before `#publish` at `supervisor.ts:423-430`;
- a deterministic RED/GREEN with a temporary 1 s delay in the fake upstream's `holdFinal`, reverted afterwards;
- local ui-walk, both projects, green in 5 fresh runs without the delay;
- `make check` green.

## What Changes
- `web/e2e/ui-walk.spec.ts:298-301`: move `await expectRunningPrefix(page, project, sessionId, prompt)` to run after the `held` poll and before `fetchSessionSnapshot` / `expectRunningSnapshot`.
  - The snapshot assertion keeps its full strength.
  - No new polling, timeouts or retries.
  - The post-reload segment (`:304-317`) is unchanged: by then the prefix is already confirmed and the gate still holds.
- Spec: verification-harness MODIFIED `Web assertions await the committed outcome they check`. The rule is extended to the ui-walk REST snapshot, and a new scenario is added. The active parent change `s1e-frontend-parity` does not modify this requirement.

Must preserve:
- every existing assertion in `walkHeldDialogue`;
- the `expectReducedMotionToggle` placement while held;
- the `watchSessionTraffic` attach point (`:304`, after the snapshot, before reload).

Out of scope: server delta buffering, the fake upstream gate protocol, the post-reload recovery snapshot.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: MODIFIED `Web assertions await the committed outcome they check`.

## Impact
`web/e2e/ui-walk.spec.ts` only.
