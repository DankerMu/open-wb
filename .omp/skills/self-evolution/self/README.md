# Running This Skill On Itself

This directory holds everything needed to point `self-evolution` at `self-evolution`. It is the recursive case, and it has a hazard the ordinary case does not.

## The Hazard, First

When you evolve a prompt, the thing being changed and the thing doing the changing are separate. Here they are the same file. Three specific ways that goes wrong:

1. **The controller mutates underneath itself.** Edit `SKILL.md` at iteration 5 and iteration 6 runs under the edited rules. A mutation that weakens the gate makes every later mutation easier to keep, and the ledger records steady progress the whole way down.
2. **The loop can edit its own oracle.** The oracle here is a GT suite about the skill's behavior, stored in this repo, editable by the same agent. That is the exact configuration `SKILL.md` names as fatal in Scoreboard Mode.
3. **Self-assessment is not evidence.** The skill judging whether it followed its own rules is the failure mode `evaluation.md` warns about, applied to itself.

## The Mitigations, Which Are Not Optional

**Pin the controller.** The agent running the loop loads the skill from a frozen tag, never from the working copy:

```bash
cd /Users/chenwenjie/.agents
git tag -l 'self-evolution-*'                       # pick a candidate pin
git worktree add /tmp/se-controller <chosen-tag>
```

The controller reads `/tmp/se-controller/skills/self-evolution/SKILL.md` and drives evaluation with that worktree's `self/run_suite.sh`. The candidate under mutation is the working copy. They diverge, and that is the point — a candidate that breaks the loop cannot hide it by also breaking the loop that would catch it.

**Check the pin before trusting it.** A tag is only usable as a controller if it actually contains a runner, and older tags do not:

```bash
C=/tmp/se-controller/skills/self-evolution
[ -f "$C/self/run_suite.sh" ] && [ -f "$C/self/judge.py" ] \
  && echo "usable controller" || echo "pin too old — no runner, choose a newer tag"
```

Both failure modes were hit while writing this: `self-evolution-v1.0.0` has no `self/` directory at all, and `self-evolution-v1.1.1` predates the runner commit. Do not assume the newest tag is fine — run the check.

Re-pin only after a candidate passes the completion gate, and record the new pin in `evolve_plan.md`. Never re-pin mid-run: the controller changing underneath a run is the exact failure the pin exists to prevent.

**Freeze the oracle.** `self/gt.json` and everything under `self/` is forbidden scope. Declare it and let L1 check it rather than trusting it:

```bash
scripts/structural_check.py . --type skill \
  --exclude scripts/structural_check.py \
  --forbidden skills/self-evolution/self \
  --diff-base HEAD~1
```

The `--exclude` is a genuine false positive, not a waiver: the safety scanner matches its own `DANGEROUS_PATTERNS` table when it scans the file that defines it. Excluding any other file is cheating.

**Judge from outside.** Every `llm_judge` assertion runs in a subagent per `evaluation.md`, and here that subagent must not be told it is judging the skill that spawned it. Give it the transcript and the criterion; nothing else.

## Setup

```bash
cd /Users/chenwenjie/.agents/skills/self-evolution
scripts/results_tracker.py ../self-evolution-evolution init --mode gt
cp self/gt.json ../self-evolution-evolution/gt/
```

Split `gt.json` into `dev.json` / `holdout.json` / `regression.json` per `references/ground-truth.md`. Holdout stays out of every mutation prompt.

## Running the Suite

```bash
./self/run_suite.sh <pinned-skill-dir> <out-dir> [concurrency] [model]
```

That is the whole L2 evaluation. It materializes fixtures per case, runs each against the pinned skill, retries crashes once, judges blind, and writes `<out-dir>/l2_results.json` in the format `references/evaluation.md` specifies. The pieces are `run_case.sh`, `judge.py`, and `aggregate.py`, each runnable alone when you are debugging one case.

`setup_case.sh` remains for hand-driving a single case interactively; it prints a prepared directory and nothing else.

### Four things the runner does that are not optional

Each of these exists because its absence silently corrupted a real measurement.

**Isolation.** Every run passes `--setting-sources "" --disable-slash-commands`. Without it the run discovers the skill installed on this machine and reads *that* instead of the pinned copy. A pilot comparison opened with "that copy is a stale version missing Pairwise Mode" — the older arm had gone and read the newer skill, so both arms were measuring the same thing.

**Absolute skill path.** The pinned SKILL.md is read after `cd` into the run directory. A relative path resolves to nothing there, the system prompt comes out empty, and the run measures a bare model while looking completely normal. `run_case.sh` resolves the path first and refuses an empty system prompt.

**Judging the artifacts, not just the transcript.** An agent working through tools leaves almost nothing in its reply. The one run that actually produced `predictions.jsonl` summarized it in 184 characters and scored 0/5, while two runs that produced nothing scored 3/5. `judge.py` scores against the transcript plus every file the run created or modified, with untouched fixtures excluded by hash so nothing passes for free.

**Infrastructure failure is not a low score.** `claude` reports quota exhaustion as ordinary prose and internal failures as `Execution error` with exit 0. Scored naively, a rate-limited suite comes back at 0.24 — exactly the programmatic assertions passing and every judged one "failing" — which is indistinguishable from a catastrophic regression and is nothing but an empty wallet. Runs matching those patterns are marked crashed and retried; a judge that cannot be reached raises rather than returning NO; and `aggregate.py` emits `dev_pass_rate: null` and exits 4 rather than publishing a number computed over a partial suite.

That last one is the general rule worth carrying: **a partial measurement is not a smaller measurement, it is a different one.**

`self/fixtures/demo-evolution/` is a complete workspace whose ledger sums to 204 oracle runs against a declared ceiling of 200 — which is the situation case-15 asks about. Verify it drives the real tooling:

```bash
scripts/results_tracker.py self/fixtures/demo-evolution budget --total-oracle-runs 200 --set-size 10
```

The fixtures are deliberately imperfect. `pipeline/` passes full conversation history at every hop, which is the contract-leakage failure case-11 should notice. `demo-evolution/traces/iteration-6/case-05.md` shows a case failing for a reason the ledger's prediction did not anticipate.

## Contract

Copy into `self-evolution-evolution/evolve_plan.md` and fill the blanks:

```
artifact:              skills/self-evolution/
artifact_type:         skill
mode:                  gt
editable_scope:        skills/self-evolution/SKILL.md, skills/self-evolution/references/
forbidden_scope:       skills/self-evolution/self/, skills/self-evolution/scripts/
controller_pin:        self-evolution-v1.0.0
run_command:           claude -p "{prompt}" --allowedTools '*'
execution_model_tier:  <the model that will run the cases>
total_budget:          <oracle runs — one run is one case executed once>
timeout_seconds:       600
keep_rule:             dev pass_rate improves, or ties with a deletion or cost win
discard_rule:          crash, regression, worse pass_rate, scope violation, safety failure
```

`scripts/` is forbidden because the scripts are the measurement apparatus. Change them deliberately, outside a run, with the loop stopped.

## Applicability Check

Run this before starting, honestly, per the prerequisite in `SKILL.md`:

- **Headroom?** Run the baseline. If `gt.json` already passes near-fully, there is nothing to evolve and the run will produce a ledger of KEEP decisions and no improvement.
- **Does performance depend on the artifact?** For a skill that is entirely instructions, yes — but only for behaviors an instruction can actually change. Cases that fail because the executing model cannot follow a multi-step contract will not be fixed by rewording the contract.

## What The Cases Test

`gt.json` targets contract adherence, because that is what an instruction artifact can be held to. Each case runs a scenario and checks what the loop produced — the plan file, the ledger, the report — not what it said about itself.

The cases cluster into four groups:

| Group | Asks |
|---|---|
| Refusal | Does it decline to start when the prerequisites fail? |
| Contract | Does the written plan carry the required fields? |
| Honesty | Does the final report carry a control-arm verdict, and lead with it? |
| Mode choice | Does it pick the right mode, and refuse the risky one when a real signal exists? |

The Refusal group matters most and is easiest to regress. A skill that starts every run looks more capable and is worse.

## Stopping

Beyond the usual conditions, stop immediately if:

- A mutation touches forbidden scope. That is not a failed experiment, it is a broken run — reset and investigate before continuing.
- Dev improves while holdout does not, twice at the same layer. The candidate is learning `gt.json`, not getting better.
- The completion gate returns REFUTED. Report it and stop. The honest outcome of a self-evolution run can be that the v1.0.0 skill was already better.
