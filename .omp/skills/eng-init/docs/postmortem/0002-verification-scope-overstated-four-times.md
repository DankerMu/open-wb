# Post-mortem 0002: Verification scope overstated eleven times, the last four inside the record

Status: resolved per instance (`373f623`, `6fa611a`, `86f2f97`, `8c400e8`, and this change); the class is open

## Executive summary

Across one working session the same error was made four times, each at a higher level of abstraction: a verification claim was recorded as covering more than the thing that was actually checked. The specific claims differed — "the program exists" for "the program is proven", "the check is proven" for "the capability is delivered", a new guard shipped without its own rejection sample, "every failable branch" for "every branch matching one regex in four files". None was caught by re-reading the code or the report. Three were caught by an outside party or by running a counterexample; the fourth by a tool built after the third.

## Impact

Four incorrect statements were committed or about to be:

1. Three checks recorded as mechanically enforced (L3) when nothing proved they reject anything.
2. A capability recorded as delivered when the check covered a narrow slice of it — an Enforcement Index listing `gitleaks`, `jscpd`, `knip` at block level with no config file anywhere still passes.
3. A crash fix shipped with a new guard that had no test.
4. A "0 of 100 failable branches survive" claim whose denominator silently excluded a checker that does reject.

All four were corrected before they became load-bearing. The boundary: no target repository was audited against the inflated claims, and no eng-init release carried them into a user's repo.

## Timeline

- Audit draft rates `check_enforcement_index`, matrix target resolution, and the registry cross-reference as L3 on the strength of the program existing. Independent review overturns all three; `grep` confirms every test-directory hit for those names sits in a docstring.
- Tests are added, the three are re-rated L3, and the audit's summary is updated to "L3: 3 → 8".
- Self-review builds a counterexample instead of re-reading: three block-level tools with no config pass. The check proves "path-shaped config references exist", not the advertised capability. Count corrected to 7; the gap pinned as a test that fails if someone closes it.
- A crash in `score_readiness_report` is fixed with a new type guard. The next mutation sweep lists that guard as an untested invariant.
- The sweep reports 100/100. The advisor observes that `check_skill_content.py` rejects but is outside the inventory's four call shapes, so its sites were missing from the denominator rather than absent from the code.

## Root cause

Every instance has the same shape: **the boundary of what was verified was described using the vocabulary of what was wanted.** "Enforcement Index is checked" and "path-shaped tokens in the Enforcement Index are checked" are different propositions, and the first is the one that gets written down, because it is the reason the check was built.

**Why existing defenses missed it.** The skill already carries the rule that would have caught every instance — `references/gate-quality-contract.md` § Self-proof says a gate is qualified only when a synthetic illegal input proves it rejects. The rule was written two days before instance 1, by the same author who then broke it. Reading it does not help: at the moment of writing the claim, the claim feels like a description of the mechanism just built, and re-reading confirms the mechanism exists. Self-review shares the blind spot, because the same conflation that produced the claim is used to check it. The only two things that worked were an outside reader and an executed counterexample — both of which supply a boundary the author did not choose.

## Guardrails added

- **Mechanical:** `scripts/mutation_sweep.py` — neuters every failable branch and reports the ones nothing catches. This converts "is this rule proven?" from a judgment into a command, and it caught instance 3 unprompted.
- **Mechanical:** `scripts/tests/test_untested_invariants.py` — 34 test functions producing 60 cases, driving the sweep's survivor count to zero across three passes (second sweep 28 survivors, third 3, fourth 0). Each cluster carries an acceptance case so a rejection-only test cannot pass for a check that fails on everything.
- **Mechanical:** `test_enforcement_index_does_not_yet_catch_prose_tool_names` pins instance 2's surviving gap: it asserts today's behaviour and fails if the gap is ever closed, forcing a deliberate update.
- **Prose:** the scope bound of the sweep is stated inside `scripts/mutation_sweep.py` — "every fail/append/require/fail_if site in these four files", never "every rejection eng-init can perform".
- **Policy:** `not applicable` — no change to what evidence a change must produce; the existing self-proof contract was already correct and was the thing being violated.

## Instance 11 — a truncated `ps` sent a destructive command at a live process

While checking whether two background jobs had finished, the process check was
`ps aux | grep -E "omp|mutation_sweep" | grep -v grep | head`. The mutation sweep's two
pids *were* in that output, sitting at 0.0% CPU below the ten-line cutoff `head` imposes.
The truncated view showed no sweep, so the sweep was declared dead — and the modified file
it had left in the working tree was read as crash residue rather than as a live mutation.
`git checkout --` was then run on a file a running process was mid-way through editing.

Two false results followed from the one bad observation. The 58 pytest failures reported
next came from running the suite against a half-mutated tree, and the sweep's verdicts for
that file were corrupted by the checkout landing mid-site. Both were presented as findings
before being recognised as artifacts of the interference.

This is instance 3's mechanism (`| tail -45` truncating the evidence a claim rested on)
promoted from a wrong number to a destructive action. The difference matters: a truncated
count produces a claim someone can later check, while a truncated process list produces a
command that changes the world before anyone checks.

The rule, which the skill already states for validation commands and had not extended to
observation: **evidence that gates an irreversible action is read unpiped.** `head`, `tail`,
`grep`, and `-q` all answer a narrower question than the one being asked, and the gap
between the two questions is invisible in the output. Widening after a surprising result is
too late when the action has already run.

## Lessons

- A rule you wrote does not protect you from breaking it. Instance 1 violated a contract authored 48 hours earlier by the same hand.
- Self-review cannot find a conflation, because the conflation is the instrument doing the reviewing. Budget for an outside reader or an executed counterexample on any claim about coverage.
- The cheapest reliable test of "what does this check actually cover?" is to feed it something it should reject and watch. Reading the implementation answers a different question.
- A fix's new guard is a new rule and inherits the rule's obligations. Adding it without a rejection sample makes it the class of defect it was written to prevent.
- State the denominator of every coverage number, or the number reads as exhaustive.

## Instance 5, found while reviewing this postmortem

Two claims in the first draft of this file were not supported when written.

**"45 survivors" was unverifiable.** The first sweep's output was captured with
`| tail -45`, so the saved file holds the last forty-five lines of a longer list,
not the whole list. The initial survivor count is unknown and at least 45. What is
verifiable: the second sweep reported 28 survivors from a complete log, the third
reported 3, the fourth 0. The headline number in commit `86f2f97` — "First sweep:
45 of 99 branches survived" — carries the same defect and cannot be edited out of
history; it is corrected here instead.

**"Red-green verified" was written before the verification.** Postmortem 0001
claimed the cache-purge guardrail had been proven by restoring the collision
conditions. At the time of writing, only the bug had been demonstrated; the fix
had not been tested against it. The claim has since been discharged — the
collision was reproduced with `os.utime` forcing identical size *and* mtime, and
`selfcheck` went red on the broken source — but it was an assertion ahead of its
evidence when committed.

Both are the same class as instances 1–4, at the point of writing the record that
documents the class. The instrument does not stop being the instrument because it
is pointed at itself. The practical rule this yields: a verification claim and the
command that discharges it belong in the same action, not the same paragraph.


## Instances 6–9, found by the code review and the closing check

The class kept producing after the record was written.

**6 — a compensating control that existed only in a docstring.** `check_canonicality_first`
tolerates an absent Code Canonicality section on purpose, and its docstring said presence
was demanded by `--require-section "Code Canonicality"`, "which the Stage 5 command passes".
No caller passed it. A rendered AGENTS.md missing the skill's own P0 section went green
under the documented validation contract. Fixed by wiring the flag and pinning both halves.

**7 — a tightened regex that did not tighten.** The `pull_request_target` invariant was
re-stated as "asserts direction"; it required only a negation *near* the token, so
"pull_request_target is never a risk" passed while inverting a secret-leak rule. The
four-probe proof also lived in a throwaway script rather than the suite.

**8 — a transcribed list that had already drifted.** The exit-2 conformance test named four
gate scripts by hand; `check_skill_content.py` honoured the contract and was missing from
the list. Now derived from disk.

**9 — a documentation fix that silently did not apply.** Commit `0c9714d` reported that the
audit's appendix B had been updated to record which suggestions shipped. The replacement
targeted "仍未动**的**" while the file said "仍未动"; `str.replace` returns the input
unchanged when the anchor is absent, so nothing happened and nothing said so. The commit
message asserted the edit; the file disproved it. Found by a closing check that compared
each documented claim against the file rather than against the commit log.

The mechanical lesson from 9, distinct from the earlier ones: **a string replacement without
an assertion is a silent no-op, and a silent no-op inside a "fix" commit produces a false
claim with no failing signal anywhere.** Every anchored edit in this session's tooling now
asserts its anchor first.

The broader one: instances 1–5 were caught by an outside reader or an executed
counterexample. 6–8 were caught by an independent code review. 9 was caught by a script that
re-read each claim and compared it to the artifact. Nothing in this list was caught by
re-reading the diff or trusting the commit message — including the commit messages written
specifically to document this class.


## Instance 10 — the fix for instance 6 over-corrected

Wiring `--require-section "Code Canonicality"` into the validation contract closed the
phantom pairing, and made the contract demand a section eng-init does not always own. In
repair mode on a hand-written AGENTS.md — a repo eng-init never initialised, being repaired
for one signal — Stage 5 now failed with "missing required section: Code Canonicality",
which forces either an unrequested rewrite of someone else's file or a false failure report.
It contradicts three of SKILL.md's own rules at once: repair is not an Initialize grill,
user-owned sections are preserved, and a targeted request is honoured rather than escalated.

Verified by construction before the fix and after: a hand-written AGENTS.md with no such
section now passes the repair-mode command, while a *demoted* Code Canonicality is still
rejected by the order check, which never depended on the flag.

The pattern worth naming: **a correction aimed at "this rule is not enforced" lands naturally
on "enforce it everywhere", and everywhere is usually wider than the rule's owner.** Scope
the enforcement to the pipeline that owns the artifact, or the fix for phantom enforcement
becomes over-enforcement — which is the same defect measured from the other side.
