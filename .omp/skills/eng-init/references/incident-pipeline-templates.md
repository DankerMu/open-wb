# Incident Pipeline Templates (conditional — Q6.9 yes)

<!-- eng-init template version: 2026-08-08 -->

The knowledge-recycling loop for escaped defects: **postmortem** (the incident story) → **danger-patterns doc** (the recurring defect class, once it recurs) → **mechanical guardrails** (the layer that actually prevents recurrence). This is the Evaluation/GC layer applied to knowledge: incidents are expensive evidence, and without a pipeline they evaporate into chat history. Distilled from a production agent-maintained monorepo where four postmortems seeded the testing policy and six defensive-pattern rules (`_archived/ds-harness-mining/06-incidents.md`).

Install the contract skeleton **before the first incident** — when one lands, the rules already exist. The skeleton is two small files (`docs/postmortem/README.md` + the AGENTS.md hook); postmortems themselves are written by the repo's maintainers when incidents occur, never fabricated by eng-init.

## `docs/postmortem/README.md` — the contract

```markdown
# Postmortems

An incident write-up for a bug that reached where it should not have — a real
user, a merged PR, a release. The point is not the one-line fix; it is *why our
process let it through*. This is the only doc tier where war-story narrative
belongs; chronology records evidence, not a teaching sequence. A postmortem is
not a decision record: records capture deliberate choices and beaten
alternatives, postmortems capture failures in hindsight.

## When to write one

Write a postmortem when all three hold:

1. **Subtle** — the mechanism is non-obvious; a careful engineer would
   re-derive it the hard way.
2. **Systemic** — it escaped because of a gap in tests, tooling, or
   conventions, not a one-off typo.
3. **Costly to rediscover** — real debugging time was spent and would be
   spent again.

Link every guardrail the postmortem produced (tests, rules, gates). Files are
`NNNN-short-slug.md`, numbered sequentially; register each in the table below.

| # | Title |
|---|---|
```

## Postmortem skeleton

```markdown
# Post-mortem NNNN: <one-line incident title>

Status: resolved (<fix reference>)

## Executive summary
<!-- One 30-second paragraph: what broke, the root cause in plain words,
     why it escaped, the durable lesson. Mandatory — write it last. -->

## Impact
<!-- User-visible symptoms; data/security/diagnostic cost; and the explicit
     boundary of what did NOT happen. -->

## Timeline
<!-- Evidence-driven: log sequence numbers, session ids, command outputs —
     verifiable anchors, not recollection. -->

## Root cause
<!-- One subsection per cause: the precise mechanism, with file references,
     AND "why existing defenses missed it" — the defense gap is the systemic
     half of the finding, and it is mandatory. -->

## Guardrails added
<!-- Each entry names a mechanism that exists and can be verified by name:
     a test file, a gate, an AGENTS.md rule. A regression guard must be able
     to fail for the reported mechanism — introduce the regression, watch it
     go red, revert. A guard that stayed green when the bug was reintroduced
     is not a guardrail. -->

## Lessons
<!-- Generalizable bullets — candidates for the danger-patterns doc once a
     second incident converges on the same class. -->
```

## The three-layer landing contract

An incident lesson lands in up to three layers, and each layer is either **present or explicitly `not applicable` with a one-line reason** — a bare missing layer is the audit failure, not the absence itself:

1. **Prose rule** — an AGENTS.md convention or danger-patterns entry.
2. **Policy** — the testing-policy / verification-matrix implication ("this class of change now requires this class of evidence").
3. **Mechanical** — the named test, gate, or config that fails on recurrence.

A lesson landed only in prose is **not landed**: nothing rejects the recurrence. The postmortem's Guardrails section is where the three-layer disposition is recorded, and the audit check is per-layer: named mechanism or explicit `not applicable` + reason.

## Danger-patterns doc — the convergence threshold

Create `docs/danger-patterns.md` (name to taste) only when **≥2 incidents or near-misses converge on the same defect class**. A single incident's lesson stays in its postmortem and its mechanical guardrail — promoting every one-off produces a generic best-practices list nobody reads (the same rule as AGENTS.md constraint lists: entries are earned through real incidents).

**This threshold is a human call, and no gate enforces it.** Judging that two incidents share a defect class is exactly the kind of semantic judgement contract rule 5 keeps out of gates — a check that guessed would either nag at every second incident or never fire. What a gate *can* do is the cheap half: reject a `danger-patterns.md` that links fewer than two distinct postmortems, which catches the doc seeded from generic best practice or from one incident. The opposite error — a class that recurred and was never promoted — is caught by people reading the postmortem index, so keep that index short enough to read.

Entry contract: each entry is *a defect class that actually shipped or nearly shipped here*, stated as the rule that prevents recurrence, with an anchorable heading so gates, reviews, and decision records can cite it. Give the file a word budget; it competes for the same attention AGENTS.md does.

AGENTS.md hook — add only once the doc exists and covers ≥2 domains, and list the concrete domains (a generic "read the docs" line routes nobody):

```markdown
Read docs/danger-patterns.md before {{DANGER_DOMAINS}} work.
```

`{{DANGER_DOMAINS}}` names the actual burned areas — e.g. "lifecycle, concurrency, subprocess, or teardown".

## Decision-record hook

When the decision-records module (Q6.8) is also installed: a record fixing an incident-revealed defect references its postmortem (`References: postmortem NNNN`), and a new mechanism in a previously-burned area states how it avoids the recorded failure class. This is how one incident keeps paying: the postmortem becomes citable rationale instead of a story nobody re-reads.

## Readiness mapping

`incident_pipeline` — the contract exists (README with trigger criteria + skeleton) and each written postmortem's guardrails name mechanisms that exist. Promotion to a danger-patterns doc is **not** gated: whether two incidents converge on one defect class is a judgement, and contract rule 5 (Deterministic) keeps judgements out of gates. Only the mechanical half is checked — a danger-patterns doc that exists must link ≥2 distinct postmortems, which rejects one seeded from generic best practice or from a single incident. Skippable when the repo has no recorded incidents and declines the skeleton.
