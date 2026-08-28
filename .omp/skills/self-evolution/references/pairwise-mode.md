# Pairwise Mode — Evolution Without an Absolute Metric

## Contents
- When To Use This Mode
- The Loop
- Why Compare Against the Predecessor
- The Preference History
- The Evaluation Prompt Is Withheld From the Proposer
- Convergence Stopping
- Gate Adaptation
- Judging Protocol
- Known Limits

## When To Use This Mode

Use Pairwise Mode when the artifact produces open-ended output that no assertion set or scalar metric captures honestly: a research report, a code repository, a design document, a proposal. The failure of GT Suite Mode on these artifacts is not that it cannot be made to work — it is that the assertions become the real target, and the artifact converges on satisfying them rather than on being good.

The oracle here is a *relative* judgment: is this version's output preferred to the previous version's output? No absolute score is ever produced.

This mode is adapted from Recursive Harness Self-Improvement (Lee et al., Sakana AI / UC Berkeley, arXiv 2607.15524). Their result: two RHI iterations lifted `sonnet-4.6-high` past `sonnet-4.6-max` on 30 open-ended ML research tasks, winning 20 of 30 pairwise comparisons, and cut inference cost by up to 60% on `opus-4.8`.

The cost argument is what makes it practical. Per iteration:

| Objective | Agent executions | Pairwise evaluations | Cost |
|---|---|---|---|
| Ideal population objective | M | M(M-1)/2 | Θ(M²) |
| Finite-population search | m | m(m-1)/2 | Θ(m²) |
| **Trajectory-local (this mode)** | **1** | **1** | **Θ(1)** |

One execution, one comparison, per task, per iteration. The previous output is cached and reused.

## The Loop

```
Initialize: artifact A⁽⁰⁾, preference history D ← ∅
Run A⁽⁰⁾ on every task, cache outputs y⁽⁰⁾

for i = 1, 2, ...:
    for each task j:
        run A⁽ⁱ⁾ on task j → y_j⁽ⁱ⁾
        evaluator compares y_j⁽ⁱ⁾ against y_j⁽ⁱ⁻¹⁾ under x_eval
        append the preference judgment to D
    s_i = (fraction of tasks where y⁽ⁱ⁾ ≻ y⁽ⁱ⁻¹⁾)
    if s_i < ε: STOP
    A⁽ⁱ⁺¹⁾ = optimizer(A⁽ⁱ⁾, D)        # D, not just the last comparison; x_eval withheld
```

`ε` is the improvement-rate floor, default 0.5. At `s_i = 0.5` the new version wins exactly as often as it loses, which is what a converged random walk looks like.

## Why Compare Against the Predecessor

This mode compares against the **immediately preceding version**, not against the best-so-far. That is a deliberate difference from the skill's other modes, and copying "compare to previous best" into this loop produces something that is not this algorithm.

The reason is the cost table above. Comparing against a best-so-far requires that "best" be meaningful, which requires ranking candidates, which requires a population, which is the Θ(m²) row. The trajectory-local relaxation buys Θ(1) by giving that up. What it gets in exchange is a *noisy local ascent signal*: any revision whose true win probability against its predecessor exceeds ½ has higher latent utility than its predecessor, so following the signal climbs — just noisily.

The consequence to accept: this mode can drift downhill for an iteration or two. It has no ratchet. The preference history is what compensates.

## The Preference History

The proposer receives the **accumulated history of all comparisons so far**, not the most recent one.

This is the load-bearing detail. A single pairwise comparison is one noisy bit. Conditioning each revision on the whole accumulated sequence is what lets the loop converge in a handful of iterations rather than random-walking. Because the artifact space is discrete and textual, these preferences define no gradient; the history functions instead as a momentum-like semantic signal — a record of which directions have been winning.

Store it as `preference_history.jsonl` in the workspace:

```json
{
  "iteration": 3,
  "task_id": "task-07",
  "winner": "current",
  "judge": "gpt-5.5-max-reasoning",
  "seed": 1,
  "order": "current_first",
  "rationale": "Current version's ablation table covers the baseline comparison the previous version omitted."
}
```

One row per (task, judge, seed, order). The proposer reads the file; never summarize it into the prompt.

## The Evaluation Prompt Is Withheld From the Proposer

The evaluation prompt `x_eval` — the criteria the judge applies — goes to the **evaluator only**. The optimizer that rewrites the artifact never sees it.

This is a structural anti-gaming property, and it is free. An optimizer that can read the rubric will write to the rubric. An optimizer that can only read *which outputs won* has to infer what winning requires, and the only reliable way to do that is to actually make the output better.

Record `x_eval` in `evolve_plan.md` under a heading marked withheld, and do not paste it into mutation-proposal context. RHI states this explicitly: `x_eval` is used only by the evaluator when producing pairwise feedback and is not provided to the harness optimizer during revision.

## Convergence Stopping

`s_i < ε → STOP` is the primary stopping condition, and it is a genuinely different one from the other modes, which stop on layer exhaustion, target reached, or iteration cap.

Practical notes:

- Compute `s_i` over tasks, counting ties as losses. A tie is not an improvement.
- With fewer than 8 tasks, `s_i` is too coarse to threshold — require two consecutive iterations below `ε` before stopping.
- RHI's own results plateaued at 2–4 iterations. Expect a short loop. If it is still improving at iteration 10, suspect the judge is drifting rather than the artifact improving, and re-run an early comparison to check.

## Gate Adaptation

The 5-dimension AND gate applies with Dimension 2 (Progress) redefined:

| Dim | Pairwise Mode check |
|---|---|
| Structure | L1 unchanged |
| **Progress** | **Current version wins the pairwise comparison against its predecessor on a majority of tasks, across judges and orders** |
| Regression | Any task where the previous version was preferred by *every* judge and now loses that unanimity is a regression candidate; see below |
| Cost | Unchanged — 2× baseline per-task |
| Safety | L1 safety scan unchanged |

Regression in this mode is weaker than in GT Suite Mode because there is no per-case pass/fail to diff. Treat it as: a task that was unanimously winning and is now unanimously losing counts as a regression. Anything less is noise.

DISCARD reverts to the predecessor, and the discarded comparison still enters the preference history — knowing which revisions lost is signal for the next proposal.

## Judging Protocol

Pairwise judging has failure modes that absolute scoring does not, and the mitigations are cheap:

1. **Order swap is mandatory.** Judge each pair twice, with the candidate presented first and second. A judge that prefers whichever output came first is measuring position, not quality. If the two orders disagree, the comparison is a tie.
2. **At least two judges from different model families.** RHI used `gpt-5.5` at maximum reasoning and `opus-4.7`/`4.8` at xhigh, three seeds each, and reported mean ± SD. Same-family judges share failure modes and will agree for the wrong reasons.
3. **Cap evaluator context at 30–40% of the judge's maximum input length.** Long comparisons degrade under context rot. Extract only the deliverables named by the task rather than dumping everything the artifact produced.
4. **Apply identical truncation to both candidates.** Truncating one side more than the other is a thumb on the scale, and it is easy to do accidentally when one output is longer.
5. **The judge runs in a subagent** that sees the two outputs and `x_eval`, and does not see the mutation rationale. See `evaluation.md`.

## Known Limits

RHI's own component analysis is correlational, not causal, and the paper says so. It reports that inter-agent contracts stabilize earliest and cluster most clearly by task, while roles change slowest — but also notes the harness optimizer's system prompt explicitly emphasized contracts and hops, which plausibly explains part of that prominence. Treat the ordering in `mutation.md` for harness artifacts as a well-supported hypothesis, not a measured law.

Two further limits worth stating before choosing this mode:

- RHI complements rather than replaces a stronger base model. On the weaker `sonnet-4.6` base it did not close the gap to `opus-4.7` baselines.
- The mode inherits everything wrong with the judge. There is no external correctness signal anywhere in the loop. Wang et al. found that iterative revision guided only by the agent's own judgment actively hurt a strong model — GPT-5.4 fell from 75.3 to 69.7. If a real correctness signal exists for the artifact, use GT Suite or Scoreboard Mode instead. Choose Pairwise Mode because no such signal exists, never because it is less work to set up.
