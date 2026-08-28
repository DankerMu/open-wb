# 3-Layer Evaluation Pipeline

## Contents
- Overview
- Measurement Hazards
- Who Runs the Judge
- L1 — Quick Gate (seconds, every iteration)
- L2 — Dev Eval (minutes, every iteration)
- L3 — Strict Eval (conditional)
- LLM Evaluation Noise Mitigation

## Overview

Evaluation is a pipeline of increasing cost and rigor:

| Layer | Cost | Frequency | What It Catches |
|-------|------|-----------|-----------------|
| L1 Quick Gate | Seconds | Every iteration | Structural breakage, safety violations |
| L2 Dev/Scoreboard Eval | Minutes | Every iteration | Behavioral regressions, pass_rate changes, scalar metric changes |
| L3 Strict Eval | ~10 min | Conditional | Overfitting, holdout failures, A/B quality |

Cheap checks run first. L1 fails → skip L2. L2 shows no improvement → don't trigger L3.

---

## Measurement Hazards

These four are not edge cases. Each one silently corrupted a real evolution run of this skill, each produced a number that looked like a finding, and none announced itself. Check for them before trusting any L2 result.

### 1. The candidate leaks

The run reads a *different* version of the artifact than the one under test — usually the copy installed on the machine, discovered through settings, plugins, or a skill registry. Both arms then measure the same thing and every delta is noise.

Symptom: an arm's output references features the version under test does not have.
Guard: isolate the run (`--setting-sources ""`, `--disable-slash-commands`), supply the candidate explicitly, and grep transcripts for paths outside the sandbox.

### 2. The artifact silently fails to load

The candidate is passed by a path that does not resolve at execution time, so the run proceeds against a bare model. Nothing errors; the output looks plausible.

Symptom: cases pass that could not possibly pass without the artifact. In one instance a case scored 2/2 with no artifact loaded at all.
Guard: resolve paths to absolute before any directory change, and refuse to launch on an empty artifact.

### 3. Judging the reply instead of the work

An agent that works through tools leaves almost nothing in its final message. Scoring the transcript alone scores the summary, not the behaviour.

Symptom: the run that did the most work scores lowest. The only run that produced the required file summarized it in 184 characters and scored 0/5, while two runs that produced nothing scored 3/5.
Guard: evaluate assertions against the transcript **plus every file the run created or modified**, excluding untouched fixtures by hash so nothing passes for free.

### 4. Infrastructure failure scored as behaviour

Rate limits, quota exhaustion, timeouts and internal errors often arrive as ordinary output with a success exit code. Scored naively they become zeros.

Symptom: a suite-wide collapse where the surviving score equals exactly the programmatic assertions — every judged assertion "fails" because the judge itself was unavailable. One run came back at 0.24 against a true 0.91 this way; it was an empty wallet, not a regression.
Guard: pattern-match the known failure strings, mark those runs crashed and retry, make an unreachable judge raise rather than return NO, and refuse to publish a pass rate over a partial suite.

**The rule underneath all four: a partial or contaminated measurement is not a smaller measurement, it is a different one.** Report it as incomplete and fix the harness. A number produced under any of these conditions is worse than no number, because it will be compared against numbers that were produced honestly.

`self/run_suite.sh` implements every guard above and is the reference implementation.

---

## Who Runs the Judge

Every LLM-judged assertion and every pairwise verdict MUST run in a subagent, not in the loop's own context.

The subagent receives: the artifact's output, and the assertion criterion or evaluation prompt. It does not receive: the mutation that was just made, the rationale for it, the target case IDs, the counterfactual prediction, or the current pass_rate.

The reason is that Phase 2 and Phase 5 otherwise share a context. The same reasoning that produced "this change should make case-12 pass" then produces the verdict on whether case-12 passes, and it is not possible to tell from the outside whether the verdict was read off the output or off the intention. Apodex-1.0's central structural claim is exactly this: separating verification from continued reasoning is what lets disagreement actually surface, instead of an agent nodding along with itself.

Practically: spawn the judge with the Agent tool, pass it the output file path and the criterion, and have it return only the verdict and a one-line rationale. Cost is one small subagent per judged assertion, and it can be batched — one subagent can judge all assertions for one case.

This applies to judging only. Diagnosis in Phase 1 and Phase 2 reads traces directly; that is the loop's own job and needs full context.

---

## L1 — Quick Gate

Pure programmatic checks. No LLM calls. Target: <5 seconds.

### Checks by Artifact Type

**All types:**
1. Artifact file(s) exist and are non-empty
2. Safety scan: no hardcoded secrets (API keys, passwords, tokens), no dangerous shell commands (recursive force-delete, destructive SQL), no hardcoded absolute paths to system directories

**GT Suite / Hybrid:**
3. Random sample of 3 GT cases — verify each has `id`, `prompt`, and at least 1 assertion

**Scoreboard:**
3. `evolve_plan.md` records metric name, direction, parse rule, run command, timeout, and forbidden scope

**Prompt/Idea/Config:**
4. File is valid text (not binary, not truncated)
5. Character count within reasonable bounds (not empty, not >100k chars without good reason)

**Skill:**
4. SKILL.md has valid YAML frontmatter with `name` and `description`
5. All files referenced in SKILL.md exist

**Code:**
4. Syntax check passes (language-specific: `python -m py_compile`, `node --check`, `go vet`, etc.)
5. No import of removed/renamed modules

Run `scripts/structural_check.py <artifact-path> --type <type>` for the automated checks.

### Decision

- Any critical safety violation → BLOCK (L1 fails, skip L2)
- Structural check fails → BLOCK
- GT Suite / Hybrid GT sample corrupt → BLOCK
- Scoreboard contract missing metric, direction, parse rule, command, timeout, or forbidden scope → BLOCK
- Warnings only → PASS with warnings logged for Phase 2 reference

---

## L2 — Dev / Scoreboard Eval

Run all dev set cases against the current artifact version, or one fixed benchmark run in Scoreboard Mode.

### Execution

For each case or scoreboard run:

1. **Run the artifact** using the execution method:
   - `llm`: Send artifact as system prompt + case prompt as user message. Capture response.
   - `shell`: Run the command with case prompt as input. Capture stdout/stderr.
   - `skill`: Run claude with skill loaded. Capture output.
   - `evaluate`: The artifact IS the output — pass directly to assertions.
   - `scoreboard`: Run the fixed command, capture full output, parse the primary scalar metric.
   - `custom`: Run user-defined command. Capture specified output.
2. **Capture output and trace** — save the full execution log (not just final output) to `traces/iteration-{N}/case-{id}.md`. Include: the input, the execution command, the raw output, timing, and token count.

3. **Evaluate assertions or parse metric**:
   - Programmatic assertion types (`contains`, `regex`, `script`, etc.): use `scripts/evaluate_assertions.py`
   - LLM-judged assertion types (`llm_judge`, `fact_coverage`): prompt an LLM with YES/NO question at temperature 0
   - Scoreboard: parse the primary scalar metric and hard-constraint values from the raw output

4. **Capture cost**: Record wall-clock start/end time, token count, and dollar cost where the execution method reports it. Also record `oracle_runs` — the number of artifact executions this iteration consumed. Save all of it to the L2 results JSON.

   These values do double duty. They feed the Cost gate, which defaults to PASS without them, removing a safety check. They also feed the budget ledger, which sizes the control arm at Phase 8 — an unmetered run cannot be checked for budget parity at all, so its improvements can never be confirmed. See `budget-parity.md`.

5. **Compute result**: GT Suite computes per-case pass_rate (`passed_assertions / total_assertions`); Scoreboard records the parsed scalar metric in the configured direction.

### Aggregation

- Per-case: `{id, passed, total, case_pass_rate, failed_assertions}`
- Aggregate: `dev_pass_rate = sum(all_passed) / sum(all_total)` across all cases
- Regressions: compare per-case results with **previous best** iteration (not previous iteration — discarded iterations are skipped)


For Scoreboard Mode, aggregation is a single result object:

```json
{
  "iteration": 5,
  "metric_name": "val_bpb",
  "metric_direction": "minimize",
  "metric_value": 0.9979,
  "previous_best": 1.0012,
  "hard_constraints_passed": true,
  "cost": {"duration_seconds": 325.9, "peak_vram_mb": 45060.2},
  "trace_path": "traces/iteration-5/run.log"
}
```

### Output

For GT Suite, save to `iterations/iteration-{N}/l2_results.json`:

```json
{
  "iteration": 5,
  "dev_pass_rate": 0.86,
  "tokens": 12400,
  "duration_seconds": 91.3,
  "cases": [
    {
      "id": "case-01",
      "passed": 3,
      "total": 4,
      "pass_rate": 0.75,
      "failed_assertions": [{"type": "contains", "value": "retention", "result": "FAIL"}],
      "trace_path": "traces/iteration-5/case-01.md"
    }
  ],
  "regressions": ["case-03"],
  "new_passes": ["case-12"]
}
```

For Scoreboard Mode, save the scalar result object shown above to the same `l2_results.json` path.

---

## L3 — Strict Eval (GT Suite / Hybrid)

Expensive, high-confidence validation. Conditional trigger for case-based evaluation. Scoreboard Mode uses metric re-runs for noisy near-ties instead of L3 holdouts unless the contract defines a regression suite.

### Trigger Conditions

1. **Periodic**: Every N iterations (default N=5, configurable in evolve_plan.md)
2. **Threshold**: Dev pass_rate exceeds target threshold (default 0.9)
3. **Layer promotion**: Before moving from Layer K to Layer K+1

### What L3 Runs

1. **Holdout eval**: Same process as L2, on holdout set. The optimizer has never seen these results.
   - Holdout pass_rate >15% lower than dev → overfitting warning
   - Holdout below baseline → overfitting confirmed, consider reverting recent iterations

2. **Regression eval**: Run all regression cases. Every one must pass. Failures are added to the regression dimension for future gates.

3. **A/B comparison** (optional): Blind-compare current artifact output vs baseline output on 3-5 randomly selected cases using an independent LLM judge.

### Output

Save to `iterations/iteration-{N}/l3_results.json`:

```json
{
  "holdout_pass_rate": 0.82,
  "dev_pass_rate": 0.86,
  "overfitting_gap": 0.04,
  "regression_pass_rate": 1.0,
  "ab_comparison": {"current_wins": 3, "baseline_wins": 1, "ties": 1}
}
```

---

## LLM Evaluation Noise Mitigation

Same artifact, same GT, same LLM — run 4 times and pass_rates may range 0.79–0.92.

### Strategies

1. **Prefer programmatic assertions**: `contains` and `regex` are deterministic. Use wherever possible.
2. **Judge across model families**: Use at least two judges from *different* model families for any verdict that gates a decision. Same-family judges share failure modes, so three runs of one family agreeing tells you far less than two families agreeing. RHI (arXiv 2607.15524) used `gpt-5.5` at maximum reasoning alongside `opus-4.7`/`4.8` at xhigh, three seeds each.
3. **Repeat the judge, not just the run**: Invoke each judge at least 3 times per case and take the majority. Repeating the *run* while judging once per run does not control this — it charges the judge's coin-flip to the artifact.

   Measured on this skill: the same model, on one fixed transcript, returned 3/4, **4/4**, 3/4, 3/4 across four invocations. One criterion flipped roughly one time in four. Three suite repeats had scored that case identically and it was recorded as a stable defect with SD 0.00 — which was luck, not method, and an entire iteration was planned on top of it. With majority-of-3 the same criterion resolves consistently.

4. **Report spread**: Report mean ± SD across repeats rather than a single number. A mean with no spread hides whether a gain is signal or variance.
5. **Temperature 0**: Always use temperature 0 for LLM-as-judge. Note that it is not sufficient — the flip above was measured with judging already pinned to a single deterministic-looking configuration.
6. **Swap order on any comparison**: For pairwise or A/B judging, judge each pair twice with the candidates in both orders. Disagreement between orders means the judge measured position, not quality — score it a tie.
7. **Cap judge context**: Keep the evaluator prompt within 30–40% of the judge's maximum input length to avoid context rot, and apply identical truncation to both sides of a comparison.
8. **Significance threshold**: Don't count pass_rate changes <2% as meaningful.

The gate's regression check (Dimension 3) is most vulnerable. If exactly 1 case regressed while others improved, run that case 3x before declaring regression.

### Why this matters more than it looks

Wang et al. (Ai2, arXiv 2607.12227) found that iterative revision guided only by an agent's own judgment actively degraded a strong model: GPT-5.4 fell from 75.3 to 69.7 pass@1 under harness evolution without unit-test feedback. Their reading is that self-generated feedback is noisy, and sequential revision on top of noisy feedback compounds early mistakes.

The practical consequence for this skill: a configuration whose oracle is entirely `llm_judge` assertions is the highest-risk configuration it supports, not the most convenient one. Where any real correctness signal exists — a test suite, a compiler, a benchmark, a checkable fact — route the gate through that signal and use LLM judging only for what genuinely requires semantic understanding.
