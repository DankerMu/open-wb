# Design — omp-runtime-local-wait-split (#1600)

## Governing invariant

Pure move: for every frame sequence, clock schedule and call order, `SessionRuntime` produces the same frames, receipts, errors, timers and child-process actions as before. No existing test file changes.

## Decisions

- **D1 — two cuts.** Local completion wait (≈54 lines incl. `LocalWait`, the four methods and their blank lines; the call sites shrink to one call each) plus receipt settlement (≈23 lines); about 80 lines leave and about 8 come back (imports, construction), so `runtime.ts` lands near 728–733. Target for this change: ≤740 (recorded here and in tasks, not as a permanent spec limit — the permanent limit stays size-guard's 800). Fallback if it lands above: move `systemClock` (`:103-109`) to `commands.ts`; `sanitizeError` cannot move (value-imports `SessionBusyError`). The retire / recycle cut (issue alternative) stays out: it owns await order and grace timers on the governance critical path and needs a stronger proof.
- **D2 — `local-wait.ts`, not `local-command.ts`.** `local-command.ts` is documented as pure ("Pure: keys only on the leading `/`"); the wait holds a timer and the waiting turn. A separate module keeps the pure rule pure and gives the stateful part one owner.
- **D3 — callbacks, not a back-reference.** The wait class gets `clock`, `current: () => Turn | undefined` and `complete: (turn: Turn) => void` at construction (created in the constructor after `this.#clock` is set, not as a field initializer). It never sees the generation, the process or `SessionRuntime`. Its imports are exactly: `import type { SessionClock } from "./runtime.js"` (as `commands.ts:6` does; `SessionClock` stays defined and exported in `runtime.ts`); `import { localSignal, type Turn } from "./commands.js"`; `decideLocalCompletion`, `LOCAL_COMMAND_GRACE_MS`, `type LocalState` from `./local-command.js`; `import type { OmpFrame } from "./frame.js"`. The only value-import chain is local-wait → commands → process; no runtime cycle. It does not import `./ui-requests.js` and contains no `extension_ui_response`.
- **D4 — guards move verbatim.** The tick's stale checks (`this.#localWait !== wait || this.#turn !== turn` → `this.#wait !== wait || current() !== turn`), the re-arm with `Math.max(1, LOCAL_COMMAND_GRACE_MS - elapsedMs)`, setting `turn.commandOutputSeen` before acting on the decision, and `#retire`'s genId-scoped clear keep their order. `#completeTurn` / `#failTurn` / `#abandon` still clear the wait right after `this.#turn = undefined` and before `dropDeferredAbort`.
- **D5 — receipt functions take the set.** `resolveReceipt(pending, turn, receipt)`, `rejectReceipt(pending, turn, error)`, `rejectPendingReceipts(pending, error)` (copy the set before iterating, as now). `SessionRuntime` keeps owning `#pendingReceipts`.
- **D6 — proof of a pure move.** No test file edits; `git diff -M --color-moved` reviewed by the orchestrator; the full server suite runs three times (timer-sensitive; the local-wait paths are exercised by `fake-omp-slash`, `fake-omp`, `supervisor-command-output`, `omp-dispatch`, `session-events-command`, which a prefix filter would miss); knip / jscpd zero new; a grep that every `./runtime.js` import in `local-wait.ts` is `import type`. Critical Path (AGENTS.md「omp 子进程治理」): the PR description requests human white-box review.

## Sibling surfaces

- `server/src/sessions/omp/runtime.ts` (source of both cuts), `commands.ts` (receives receipt functions), new `local-wait.ts`.
- `local-command.ts` unchanged; `process.ts` untouched.
- Tests that exercise the moved code: `omp-runtime-local-command.test.ts`, `omp-runtime-abort-start.test.ts`, `omp-runtime*.test.ts`, `fake-omp-slash.test.ts`, `fake-omp.test.ts`, `supervisor-command-output.test.ts`, `omp-dispatch.test.ts`, `session-events-command.test.ts`, session-supervisor tests driving real fake-omp children.
- Source-reading boundary tests that will walk the new file: `omp-runtime-commands.test.ts:782-799`, `omp-runtime-exit-pending.test.ts:714-732` (G2), `omp-approval-requests.test.ts:490`.
- Spec: omp-runtime「omp 运行时源码模块划分」.

## Not yet specified

- Exact class / method names (implementer's choice within D3 / D5; knip must see every export used).
