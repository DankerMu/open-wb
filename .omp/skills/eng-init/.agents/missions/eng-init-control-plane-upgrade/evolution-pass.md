# eng-init control-plane upgrade — bounded self-evolution pass

Date: 2026-07-02
Artifact: `/Users/chenwenjie/.agents/skills/eng-init`
Editable scope used: `SKILL.md`, `references/readiness-fix-recipes.md`, this mission log.
Oracle: `eng-init-control-plane-upgrade.spec.md` AC-001–AC-012 plus regression cases 28–32 in `evals/cases.md`.
Iteration budget: at most 2 atomic mutations. Project-wide commands were not run.

## Baseline evaluation

File-inspection baseline against the spec showed the upgraded bundle already satisfied the core architecture acceptance criteria:

| AC | Baseline result | Evidence |
|---|---:|---|
| AC-001 | PASS | `SKILL.md:10-14` names the repo-local agent control plane and says `AGENTS.md` is an interface/artifact, not the entire goal. |
| AC-002 | PASS | `SKILL.md:28-37` defines Mode Router rows for Audit, Initialize, Repair, and Refactor Harness. |
| AC-003 | PASS | `SKILL.md:14` states `AGENTS.md` is not the entire goal. |
| AC-004 | PASS | `SKILL.md:43-51` covers existing-report, no-report, requested-signal, no-signal, and all-passing repair variants. |
| AC-005 | PASS | `SKILL.md:55` requires semantic matching, substantive fix, validator, and rescore evidence. |
| AC-006 | PASS | `references/agent-readiness-criteria.md:85-96` and `references/readiness-fix-recipes.md:15-22` define fixability classes, including Class D external/governance non-completion rules. |
| AC-007 | PASS | `references/agent-readiness-criteria.md:34-45` and `120-135` require application discovery and stable denominators before scoring. |
| AC-008 | PASS | `references/agent-readiness-criteria.md:21` and `40-42` keep configured-but-not-blocking criteria at half/partial credit. |
| AC-009 | PASS | `SKILL.md:253`, `references/agent-readiness-criteria.md:47`, and `references/readiness-fix-recipes.md:7-13` reject metric-gaming fixes. |
| AC-010 | PASS | `SKILL.md:106-110`, `217`, and anti-patterns preserve source-of-truth, compare/oracle, anti-cheat, and work-unit ownership behavior. |
| AC-011 | PASS | `evals/cases.md` still contains cases 01–27; none were deleted during this pass. |
| AC-012 | PASS | `evals/cases.md:330-387` contains cases 28–32 covering signal repair, no-report repair, all-passing noop, denominator stability, and metric-gaming rejection. |

A focused post-mutation file-inspection check reported 14/14 PASS for AC-001–AC-012 plus two targeted case-support checks:

```text
AC-001 control plane purpose: PASS
AC-002 mode router four pipelines: PASS
AC-003 AGENTS interface not goal: PASS
AC-004 repair variants: PASS
AC-005 validation and rescore: PASS
AC-006 fixability external fake prevention: PASS
AC-007 denominator rules: PASS
AC-008 half credit: PASS
AC-009 metric gaming forbidden: PASS
AC-010 refactor overlay preserved: PASS
AC-011 existing evals not deleted: PASS
AC-012 cases 28-32 present: PASS
case-28 targeted no grill support: PASS
case-32 unit test anti-gaming recipe: PASS
summary 14 / 14
```

## Weaknesses and overfit risks identified

1. **Repair could accidentally re-enter Initialize grilling.** Cases 28–30 require targeted repair behavior, but baseline text did not explicitly say that a targeted repair must not ask Q1.4 or unrelated Initialize questions. Because Stage 2 elsewhere says Q1.4 is mandatory in every grilling run, an agent could over-apply Initialize rules to Repair mode.

2. **`unit_tests_exist` had eval coverage but no direct recipe.** Case 32 asserts behavior for `unit_tests_exist`, while the recipe file had `unit_tests_runnable` but no explicit `unit_tests_exist` recipe. That left a gap where an agent might know how to wire a test command but not when a new test itself counts as substantive versus metric gaming.

3. **Manual/prose rescore remains the current ceiling.** The bundle requires rescore evidence, but no deterministic scoring script was introduced by this upgrade. That is allowed by the spec's first-iteration scope, but it remains an overfit risk: agents may produce plausible prose deltas instead of exact criterion recalculation unless future work adds a registry/scorer.

4. **Markdown criteria registry can drift from recipes.** `agent-readiness-criteria.md` is the source of truth for criteria, while `readiness-fix-recipes.md` is a separate partial recipe registry. Without a generated or checked index, a criterion can be covered by evals but lack a corresponding recipe, as seen with `unit_tests_exist`.

5. **Report freshness/all-passing nuance is transcript-dependent.** Case 30 is covered by high-level instructions, but real runs still depend on an agent correctly judging report freshness and validator timestamps. The current prompt tells it to optionally recommend an audit freshness check, but does not define a timestamp staleness threshold.

## Mutations attempted

### Mutation 1 — Keep

- **Target weakness:** Repair could accidentally re-enter Initialize grilling.
- **Atomic change:** Added one Repair pipeline bullet in `SKILL.md` clarifying that Repair mode is not an Initialize grill and must not ask Q1.4 or unrelated Initialize questions for targeted repairs unless escalation is required.
- **Changed evidence:** `SKILL.md:53` now states: `Repair mode is not an Initialize grill. Do not ask Q1.4 or unrelated Initialize questions for a targeted repair unless the repair must escalate into Initialize; use the report, requested signal, and local scan evidence as the scope.`
- **Gate decision:** KEEP.
- **Rationale:** Improves enforcement for cases 28–30 without bloating `SKILL.md`; it resolves an ambiguity created by the global strictness-profile grilling rule while preserving Initialize behavior.
- **Regression risk:** Low. It only scopes targeted Repair mode and explicitly allows escalation into Initialize when needed.

### Mutation 2 — Keep

- **Target weakness:** `unit_tests_exist` had eval coverage but no direct recipe.
- **Atomic change:** Added a concise `unit_tests_exist` recipe to `references/readiness-fix-recipes.md`.
- **Changed evidence:** `references/readiness-fix-recipes.md:108-116` now defines fixability, good fixes, bad fixes, scan requirements, allowed files, validator, and rescore evidence for `unit_tests_exist`.
- **Gate decision:** KEEP.
- **Rationale:** Directly supports case 32 by distinguishing meaningful behavior tests from empty/tautological metric-gaming tests, and records when to leave the signal failing/product-specific pending.
- **Regression risk:** Low. The recipe aligns with existing universal repair rules and the neighboring `unit_tests_runnable` recipe; it does not weaken existing tests or permit placeholders.

No mutations were discarded. No third mutation was attempted because the remaining weaknesses are broader future-work items that would exceed this bounded pass or require a deterministic scoring registry outside the assigned scope.

## Final rationale

The upgraded prompt bundle already met the main spec acceptance criteria by inspection. Two small clarity/enforcement gaps were worth fixing because they mapped directly to regression cases 28–32 and could cause agent behavior regressions despite the broad architecture being present. Both kept mutations are narrow, evidence-grounded, and do not change the skill name, weaken evals, copy Droid prompts wholesale, migrate the registry to YAML/JSON, or run project-wide commands.

Remaining known gaps are intentionally left as future work: deterministic readiness rescoring is still manual/prose-backed, recipe coverage is still partial, and report freshness policy has no numeric staleness threshold. These are not blockers for the current spec because the first upgrade explicitly allows a Markdown criteria registry and manual criterion rescore evidence.
