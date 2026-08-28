# Postmortems

An incident write-up for a defect that reached where it should not have — a shipped skill version, a committed claim, a decision made on a wrong number. The point is not the one-line fix; it is *why our process let it through*. This is the only tier where narrative belongs; the chronology records evidence, not a teaching sequence.

A postmortem is **not** a decision record. Records capture deliberate choices and the alternatives they beat. Postmortems capture failures in hindsight.

## When to write one

All three must hold:

1. **Subtle** — the mechanism is non-obvious; a careful engineer would re-derive it the hard way.
2. **Systemic** — it escaped because of a gap in tests, tooling, or conventions, not a one-off typo.
3. **Costly to rediscover** — real debugging time was spent and would be spent again.

Link every guardrail the postmortem produced. Files are `NNNN-short-slug.md`, numbered sequentially; register each in the table below.

## Skeleton

```markdown
# Post-mortem NNNN: <one-line incident title>

Status: resolved (<fix reference>)

## Executive summary
<!-- One 30-second paragraph: what broke, root cause in plain words, why it
     escaped, the durable lesson. Write it last. -->

## Impact
<!-- What was wrong in the world; the explicit boundary of what did NOT happen. -->

## Timeline
<!-- Evidence-driven: commands, outputs, commit ids — verifiable anchors. -->

## Root cause
<!-- The precise mechanism, AND "why existing defenses missed it". The defense
     gap is the systemic half and is mandatory. -->

## Guardrails added
<!-- Each entry names a mechanism that exists and can be verified by name.
     Per landing layer — prose rule / policy / mechanical — either a named
     mechanism or `not applicable` with a one-line reason. A lesson landed only
     in prose is not landed. A regression guard must be able to fail for the
     reported mechanism: introduce it, watch red, revert. -->

## Lessons
<!-- Generalizable bullets. Candidates for a danger-patterns doc once a second
     incident converges on the same class. -->
```

## Danger-patterns threshold

`docs/danger-patterns.md` is created only when **two or more distinct defect classes** have been recorded. A single class stays in its own postmortem and its mechanical guardrail, however many instances it has: a document with one entry is a worse home for that entry than the postmortem it came from.

(The earlier wording said "≥2 incidents converge on the same defect class", which contradicted the status line below it — the two sentences stated different thresholds. Convergence within one class is what makes the class worth naming; it is the *second class* that makes a shared document worth having.)

No gate enforces this threshold, deliberately. Deciding that two incidents share a defect class is a semantic judgement, and a gate that guessed it would either nag at every second incident or stay silent forever. The mechanical half that *is* worth gating: a danger-patterns doc must link ≥2 distinct postmortems, so one seeded from generic best practice fails. That rule is not wired here yet, because the doc does not exist and a check for an absent file is the speculative defense this skill tells target repos to delete — so the trigger is written down instead of remembered: **the commit that creates `docs/danger-patterns.md` is the commit that adds its link-count rule to `check_doc_claims.py`.** The reverse error — a class that recurred and never got promoted — is caught by reading this index, which is why it stays short.

Current status: one class recorded — overstated verification scope, postmortem 0002, eleven instances. A second distinct class earns the doc.

## Index

| # | Title |
|---|---|
| [0001](0001-stale-bytecode-validated-deleted-code.md) | Bytecode cache let the suite validate code that was no longer there |
| [0002](0002-verification-scope-overstated-four-times.md) | Verification scope overstated eleven times, the last four inside the record itself |
