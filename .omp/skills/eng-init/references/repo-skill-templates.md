# Repo-Local Skill Templates (conditional — Q6.10 yes)

<!-- eng-init template version: 2026-08-08 -->

A repo-local skill is a `SKILL.md` living inside the target repository (`.claude/skills/<name>/`, `.agents/skills/<name>/`, or `.factory/skills/<name>/` — reuse whichever directory the `skills` readiness criterion already detects). It is the control plane's **protocol layer for procedural knowledge**: multi-step, judgment-bearing, failure-branching workflows that are too long for AGENTS.md and too behavioral to become a gate. Without this layer that knowledge either bloats AGENTS.md past its budget or lives nowhere. Distilled from a production agent-maintained monorepo whose ten repo skills carry exactly this load (`_archived/ds-harness-mining/03-skills.md`).

## Placement decision tree

Where a piece of repo knowledge belongs — apply in order, first match wins:

1. **Mechanically checkable** → a gate (`gate-quality-contract.md`). Never a skill step.
2. **Needed every session and expressible in 1–3 lines** → AGENTS.md, linking its home.
3. **Product or runtime fact** → docs / README (the fact's one home).
4. **Decision rationale, beaten alternatives** → a decision record (`aux-file-templates.md` § Decision records).
5. **Multi-step + judgment + failure branches + repo-specific operational detail** → a repo-local skill.

The AGENTS.md line budget is the forcing function: when a procedure cannot fit in 1–3 lines, the AGENTS.md line becomes a pointer ("Before pushing, follow `.claude/skills/pre-push-checks/SKILL.md`; report only commands actually run") and the procedure moves here — never grow AGENTS.md with a walkthrough.

## Authoring contract

Frontmatter: `name` (kebab-case) + `description` written as a trigger sentence — "Use when/before <concrete situations in this repo>…" — naming the repository and the moments that should route an agent into the skill. A description that cannot say when to fire is a skill nobody invokes.

Body skeleton, in order:

1. **Self-limiting statement.** Judgment skills open with "guidance, not a script/checklist" so they are not executed mechanically; only state-machine flows (every step has a verifiable exit) end with a literal checklist.
2. **Sources of truth** — links to the owning contracts (AGENTS.md sections, docs, decision records). Read, don't restate: copying contract text here creates a second home that rots (`one home per fact`).
3. **Classify/triage first.** Before acting, classify the situation (change type, lifecycle state, surface touched) — classification decides which steps apply.
4. **Numbered steps** with exact commands. Mechanical steps get copy-pasteable commands with their flags and an inline reason; each command doubles as a verifiable exit for its step.
5. **Validation and reporting contract.** Report only commands actually run; report pending as pending. Include the negative-claims discipline: state what a green result does **not** prove (a passing pairing hash does not prove translation quality; a completed sync command does not prove the branch is ready).
6. **Failure branches.** Three shapes: *hard-stop* (a precondition is missing — report the exact prerequisite and stop; never degrade to a workaround), *delegate* (hand a well-bounded sub-task to a subagent with its complete working set, then verify — reports describe intent, not what landed), *repair-validate-republish* (for rewrite-class operations: leave the protected state in place, fix, re-verify, then publish).
7. **Live-state distrust.** Steps that act on remote/mutable state re-fetch it first; identifiers captured before a rewrite (commit hashes, review anchors) are not current evidence after it.

### Judgment-type skills: four mandatory elements

Skills whose core is a judgment call (what to archive, what to trim, what evidence suffices) additionally carry:

- **Anti-quota statement**: explicit "do not work toward a count; size/age are discovery aids, never criteria."
- **Calibrated example set**: real before/after cases from this repo, chosen so the superficial metric contradicts the right answer (a long entry that stays, a short one that goes) — examples teach the governing principle, not text to copy.
- **Semantic criteria list**: the actual test, stated as questions about future usefulness, ownership, or contract coverage.
- **Borderline escalation**: a defined shape for "genuinely borderline" plus the obligation to surface those cases with a recommendation instead of deciding silently.

New rules enter a skill only with incident evidence (a real failure or repeated review comment) — treating every comment as a lesson produces checklist bloat, the prose version of gate rot.

## Template 1 — `pre-push-checks` (evidence selection; L2+)

```markdown
---
name: pre-push-checks
description: Use before pushing, marking ready for review, or claiming checks pass on a {{PROJECT_NAME}} branch — selects the smallest checks that cover the outgoing diff instead of reflexively running the full suite.
---

# Pre-Push Checks

Guidance, not a script. Hooks are intentionally narrow ({{HOOK_SUMMARY}}); CI owns exhaustive coverage. There is no universal local baseline: every change runs the narrowest evidence that would fail for its regression, once.

## Inspect the outgoing change

1. `git status --short --branch` — confirm checkout and branch.
2. `{{CHANGE_SCOPE_CMD}} <verified-base-ref>` — explicit base, never guessed; re-run after any retarget or base merge.

## Select evidence by surface

| Change touches | Run |
|---|---|
| {{SURFACE_1}} | {{NARROWEST_CMD_1}} |
| {{SURFACE_2}} | {{NARROWEST_CMD_2}} |
| Docs / config | {{DOC_CHECK_CMD}} |
| Build/packaging/public exports | {{BUILD_SMOKE_CMD}} |

Do not repeat a check that already passed for this change. Full local rehearsal only on explicit request, while diagnosing CI, or for an irreducibly repo-wide change.

## Failures and reporting

A relevant failure stops the push — never push and hope CI differs. Suspected environment-specific failures need proof: exact command, failing case, platform mismatch, plus passing non-platform evidence. Report only commands actually run; report pending CI as pending.
```

## Template 2 — `prose-contract` (comment/doc quality; L2+)

```markdown
---
name: prose-contract
description: Use when writing, reviewing, trimming, or auditing prose in {{PROJECT_NAME}} — comments, doc pages, commit/PR text, error messages — to keep contracts and delete transcripts.
---

# Prose Contract

Guidance, not a template library. Scope is required input — without a named file set, stop and ask.

## Keep vs. delete

Keep what code cannot express and affects correct use: behavior, timing/modality, failure conditions and resulting state, consequences, ownership, safe-use constraints, non-obvious placement rationale (one line + link to the owning decision record). Delete reasoning transcripts: implementation narration, proofs of obvious branches, test walkthroughs, review history, rejected local alternatives (those belong in decision records), code restatement.

## Current state only

No "previously/now/no longer", no PR numbers or commit hashes in durable prose — name the live mechanism; change stories live in commits, PRs, and decision records. Rationale lives once at the owning seam, not copied beside each sibling.

## Slop audit checklist

Same rule in >1 home · narrated history · implementation-status annotations · hand-copied inventories where a source/generator is authoritative · reasoning transcripts · paragraph walls (several rules per paragraph) · emphasis inflation · empty "TBD" sections. Borderline trims (both versions preserve the full proposition): present 2–3 candidates with a recommendation; do not decide silently.
```

## Template 3 — `decision-record-lifecycle` (only when Q6.8 selected decision records; L3+)

```markdown
---
name: decision-record-lifecycle
description: Use when adding, updating, superseding, or retiring decision records in {{PROJECT_NAME}} — enforces the supersession check on write and semantic (never quota-based) retirement.
---

# Decision Record Lifecycle

Guidance, not a script. Contract: {{DECISIONS_README_PATH}}.

## On every new record

Run the supersession check **at write time** (the author holds the freshest evidence): search the active records for ones covering the same decision or mechanism. Fully superseded → fold every unique rationale/alternative/consequence into the new record, then retire the old one; partially superseded → keep both, cross-link, update the stale facts. A record is never edited into a different decision.

## Retirement is semantic, never quota

Word count and age are discovery aids, never criteria; do not retire toward a target. Keep any record whose alternatives, negative guarantees, ownership boundaries, security rules, or reintroduction conditions can still steer future work. Genuinely borderline records: list them with a recommendation instead of deciding silently.
```

Authoring guidance for the eng-init operator (not instantiated into the target repo): when Q6.8 selected the **full four-zone lifecycle**, the operational spec lives in `decision-record-operations.md` (zones `proposed/`/`implemented/`/`rejected/`/`archived/`, kind classification, archive freeze, note-required rule, GC by future decision value, manifest/verify script). This template stays the write-time supersession contract; the operations file owns the lifecycle — the operations rule 2 points back here, so the two cannot drift.

## Cross-linking rules

- **AGENTS.md** carries one pointer line per installed skill, inside the section that owns the moment (Scoped verification → pre-push-checks; Conventions → prose-contract; Agent Operating Rules → decision-record-lifecycle). The pointer states the obligation, the skill carries the procedure.
- **Skills name the gates they run** and — critically — what a green gate does *not* prove; that residual judgment is the skill's reason to exist.
- **Gates point back**: a gate whose red output has a workflow answer references its owning skill in the failure message ("over budget — follow prose-contract: relocate, then condense, then raise with justification").
- Skills are enforcement-adjacent artifacts: every command a skill names must resolve to a real dev-entry target (the no-phantom-enforcement check applies to skill bodies too).

## Anti-patterns

- A standing command in a skill (belongs in AGENTS.md).
- Contract text copied into a skill (belongs in its one home; link instead).
- A mechanically checkable rule as a skill step (belongs in a gate).
- A skill installed without its trigger moment existing in this repo (empty-shell protocol: an unfireable skill trains agents to ignore the layer).
- Growing a skill without incident evidence.
