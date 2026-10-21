# Design — sidecar-settled-claim (#1601)

## Governing invariant

Once the sidecar has settled a job, it never touches that job directory again: no second claim, no second marker. The directory belongs to the app from the first marker on.

## Decisions

- **D1 — memory, not markers.** Every on-disk signal (a claim lock, a renamed directory) is either deleted by the same recursive delete or breaks the app's polling by path (`office.ts:246`) and the "sidecar SHALL NOT delete job directories" rule. An in-memory set of settled ids is the only signal the app's delete cannot remove.
- **D2 — add in `settle`.** `settle` is the single place every outcome goes through (`done`, all `failed` reasons including the immediate `cancelled` / `bad-request` in `start`). Adding the id there covers every path; the marker write may still swallow `ENOENT` as now.
- **D3 — prune per tick from the listing.** `readyJobs` already lists `jobs/`; after the listing, ids in the set that are not in it are removed. The set never exceeds the number of job directories present at the last listing (plus those settled since). An id reused after its directory vanished (the app's ids are 32 random hex chars, so only a test does this) is claimable from the next tick.
- **D4 — restart clears the set.** Same as today's SIGTERM semantics (no marker written, jobs re-claimed after restart). A sidecar restarted mid-delete can still re-claim once; registered with the cancel-path residual (both end at the startup cleanup).
- **D5 — cancel-path residual accepted.** The app writes `cancel` then deletes immediately; the sidecar's first settle of that job (`cancelled` after killing the in-flight process, or `cancelled` at claim) can still write `failed` into a directory being deleted. The set cannot prevent a first write. Accepted and registered in the spec: result unaffected, directory removed by the startup cleanup (`office-cache.ts` `clearWork`). App-side `rmSync` `maxRetries` is rejected: the synchronous retry sleeps on the event loop.
- **D6 — deterministic test with the real sidecar.** The test plays the app's delete in the losing order itself (delete `done` and `in/`, keep `request.json`) and waits at least three poll periods, so the race is forced, not sampled. A mutation run (set disabled) shows the case red. The bounded-set case re-creates a deleted id and expects a claim within one poll period after the listing that no longer had it.

## Sibling surfaces

- `converter/sidecar.mjs` (header = protocol single source; `settle`, `readyJobs`).
- `server/src/preview/office.ts` `removeJob` unchanged; `server/test/support/fake-sidecar.ts` already answers each job once (no change).
- Real-sidecar tests: `server/test/converter-sidecar.test.ts`, `converter-sidecar-errors.test.ts`,夹具 `support/converter-sidecar.ts`.
- CI `office-sidecar` job (`.github/scripts/ci-office-sidecar.sh`) unchanged.
- Spec: office-preview「转换 sidecar 实现与镜像」与「sidecar 转换契约」.

## Not yet specified

- Nothing.
