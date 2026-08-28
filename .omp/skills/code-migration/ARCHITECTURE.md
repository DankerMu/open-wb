# code-migration — layering and change rules

Written for people changing this skill, not for the agent running a migration. Nothing here is
loaded at runtime; `SKILL.md` and the progressively disclosed `references/` are.

It exists because four separate attempts to change `SKILL.md` regressed the suite, and no file
said what belongs where or which check applies. Every rule below is stated with the measurement
that produced it, so a future contributor can re-derive or overturn it rather than inherit it.

## The four layers

| Layer | Files | Loaded when | Owns |
|---|---|---|---|
| **Router** | `SKILL.md` | Always — it is the system prompt | Route classification, ownership boundaries, and the refusal/completeness rules that must hold even when nothing else is read |
| **Protocol** | `references/*.md` | On demand, by name | The full procedure for each topic: gate criteria, artifact contracts, delegation, route variants, failure routing |
| **Enforcement** | `schemas/*.json`, `tools/*.py`, `tests/` | When an artifact is validated or a pack is built | Everything that must be *mechanically refused* rather than merely stated |
| **Scaffolding** | `templates/*` | Copied by a human | The shape of each artifact a program produces |

Rule of placement: **if getting it wrong fails silently, it belongs in the Router; if it can be
refused by a program, it belongs in Enforcement; everything else belongs in Protocol.** A
statement that appears in two layers must name one as authoritative — the skill's own doctrine
("one concept, one authoritative owner") applies to the skill itself.

The rule is forward-looking, not a description of the current state, and it is in tension with
the Router's measured saturation below. Silent-failure clauses live in Protocol today —
`references/failure-routing.md` on weakening test discovery, `references/variants.md` on
bundling a marked defect under a parity claim and on a compatibility adapter changing owner.
Do not migrate them wholesale on the strength of this rule: promoting a clause to the Router
costs Router budget, so it needs the same gate as any other Router change. Use the rule when
deciding where *new* content goes, and treat an existing misplacement as a candidate, not a
defect.

## Changing the Router

Measured record — `git log --oneline -- skills/code-migration/` and
`code-migration-evolution/experiments.jsonl`:

- 14 `evolve`-prefixed commits touch `SKILL.md`; two of them are baselines (`38672bb`,
  `b568635`), so **12 numbered iterations** changed it. **10 were reverted; 2 were kept**
  (`c4903d0` iteration-22, `853e4e3` iteration-23), and those two took dev 0.818 → **1.000**.
- Three ungated manual commits — `16cdc68`, `99c0044`, `d64ec45` — sit between the 11/11 that
  ended phase 2 and the 9/11 that opened phase 3. The ledger attributes the regression to all
  three; do not narrow it to one.

The conclusion is *not* "do not change `SKILL.md`". An earlier draft of this file said that and
was wrong; the ledger refutes it. The conclusion is:

> **Every `SKILL.md` change runs the gate.** From `code-migration-evolution/`:
> `./phase2/run_suite.sh gt/session-dev.json <candidate-skill-dir> <out-dir> 4 sonnet`
> — three arguments are mandatory. Then re-run the suite over a one-case GT file for any
> verdict-changing flip, twice, and take the majority — or drive `phase2/run_case.sh <case-id>
> <gt-file> <skill-dir> <run-root>` plus `phase2/judge.py` directly, which is the same thing
> without authoring a file. Nothing resamples and takes a majority for you, and `rejudge.sh`
> re-judges an existing transcript, which samples judge variance only, not the executor
> variance that dominates. Keep only if no previously-passing case regresses. This is
> the gate `c4903d0` and `853e4e3` passed and the three manual commits skipped.

Two further constraints, both learned by measurement:

- **One concept per change.** Iteration-31 bundled a deletion and an addition, produced a
  net gain and a regression at once, and its causal story was refuted by iteration-32. If the
  description needs "and", split it.
- **Additions are not free.** Router text competes for a finite reply; a clause that displaces
  an existing behaviour costs more than it adds. Prefer moving a clause to Protocol over
  duplicating it into the Router.

## Prose ↔ Enforcement

The recurring defect class in this skill's history is a statement in one layer that the other
layer contradicts or cannot represent. Examples that shipped: a mandated cost log with no
defined location; catalog columns with no schema field under `additionalProperties: false`; a
provisional gate verdict the closed gate schema rejects; an identifier charset documented as
"not checked by the validator" after the validator began checking it.

Two rules follow:

1. **Every Protocol clause that names a file, format, enum, or threshold must either have a
   machine home or say plainly that nothing enforces it.** An unenforced obligation is
   allowed; an unenforced obligation that reads as enforced is not.
2. **Every Enforcement constraint that can reject a good-faith artifact must be documented
   where the person writing that artifact will read it.** `references/delegation.md` carries
   the producer-only constraints for this reason.

## The oracle, and what it can decide

`code-migration-evolution/` holds the only oracle: 12 suites, 50 cases, **136 of 138 assertions
are `llm_judge`**, 2 `contains`. Consequences, all measured:

- A one-case delta is inside judge variance. Four of eleven `session-dev` cases (`s02`, `s03`,
  `s04`, `s10`) flip between runs of the *same* artifact; `s02` alone was measured
  P,P / F,F,F / F,P,F / F,F,P / P / F,P,P across six versions.
- Phase 3 therefore spent 107 of 150 oracle runs for **zero keeps** and `UNCONFIRMED`.
- Prediction accuracy across phases 2–3 is **1 of 9** — `predictions.jsonl` holds nine committed
  predictions (iterations 21–24, 31–35); `results.tsv` row 23 is the only one borne out.
  (`predictions.jsonl` itself stores no correctness field; the count comes from the ledger.)
  Treat any causal story about why a change worked as a hypothesis, not a finding.

Mechanical assertions can be *added* but not *converted* — none of the 47 `llm_judge` assertions
in the session suites turns on the presence of a token, so none has a mechanical pass condition
(their other 2 assertions are already `contains`) — and the one attempt to add one **failed qualification on its
first live run**. The criterion it targeted ("does the reply end with an open-ended ask *without
concrete options*") is relational, and surface patterns could only trade a false positive for
three false negatives. Treat mechanization as a narrow lever, not the fix; raising samples per
case is the one that actually resolves a delta. Protocol and the three failure modes:
`code-migration-evolution/MECH_ASSERTION_QUALIFICATION.md`.

## External dependencies

`tools/build_missions_v4_pack.py` needs Missions' approval-envelope schema. It is resolved at
call time and selected **by contract, not by path**: a bounded search inside the repository
reads each candidate and accepts only the one pinning the `schemaVersion` this producer emits;
`MISSIONS_APPROVAL_ENVELOPE_SCHEMA` overrides the location but goes through the same version
gate. The resolved path is reported in the producer's output, because resolution is ambient and
first-match, so which file validated a sealed envelope must be auditable.

Three earlier attempts here were each wrong in a different way — a hard-coded tree, a recursive
search that matched other skills' scaffolding and reached `$HOME`, and a filename list that
paired a new-generation envelope with an old-generation schema. `tests/test_envelope_schema_resolver.py`
pins the resulting behaviour. Note that the resolver requires the unversioned schema that
Missions' in-flight rename produces; it fails loudly, not silently, against the versioned one.

## Self-audit warning

The recent audits of this skill were written by the agent that had made most of its recent
changes. They reached a defensible verdict through arguments containing a false headline fact,
a manufactured finding, and an internal contradiction — each caught only by independent review.
Across six review rounds, self-review caught one defect and independent review caught the rest;
the last round's finding was that corrections get made in one document and not propagated to
the siblings that contradict them. **Have any structural conclusion about this skill checked by
an agent that did not write the changes, and have it check the sibling documents too.**
