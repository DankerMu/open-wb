# Design — omp-runtime-local-wait-split (#1600)

## Governing invariant

Pure move: for every frame sequence, clock schedule and call order, `SessionRuntime` produces the same frames, receipts, errors, timers and child-process actions as before. No existing test file changes.

## Decisions

- **D1 — two cuts.** Local completion wait (≈50 lines incl. `LocalWait`, the four methods and their blank lines; the call sites shrink to one call each) plus receipt settlement (≈23 lines). Together they bring `runtime.ts` to ≤740 (target recorded in the spec). The retire / recycle cut (issue alternative) stays out: it owns await order and grace timers on the governance critical path and needs a stronger proof.
- **D2 — `local-wait.ts`, not `local-command.ts`.** `local-command.ts` is documented as pure ("Pure: keys only on the leading `/`"); the wait holds a timer and the waiting turn. A separate module keeps the pure rule pure and gives the stateful part one owner.
- **D3 — callbacks, not a back-reference.** The wait class gets `clock`, `current: () => Turn | undefined` and `complete: (turn: Turn) => void` at construction. It never sees the generation, the process or `SessionRuntime`; `import type { Turn }` comes from `./commands.js` (where `Turn` lives), so `local-wait.ts` does not import `./runtime.js` at all.
- **D4 — guards move verbatim.** The tick's stale checks (`this.#localWait !== wait || this.#turn !== turn` → `this.#wait !== wait || current() !== turn`), the re-arm with `Math.max(1, LOCAL_COMMAND_GRACE_MS - elapsedMs)`, setting `turn.commandOutputSeen` before acting on the decision, and `#retire`'s genId-scoped clear keep their order. `#completeTurn` / `#failTurn` / `#abandon` still clear the wait right after `this.#turn = undefined` and before `dropDeferredAbort`.
- **D5 — receipt functions take the set.** `resolveReceipt(pending, turn, receipt)`, `rejectReceipt(pending, turn, error)`, `rejectPendingReceipts(pending, error)` (copy the set before iterating, as now). `SessionRuntime` keeps owning `#pendingReceipts`.
- **D6 — proof of a pure move.** No test file edits; `git diff -M --color-moved` reviewed by the orchestrator; the runtime test files run three times in a full parallel run (timer-sensitive); knip / jscpd zero new.

## Sibling surfaces

- `server/src/sessions/omp/runtime.ts` (source of both cuts), `commands.ts` (receives receipt functions), new `local-wait.ts`.
- `local-command.ts` unchanged; `process.ts` untouched.
- Tests that exercise the moved code: `omp-runtime-local-command.test.ts`, `omp-runtime-abort-start.test.ts`, `omp-runtime*.test.ts`, session-supervisor tests driving real fake-omp children.
- Spec: omp-runtime「omp 运行时源码模块划分」.

## Not yet specified

- Exact class / method names (implementer's choice within D3 / D5; knip must see every export used).
