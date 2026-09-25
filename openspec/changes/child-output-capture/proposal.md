## Why
- #191 — `server/test/omp-process.test.ts` `readChildStdout` (:600-608) attaches `stdout` `'data'` and returns after `waitExit` (:666-678). `waitExit` resolves immediately when `child.exitCode !== null` (:667) and otherwise on `'exit'`. Node does not guarantee stdio is drained at `'exit'`; only `'close'` follows stream closure. Likely root cause of the observed `envDump = {}`: after `await spawnOmp(...)` the fast `/usr/bin/env` child has often already exited, so the `exitCode` shortcut returns before any pipe data is read. The default-spawn case (:242-268) has the same shape. There is no timeout, so a stream that never closes would only hit the generic vitest timeout without diagnostics.
- Sibling sites with the same exit-before-drain pattern:
  - `server/test/fake-omp-helpers.ts` (moved from fake-omp.test.ts in #342): `recordExit` on both `'exit'` and `'close'` (:103-104), `wait()` rejects "child exited before frame" once exit is seen (:133-135), `waitExit` settles on whichever comes first (:195-217). `crash`/`crash-after-deltas` scenarios (`support/fake-omp.mjs:208-217, :287-291`) emit the prompt ack then `process.exit(2)`, so `fake-omp.test.ts` positive waits can false-red and post-exit negative checks (no `agent_end`) can pass vacuously.
  - `server/test/fake-upstream.test.ts`: `spawnNode` records exit on `'exit'` (:500); `waitChildExit` (:564-588) resolves on `'exit'` and short-circuits on `childExits` (:565-568, :581-586); callers read `cli.stdout()/stderr()` after `waitExit()` (:253-255, :263, :275, :380-384) — negative assertions, so truncation passes vacuously rather than false-red.
  - Correct reference already in the repo: `server/test/server-startup-helpers.ts` `track()` waits `once("close")`.
- #148 — `OMP_BIN` relative values bind to the repo root (`server/src/agent-config.ts` `resolveOwnedPath`, `isAbsolute(raw) ? raw : join(repoRoot, raw)`; spec `http-service-skeleton` 服务启动与装配). `server/test/server-config.test.ts` covers relative values containing `/` (:131, :239, :265) but not a bare name, the case that would otherwise reach execvp PATH/cwd lookup.

## Triage
Issue type: test
Fixture level: standard
Upstream suggested level: absent (standard: test-harness wait semantics + one config assertion; no production change)
Blast radius: test-only; a wrong fix could hang tests on streams that never close or weaken existing assertions.
Selected risk packs: Concurrency / ordering (exit vs stdio close); Error handling (bounded waits with diagnostics); Legacy compatibility (existing assertions unchanged).
Evidence floor: deterministic RED for the old exit-based capture, GREEN with close-based capture; diagnostics shown on a forced failure; bare-name config assertion; full server suite 5× consecutive green; lint/typecheck/anti-drift.

## What Changes
- `omp-process.test.ts`: real-child capture helper that attaches listeners, waits `once(child, "close")` with a bounded timeout, and returns `{stdout, code, signal}` plus a diagnostic string (exit code, signal, stdout byte count, observed `data`/`exit`/`close` event order). `readArgvProbe`/`readEnvDump` and the default-spawn case use it; their `toEqual`/`toBe` assertions pass the diagnostic as the expect message. Timeout rejects with the diagnostic. `waitExit` stays for `stopChild`.
- `fake-omp-helpers.ts`: exit is recorded only on `'close'`, so frame waits and `waitExit` observe exit only after stdout is drained; `waitExit` becomes bounded with the same diagnostics on timeout; existing tests keep their assertions.
- `fake-upstream.test.ts`: exit recorded on `'close'`; `waitChildExit` and its `childExits` shortcut therefore reflect drained stdio; existing timeout kept with the same diagnostics added to its message; `waitForReady` benefits (exit-before-ready diagnostics complete).
- `server-config.test.ts`: `OMP_BIN: "omp"` resolves to `join(REPO_ROOT, "omp")`, `isAbsolute` true, identical under an unrelated cwd.

Must preserve: all existing assertions (6-key env whitelist, `FORBIDDEN_KEYS` absent, synthetic token not in argv, argv/cwd probes, status 0, fake-omp frame/crash/error scenarios, fake-upstream CLI readiness/failure cases); no retries or loosened assertions; no `server/src` change; no new config policy (no rejection of bare names). Out of scope: `support/omp-runtime.ts:218` and `support/omp-rpc.ts:126` (they drive production `OmpProcess`).

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: ADDED requirement that real-child output assertions depending on complete output wait for stream closure, with bounded waits and diagnostics.

## Impact
`server/test/omp-process.test.ts`, `server/test/fake-omp-helpers.ts`, `server/test/fake-upstream.test.ts`, `server/test/server-config.test.ts`. No production or CI change.
