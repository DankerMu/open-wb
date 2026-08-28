# Budget Parity and the Control Arm

## Contents
- Why This Exists
- The Budget Ledger
- The Control Arm Protocol
- pass@1 vs pass@k
- Verdict Rules
- Affordability and Honest Truncation

## Why This Exists

Evolution is itself a search procedure. Every iteration spends oracle runs. If the loop reports "pass_rate 0.62 → 0.81" without saying how much search that cost, the number cannot distinguish two very different outcomes:

1. The artifact genuinely got better — a single run of it now succeeds where it used to fail.
2. The loop just spent 20× the budget searching, and any equal-budget strategy would have done as well or better.

This is not hypothetical. Wang et al. (Ai2, arXiv 2607.12227) evaluated harness evolution against test-time scaling on Terminal-Bench 2.1 under a matched compute budget of K=5, averaged over Claude Opus 4.6, GPT-5.4, and GPT-5.4 mini:

| Method | avg pass@1 (no unit tests) |
|---|---|
| Direct sampling, initial harness | 68.2 |
| Parallel sampling | **72.3** |
| Harness scaling | 71.8 |
| Sequential refinement | 69.3 |
| **Harness evolution** | **67.4** |

Evolution scored *below* the untouched baseline, and every simpler budget-matched strategy beat it. With unit-test feedback the ordering held: harness evolution reached 75.8 pass@1 against parallel sampling's 86.0.

On a disjoint split (45 train / 10 validation / 34 held-out test), the evolved harness gained 0.6 points on held-out tasks (68.3 vs 67.7). The authors' reading: the revisions encoded task-specific shortcuts rather than better design.

Their diagnostic sentence is the one to internalize: if harness revision genuinely produced a better harness, the improvement should show up in pass@1. If it only shows up in pass@k, what was bought was extra attempts, not a better artifact.

A loop that cannot run this comparison cannot honestly claim success. That is why the control arm is mandatory before declaring a run successful, not optional.

## The Budget Ledger

**Unit of account: the oracle run.** One oracle run is one execution of the artifact that produces something the oracle scores.

| Mode | One oracle run is |
|---|---|
| GT Suite / Hybrid | One case executed against the artifact |
| Scoreboard | One full benchmark command invocation |
| Pairwise | One artifact execution producing one output for comparison |

Record per iteration, in `results.tsv` and `experiments.jsonl`:

- `oracle_runs` — count for this iteration
- `tokens` — total tokens consumed
- `duration_s` — wall clock
- `cost_usd` — if the execution method reports it; `0` if unmetered

Cumulative totals come from summing the ledger:

```bash
scripts/results_tracker.py <workspace> budget
```

Record the ceiling in the contract as `total_budget`. When cumulative spend reaches it, Phase 8 stops the loop regardless of progress. AIDE² (Weco AI) framed its whole optimization as maximizing a private score *under a fixed dollar budget per evaluation*, precisely so the outer loop could not buy improvement with best-of-N as N grows. Without a ceiling, a loop drifts toward spending rather than thinking.

## The Control Arm Protocol

Run the control arm on **the same case set the success claim is made on**. If the final report claims a holdout number, the control arm runs on holdout. If it claims a dev number, it runs on dev. Report both if both are claimed.

Let `K = ceil(cumulative_oracle_runs / |set|)` — the number of attempts per case that the evolution run's total budget would have bought.

Both control arms use the **baseline artifact**, exactly as it was at iteration 0. Never the evolved one.

### Arm A — Parallel sampling

For each case, draw K independent outputs from the baseline artifact. These are independent samples, not refinements — no output sees another.

- **pass@1**: the mean score across the K samples. This is the unbiased estimate of drawing one output at random — the number a user should expect from a single run. Do **not** use a self-judge to pick the best candidate from the K: that measures the selector as much as the artifact and flatters the arm. (`self/control_summary.py` reports pass@1 in two units — the case-level mean of per-sample pass rates and the pooled assertion rate — and takes its verdict from the assertion-level one, the unit `dev_pass_rate` is defined in; if a judge-based pass@1 is ever added, it must be reported separately, never as the headline number.)
- **pass@K**: score all K; the case passes if any output passes. This requires oracle selection and is therefore an upper bound, not a deployable number.

### Arm B — Sequential refinement

For each case, produce K outputs from the baseline artifact in sequence. Attempt *k* sees attempt *k-1*'s output, plus its assertion results when the oracle exposes them. Score the final output as pass@1; score "any attempt passed" as pass@K.

Arm B is the closer analogue to evolution, since both consume feedback iteratively. The difference is that Arm B revises the *output* while evolution revises the *artifact*.

### Recording

Log control-arm results to the ledger with `--decision CONTROL`. They enter `results.tsv` for auditability but are excluded from best-kept computation and from KEEP/DISCARD accounting.

## pass@1 vs pass@k

Report both for the evolved artifact and both control arms, in the units
`control_summary.py` prints (pass@1 in both the case-level and the
assertion-level unit; pass@K only for the baseline arms, which have K
samples):

```
                          pass@1      pass@1      pass@K*   full-marks
                          (case)      (assertion)           (single run)
evolved artifact           0.81        0.80        —         0.70
baseline, parallel         0.79        0.77        0.92      —
baseline, sequential       0.76        0.74        0.90      —
```

* pass@K = any of the K samples scored full marks (protocol; the evolved
artifact ran once per repeat, so it has no pass@K — its full-marks rate is a
single-run number, never an any-of-K bound).

Reading the example: the evolved artifact wins pass@1 by 0.02 on both units
and loses pass@K. That is the honest shape of a real but modest gain. The
reverse shape — losing pass@1 and winning pass@K — means the evolution bought
attempts, not quality.

## Verdict Rules

Compute at Phase 8, before writing the final report:

| Condition | Verdict |
|---|---|
| `evolved pass@1 > max(control pass@1)` | **CONFIRMED** — the artifact is genuinely better at matched budget |
| `evolved pass@1` within noise of best control pass@1 | **UNCONFIRMED** — gain is indistinguishable from spending the budget on sampling |
| `evolved pass@1 < max(control pass@1)` | **REFUTED** — an equal-budget baseline strategy beats the evolved artifact |
| `evolved pass@1` flat but `pass@K` up | **ENSEMBLE EFFECT** — not an artifact improvement; report as such |

"Within noise" uses the same significance threshold as the gate (default 2%).

The verdict goes in the final report verbatim. A REFUTED or UNCONFIRMED verdict does not mean the iterations were wasted — the traces and the failure analysis retain value — but the run must not be described as having improved the artifact. Recommend the winning control strategy instead.

## Before Trusting a Verdict

Three checks, each measured on this skill's own control arm (2026-08-03 audit). None flipped that verdict — the biases ran *against* the evolved side — but a verdict is only as strong as its weakest unexamined assumption.

1. **One version of the criteria for both arms.** The judge criteria come from `self/gt.json` at the moment each side is scored. If the GT was edited between the evolved run and the control arm, the two arms answer different questions. `control_summary.py` records the GT hash; compare it with the hash the evolved run was judged against. If they differ, re-judge the cheaper side or report the verdict as qualified.
2. **Tautology: cases the baseline cannot pass by construction.** A criterion that tests a mechanism added mid-evolution (a reporting format, a ledger file, a gate rule) scores the baseline zero *by definition*, and its delta is the evolved side grading its own addition. State which cases are definitionally impossible for the baseline and the delta with them excluded. Measured (2026-08-03 audit, recomputed from raw judge files): excluding case-06 (all 4 criteria), case-11, case-10's `predictions.jsonl` and case-07's `REFUTED` criteria shrank the strongest claim (evolved single-shot vs baseline pass@K, binary full-marks rate on both sides) from +0.222 to +0.026 — still above the 2% gate, but marginally. The pass@1 claim survives both units and both sets (+0.250 assertion / +0.273 case, full; +0.093 / +0.146 excluded). A continuous best-of-K mean, or a score subtracted from a full-marks rate, is a different metric (assertion-level excluded: −0.003) — the binary-vs-binary comparison is the protocol and what `control_summary.py` implements.
3. **One metric definition on both sides.** Compare like units: an assertion-level evolved `dev_pass_rate` against a case-level control pass@1 mixes quantities. `control_summary.py` reports both units and takes its verdict from the assertion-level column (the unit `dev_pass_rate` is defined in), with the case-level delta as a sensitivity check; a verdict that flips between the two units is not clean.

## Affordability and Honest Truncation

A full control arm costs roughly as much as the evolution run that preceded it. That is the correct price of the claim, but it is not always affordable.

Permitted reductions, in order of preference:

1. **Sample the case set.** Run the control arm on a stratified sample of at least 5 cases covering every tag and difficulty. Report the sample size and the sampling rule.
2. **Cap K.** Use `K_control = min(K, 5)`. This biases *against* the control arm, so a CONFIRMED verdict under a capped K is still sound, while a REFUTED verdict becomes stronger. An UNCONFIRMED verdict under a capped K should be reported as inconclusive rather than favorable.
3. **Arm A only.** Parallel sampling was the strongest baseline in the Ai2 results, so dropping Arm B loses the least.

Every reduction must be stated in the final report with its parameters. Silent truncation turns "we checked" into a false claim — a control arm nobody can size is worse than no control arm, because it looks like evidence.

## Interaction With Other Mechanisms

Any mechanism that adds search — archive/fork lineages, parallel mutation proposals, extra retries — spends budget and must be counted in the same ledger. This is the exact confound Ai2 identified. A loop may absolutely use those mechanisms; it may not use them and then compare against a control arm sized as if it had not.
