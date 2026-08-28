# 5-Dimension AND Gate

## Contents
- Why AND, Not Weighted Sum
- Two Tiers of Gate
- The 5 Dimensions
- Gate Decision Matrix
- The Promotion Gate (blocking)
- The Completion Gate (blocking)
- Edge Cases
- Logging Gate Decisions

## Why AND, Not Weighted Sum

Weighted scoring lets a large gain in one dimension compensate for a loss in another:

- Quality up 10% but token cost 3x → weighted sum might PASS
- pass_rate up 5% but 2 regressions → weighted sum might PASS
- Safety warning appeared but pass_rate improved → weighted sum might PASS

AND logic prevents all of these. Every dimension must independently pass. No compensation across dimensions.

## Two Tiers of Gate

The per-iteration gate below decides KEEP or DISCARD for one mutation. It runs on dev results only, and it never reaches back to revise an earlier decision — a loop that re-litigates its own history cannot make progress.

That is the right rule for one iteration and the wrong rule for a whole run. A sequence of individually-justified KEEP decisions can still land on an artifact that memorized the dev set. Detecting that requires held-out evidence, which is too expensive to run every iteration and useless if it has no consequences.

So there are two tiers:

| Tier | Runs | Scope | Consequence |
|---|---|---|---|
| **Iteration gate** | Every iteration | dev, L1+L2 | KEEP or DISCARD this mutation |
| **Promotion gate** | Before every layer promotion | holdout + regression | Blocks promotion; may trigger rollback |
| **Completion gate** | Once, before declaring success | holdout + regression + control arm | Blocks the success claim; sets the run verdict |

The promotion and completion gates are blocking. They cannot be waived, and a run that fails them is not a successful run regardless of how good its dev numbers look.

## The 5 Dimensions

### Dimension 1 — Structure

**Question:** Did L1 Quick Gate pass?

**PASS:** All structural checks pass, no critical safety violations.
**FAIL:** Any L1 critical check failed.

The cheapest gate — if the artifact is structurally broken, nothing else matters.

### Dimension 2 — Progress

**Question:** Did the artifact get at least as good as the previous best?

**GT Suite / Hybrid PASS:** `current_pass_rate >= previous_best_pass_rate`
**Scoreboard PASS:** primary scalar metric is better than the previous best in the configured direction, or tied while the artifact is simpler or cheaper.
**FAIL:** quality is worse than previous best, or the scalar metric moves in the wrong direction.

"Previous best" means the best kept iteration, not the immediately previous one (discarded iterations are skipped).

Ties are acceptable only when they buy simplification, lower cost, or another explicitly recorded benefit. A tie that only adds complexity is a discard.

### Dimension 3 — Regression

**Question:** Did any previously-passing case start failing?

**PASS:** No case went from PASS to FAIL.
**FAIL:** Any case regressed.

**Noise handling:** If exactly 1 case regressed while multiple others improved, run the regressed case 3x before declaring regression. If 2 of 3 runs pass → LLM noise, count as PASS. If 2 of 3 fail → real regression, count as FAIL.

### Dimension 4 — Cost

**Question:** Is resource cost acceptable?

**PASS:** Both token count and execution time within 2x of baseline per-case averages.
**FAIL:** Either exceeds 2x baseline.

The 2x threshold is the default (configurable in evolve_plan.md). For optimization-focused evolutions where cost IS the goal, tighten this.

Cost is per-case average, not total — if more cases pass, total cost naturally increases, and that's fine.

### Dimension 5 — Safety

**Question:** Are all safety rules satisfied?

**PASS:** Zero critical violations AND warning count did not increase from previous iteration.
**FAIL:** Any new critical violation, OR warning count increased.

Pre-existing warnings don't cause failure — only NEW warnings do.

## Gate Decision Matrix

```
All dimensions PASS → KEEP (changes stay, update "previous best")
Any dimension FAIL → DISCARD (revert/reset to previous best, log failure reason)
```

No "partial keep" or "keep with warning." Binary decision. Scoreboard Mode uses the same binary gate, but Dimension 2 compares the configured scalar metric instead of pass_rate. Pairwise Mode redefines Dimension 2 as a pairwise win against the predecessor — see `pairwise-mode.md`.

## The Promotion Gate (blocking)

Runs before promoting from Layer K to Layer K+1, on holdout and regression sets.

| Check | Blocks promotion when |
|---|---|
| Holdout direction | Holdout metric is below its value at the last promotion (or at baseline, for the first promotion) |
| Overfitting gap | `dev_pass_rate - holdout_pass_rate > 0.15` |
| Regression suite | Any regression case fails |

On a block, do not promote. Instead:

1. Identify the kept iterations since the last passing promotion gate — these are the rollback candidates.
2. Re-run holdout at the last iteration that passed a promotion gate. If holdout there is better, revert to it and log the rolled-back iterations with `decision: ROLLBACK` and the holdout evidence.
3. If holdout is flat everywhere, the layer produced dev-only gains. Record that finding and promote anyway — there is nothing to roll back to.

This is the mechanism that gives holdout consequences. Holdout is never shown to the proposer, so it functions the way AIDE² (Weco AI) used a private score: the agent optimizes against what it can see, while survival is decided by something it cannot. That asymmetry is what makes reward hacking unprofitable rather than merely discouraged.

## The Completion Gate (blocking)

Runs once, before the final report declares the run successful. All three must hold:

1. **Holdout did not degrade** versus baseline.
2. **Regression suite fully passes.**
3. **The control arm has been run** and its verdict recorded. See `budget-parity.md`.

The control-arm verdict is what the run reports as its outcome:

| Verdict | The run may claim |
|---|---|
| CONFIRMED | The artifact improved at matched budget |
| UNCONFIRMED | Dev improved; the gain is not separable from search budget |
| REFUTED | An equal-budget baseline strategy beats the evolved artifact |
| ENSEMBLE EFFECT | Extra attempts helped; the artifact itself did not improve |

Only CONFIRMED permits describing the run as having improved the artifact. The other three are legitimate outcomes to report, not failures to hide — a REFUTED verdict tells the user something true and useful, namely that they should spend the budget on sampling instead.

## Edge Cases

**First iteration after baseline:** Previous best = baseline. No regression possible. Dimension 3 auto-passes.

**Tie on progress:** PASS only when the mutation simplifies the artifact, lowers soft cost, or delivers another explicitly recorded benefit. Otherwise discard ties to prevent complexity creep.

**L3 results and the iteration gate:** L3 results do not retroactively flip an individual KEEP to DISCARD — the iteration gate operates on L1 and L2 only, and reopening settled per-iteration decisions would stall the loop. L3 results instead feed the two blocking gates above, where they can block promotion, block the success claim, and trigger a rollback of a *span* of iterations. Failing L3 regression cases also join the regression dimension for future iterations.

This is the distinction to keep straight: one mutation is judged on dev and that judgment stands; a run is judged on holdout and that judgment can undo a span of work.

**Multiple consecutive discards:** After K consecutive discards at the same layer (K from evolve_plan.md, default 3), the layer is exhausted. Promote to next layer.

## Logging Gate Decisions

Every gate decision goes to experiments.jsonl:

```json
{
  "gate_details": {
    "structure": true,
    "progress": true,
    "regression": true,
    "cost": true,
    "safety": true,
    "decision": "KEEP",
    "failure_reasons": []
  }
}
```

For DISCARD decisions:

```json
{
  "failure_reasons": [
    "regression: case-03 PASS→FAIL (assertion 'contains: retention' no longer matches)"
  ]
}
```

Every entry also carries the falsifiable prediction made in Phase 2 and whether it held:

```json
{
  "predicted_effect": "case-12 and case-17 flip to PASS; case-03 unaffected",
  "prediction_correct": false
}
```

Set `prediction_correct` from the observed L2 results, independent of the KEEP/DISCARD decision — a mutation can be kept for the wrong reason, and that is exactly what this field is for. Phase 1 reads these to find mutation families where the loop's beliefs are systematically wrong.

`decision` accepts five values: `BASELINE`, `KEEP`, `DISCARD`, `ROLLBACK` (undone by a blocking gate), and `CONTROL` (a control-arm measurement, not a mutation). Only `KEEP` and `BASELINE` participate in best-so-far computation.
