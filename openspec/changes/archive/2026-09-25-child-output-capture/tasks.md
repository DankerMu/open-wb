## Risk Packs
- Concurrency / ordering — selected: exit vs stdio close ordering; deterministic regression → 1.1, 1.2, 1.3, 2.1.
- Error handling — selected: bounded capture waits with diagnostics → 1.1, 2.2.
- Legacy compatibility — selected: existing omp-process / fake-omp / fake-upstream / server-config assertions unchanged, no retries → 2.4.
- Public API, Config, Schema, File IO/path safety, Auth/secrets, Resource limits, Release, Documentation — not selected: test-only; #148 adds evidence for an existing config rule without new policy.

## 1. Implementation
- [x] 1.1 omp-process.test.ts: close-based bounded capture helper returning `{stdout, code, signal}` + diagnostic; `readArgvProbe`/`readEnvDump`/default-spawn case use it and pass the diagnostic to their expects; `waitExit` kept for `stopChild`.
- [x] 1.2 fake-omp-helpers.ts: record exit only on `'close'` (frame waits, `waitExit`); `waitExit` gets a bounded timeout whose rejection carries exit code, signal, stdout byte count and event order.
- [x] 1.3 fake-upstream.test.ts: record exit on `'close'`; `waitChildExit` shortcut consistent; existing timeout kept and its message extended with exit code, signal, stdout/stderr byte counts and event order.
- [x] 1.4 server-config.test.ts: bare-name `OMP_BIN: "omp"` → `join(REPO_ROOT, "omp")`, absolute, cwd-independent.

## 2. Verification
- [x] 2.1 Committed regression (real child): spawn, `await once(child, "exit")`, then capture → complete output. (Literal fast-child shape is unobservable: Node resumes unread stdio at exit and discards buffered data before any post-await listener; the committed child hands its stdout to a bounded grandchild that writes only after the test attaches capture, so exit always precedes data and close follows it.) One-off RED (not committed): the old `readChildStdout` shape returns `""` via the `exitCode` shortcut — output in PR evidence.
- [x] 2.2 Diagnostics: a committed case where the child exits with empty/unparseable output (or times out) asserts the failure message contains exit code, signal, byte count and event order.
- [x] 2.3 Bare-name assertion green; one-off red if resolution returned the raw value.
- [x] 2.4 `npm --workspace server run test` 5× consecutive green; `make lint`, `make typecheck`, `make anti-drift` exit 0.

## Audit (exit-then-read sites in server/test/**)
- omp-process.test.ts readChildStdout users + default-spawn case — fixed (1.1).
- fake-omp-helpers.ts recordExit/wait/waitExit — fixed (1.2); real false-red risk on crash scenarios.
- fake-upstream.test.ts :253-255, :263, :275, :380-384 (negative assertions, vacuous-pass risk), waitForReady, waitChildExit shortcut — fixed (1.3).
- server-startup-helpers.ts `track()` — already close-based, no change.
- support/omp-runtime.ts:218, support/omp-rpc.ts:126 — production `OmpProcess` path, out of scope.
