# Work Unit Ledger

A work unit is small enough to understand and independently executable, falsifiable,
diagnosable, integrable, reversible, and acceptable.

## Reference template

```yaml
id: WU-001
goal: ""
mode: characterization | construction | equivalence | improvement
risk_profile: light | standard | critical
claim_ids: []
defeater_ids: []
behavior_boundary: ""
behavior_dependencies: []
depends_on: []
shared_state: []
shared_seam_owner: null
lease_owner: ""
integration_wave: 1

scope:
  allowed_files: []
  protected_files: []
  dependency_changes: []

fixtures:
  representative: []
  edge: []
  error: []
  adversarial: []
  holdout_policy: null

checks:
  qualification: []
  baseline: []
  fast: ""
  focused: ""
  broad: ""
  integration: ""
  platform: []

expected_prechange_evidence: ""
expected_result: ""
nonfunctional_gates: []
review_focus: []
repair_budget: 3
verifier_cost_estimate: null

roles:
  implementer: ""
  verifier_owner: ""
  acceptor: ""

oracle_revisions: []
reference_revision: null
environment_requirements: []
evidence_invalidated_by: []

integration_or_cutover: ""
rollback_or_restore: ""

status: contracted | intent_validated | judge_qualified | baseline_captured | implementing | repairing | candidate_green | broad_green | accepted | blocked | invalidated

finding_ids: []
attestation_id: null
evidence:
  commands: []
  exit_codes: []
  artifacts: []
  observed_deltas: []
  claim_disposition:
    confirmed: []
    refuted: []
    unknown: []
  inventory_disposition:
    confirmed_fixed: []
    not_applicable: []
    unresolved: []
    unknown: []

blocker: null
```

## Sizing rules

Split a unit when:

- it contains more than one independently diagnosable failure signature;
- one rollback cannot restore it alone;
- unrelated subsystems are needed to understand it;
- its focused check is effectively the entire project suite;
- its failure model requires incompatible environments or acceptors;
- it would monopolize the verifier queue and prevent useful feedback.

Merge units only when splitting creates an unobservable or invalid intermediate state.

## Parallel execution

Units may run in parallel only when:

- behavior/contract dependencies permit it;
- shared state and generated outputs have an explicit owner/lease;
- neither unit changes the other’s contract, judge, fixture, threshold, discovery, or
  acceptance environment;
- candidate scopes do not conflict, or a safe structured merge mechanism exists;
- dependency order and integration waves are explicit;
- verifier and integration capacity can return feedback before the batch grows stale.

Disjoint files are a conservative default, not sufficient evidence. Different files can
change one protocol or state machine; structured edits to one file can sometimes be safe
under one owner.

Use a work-in-progress limit. Track verifier queue latency, failure rate, merge conflict
rate, and repair rounds. Reduce batch size when feedback is no longer timely.

## Pilot before scale

For large or Critical Equivalence, pilot at least:

- one routine/repetitive unit;
- one high-risk semantic unit;
- one shared-seam or platform-sensitive unit.

The pilot must validate fact extraction, oracle qualification, role/permission
separation, repair taxonomy, integration, and evidence attestation—not only compilation.

## Systemic fixes

After a generator, type-system, schema, framework, or rule-level fix, revisit every
linked finding/classification ID. A unit is not accepted while any required instance is
`unresolved` or `unknown`, or while its recorded oracle/reference/environment identity
differs from the final gate without requalification.
