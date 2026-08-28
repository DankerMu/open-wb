# Behavior Catalog

The machine-checked record of behavior classification is `source-classification.json`,
validated by `tools/validate_artifacts.py`. This catalog is the human working document that
produces it: every row must map to one ledger behavior, and the ledger is authoritative
wherever the two disagree.

| Rule ID | Priority | Observable statement | Source citation | Disposition | Decision owner | VDD claim | Blocking stage |
|---|---|---|---|---|---|---|---|

`Disposition` and `Blocking stage` use the ledger's own values — `accepted | corrected |
unknown`, and `bootstrap | batch | completion | cutover | release`. Only the ledger's
`unknown` disposition blocks acceptance, and it must declare `blockingStage: batch`; this
catalog defines no separate blocking rule.

`Priority` is a review-attention aid with no gate effect: `P0` means the behavior moves money,
satisfies a regulatory or compliance obligation, or protects data integrity; `P2` is display
and formatting; everything else is `P1`. A `P0` rule the team cannot state with confidence is
recorded as ledger `unknown`, which is what actually blocks — not the priority.

## Per-rule detail

Repeat one block per rule; prose belongs here, not in the table.

### <Rule ID>

- Given / When / Then (concrete values, not paraphrase):
- Edge cases:
- Confidence and the exact open question for the decision owner:
- Suspected source defect (recorded, never silently fixed; preserve-or-correct is the
  Contract Owner's classification decision):
