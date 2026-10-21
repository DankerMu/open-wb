# Design — sidecar-settled-claim (#1601)

## Governing invariant

Once the sidecar has settled a job, it never touches that job directory again: no second claim, no second marker. The directory belongs to the app from the first marker on.

## Decisions

- **D1 — memory, not markers.** Every on-disk signal (a claim lock, a renamed directory) is either deleted by the same recursive delete or breaks the app's polling by path (`office.ts:246`) and the "sidecar SHALL NOT delete job directories" rule. An in-memory set of settled ids is the only signal the app's delete cannot remove.
- **D2 — add in `settle`.** `settle` is the single place every outcome goes through (`done`, all `failed` reasons including the immediate `cancelled` / `bad-request` in `start`). Adding the id there covers every path; the marker write may still swallow `ENOENT` as now.
- **D3 — prune per tick from the listing.** `readyJobs` already lists `jobs/`; after the listing, ids in the set that are not in it are removed. The set never exceeds the number of job directories present at the last listing (plus those settled since). Pruning compares against every entry name `readdir` returned, never against the ready list (that would clear every settled id each tick and bring the race back); a directory still present before its final `rmdir` is always listed, so pruning never drops an id whose directory exists. When `jobs/` is absent (`ENOENT`, the early `return []`), the listing is empty and the set is cleared. An id reused after its directory vanished is claimable from the first listing that no longer had it; an id deleted and re-created between two listings stays settled and is never claimed (accepted: the app's ids are 128-bit random, only a test reuses one, and the test waits for a sentinel job to force a listing in between).
- **D4 — restart clears the set.** Same as today's SIGTERM semantics (no marker written, jobs re-claimed after restart). A sidecar restarted mid-delete can still re-claim once; registered with the cancel-path residual (both end at the startup cleanup).
- **D5 — the existing residual stays.** For a job the app no longer waits for (`timeout`, `aborted`, `close()`), the sidecar's first settle (any reason code, including `bad-request` when it claims a half-deleted directory) can still write a marker into a directory being deleted; the set cannot prevent a first write. This residual is already registered and accepted by the owner (office-preview Scenario「终止结束作业的全部进程」, ADR-0014 `:77`, system.md `:438`: 1 in 26 terminations on the test host, removed by `clearWork` at the next start); this change only references it. Considered and not done: `fs.promises.rm({ maxRetries })` in the async `removeJob` (non-blocking, would also absorb it — but the accepted residual is the owner's decision and `office.ts` stays unchanged), and "no marker for `cancelled`" (the app never reads it, but that is a protocol change to existing spec and tests).
- **D6 — deterministic test with the real sidecar, sentinel barriers.** The fixture polls every 20 ms, so fixed sleeps are flaky. The re-claim case waits for the first convert line (the marker is written before the line), deletes `in/` then `done` (while `done` exists no claim can happen, so deleting `in/` first is race-free), then writes a sentinel job with a newer `request.json` and waits for it to settle: claims are in mtime order and `bad-request` settles synchronously, so by then the half-deleted job has been judged at least once. The bounded case uses the same sentinel to force a listing between the delete and the re-creation, and bounds the claim by the fixture's marker wait. Two mutations: skip disabled (re-claim case red) and pruning disabled (bounded case red); before the fix only the re-claim case is red.

## Sibling surfaces

- `converter/sidecar.mjs` (header = protocol single source; `settle`, `readyJobs`).
- `server/src/preview/office.ts` `removeJob` unchanged; `server/test/support/fake-sidecar.ts` already answers each job once (no change).
- Real-sidecar tests: `server/test/converter-sidecar.test.ts`, `converter-sidecar-errors.test.ts`,夹具 `support/converter-sidecar.ts`.
- CI `office-sidecar` job (`.github/scripts/ci-office-sidecar.sh`) unchanged; `ci.yml` has no `workflow_dispatch`, so the issue's "N green runs" is met by re-running that job on the PR head (`gh run rerun --job`) five times, in addition to the deterministic case and its mutations.
- Checked, unchanged: ADR-0014 `:77`, system.md `:438` (residual table; still accurate), `docs/adr/0010-dedicated-omp-uid.md:384`.
- Spec: office-preview「转换 sidecar 实现与镜像」与「sidecar 转换契约」.

## Not yet specified

- Nothing.
