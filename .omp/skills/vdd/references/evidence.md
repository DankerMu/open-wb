# Evidence Lifecycle and Attestation

Evidence is not a sentence in a report. It is a versioned record binding a claim to a
candidate, judge, environment, execution, scope, and issuer.

## Reference state machine

```text
CONTRACTED
→ INTENT_VALIDATED
→ JUDGE_QUALIFIED
→ BASELINE_CAPTURED
→ IMPLEMENTING
→ CANDIDATE_GREEN
→ BROAD_GREEN
→ INDEPENDENTLY_ACCEPTED
→ MERGE_ATTESTED
→ RELEASE_ATTESTED
```

`BLOCKED` and `INVALIDATED` may be entered from any state. Characterization may finish
with an independently accepted `JUDGE_QUALIFIED + BASELINE_CAPTURED` artifact.

A state transition is earned by evidence, not by an Agent writing the state name.

## Reference attestation

```yaml
schema_version: vdd-0.4
attestation_id: A-001
objective_id: OBJ-001
mode: characterization | construction | equivalence | improvement
risk_profile: light | standard | critical
stage: characterization | merge | release
status: accepted | blocked | invalidated

candidate:
  revision: ""
  dirty: false
  artifact_digests: []

contract:
  revision: ""
  fingerprint: "sha256:..."

oracles:
  - id: O-001
    revision: ""
    fingerprint: "sha256:..."
    qualified: true
    known_bad_rejections: []
    no_change_trials: 1
    flake_rate: 0.0

fixtures:
  - name: corpus
    fingerprint: "sha256:..."

environment:
  digest: "sha256:..."
  details: {}

test_discovery:
  manifest_digest: "sha256:..."
  expected: 0
  discovered: 0
  executed: 0
  skipped: []
  approved_skips: []
  shards: []

commands:
  - id: Q-001
    command: ""
    exit_code: 0
    result: pass | expected_reject | fail | blocked
    artifact_refs: []
    claim_ids: []
    defeater_ids: []

claim_results:
  - claim_id: C-001
    status: confirmed | refuted | unknown
    evidence_refs: []

defeater_results:
  - defeater_id: D-001
    status: eliminated | survived | accepted_residual | unknown
    evidence_refs: []

qualification_attestations: []

mode_evidence: {}  # use the mode-specific Schema shape and command IDs

forbidden_scope_diff: []
residual_risks:
  - defeater_id: D-001
    stage: merge
    owner: ""
    rationale: ""
    expires_at: ""
    decision_ref: ""
    invalidated_by: []
invalidation_events: []

issued_by:
  identity: ""
  role: acceptor
  independent_from_candidate: true

merge:
  integration_passed: false
  cutover_complete: null
  rollback_exercised: false

release:
  canary_or_shadow: null
  thresholds_passed: null
  rollback_trigger: null
  release_owner: null

runtime_feedback:
  counterexamples_added: []
  open_incidents: []

parent_attestation:  # required for release; authenticated accepted merge evidence
  attestation_id: ""
  digest: "sha256:..."
  stage: merge
  status: accepted
  contract_fingerprint: "sha256:..."
  candidate_revision: ""
control_plane:
  issuer: vdd_accept
  run_id: ""
  # Optional control-plane-owned root. When set, every command records retained
  # stdout/stderr byte digests, lengths, file identities, and the executed sandbox policy.
  output_directory: /control-plane/retained-evidence
  # Optional declared Git source checkout binding, reverified before signing and verify.
  source_provenance:
    repository: "https://example.invalid/project.git"
    revision: "immutable-commit"
    clean: true
    candidate_artifacts:
      - path: src/candidate.py
        fingerprint: "sha256:..."         # accepted candidate snapshot identity
        source_fingerprint: "sha256:..."  # materialized source-checkout identity
        git_type: file
        git_mode: "100644"
        git_object: "..."
  protected_snapshot_before: []
  protected_snapshot_after: []
  candidate_snapshot_before: []
  candidate_snapshot_after: []
  discovery_digest: "sha256:..."
  qualification_snapshots: []
  parent_snapshot: null
  attestation_digest: "sha256:..."
  signature: ""

retained_at: ""
issued_at: ""
```

`control_plane.attestation_digest` is the canonical digest of the attestation with the
self-referential digest and signature fields omitted. The signature covers the populated
digest and all other attested content. Release and reused-qualification links store this
stable digest and must resolve the signed source artifact during verification.

The reference acceptance control plane derives `candidate.revision` from the copied
candidate artifact identity digest. Regular files bind content and mode; symlink
candidates bind the lexical link target and mode; every non-root ancestor directory of a
declared candidate binds type and mode. Plan steps execute in an OS sandbox where
protected inputs remain read-only and only dedicated result paths are writable.
Source-workspace command and environment paths are remapped into the copied snapshot.
Linux uses a PID namespace for process-tree containment; the macOS reference denies
process creation because `sandbox-exec` cannot contain detached descendants race-free.
These fields describe a stable, content-addressed acceptance snapshot; they are not an
unchecked proposal label or a claim that a source Git checkout is clean.

When `control_plane.output_directory` is present, every command must retain bounded
stdout, stderr, and the exact sandbox policy captured from the executed boundary. Each
stream binds a raw-byte SHA-256 digest, length, and filesystem identity. Issuance writes
these files to a private sibling staging directory and atomically renames it to the requested
previously-absent root only after evidence validation and signature creation. Failed issuance
removes its owned staging directory and does not reserve the final root; a published root is
never overwritten. Bundle verification requires the verifier to supply the same control-plane-
owned `--output-directory`, opens every artifact without following symlinks, and rejects
missing, replaced, redirected, length-mismatched, or digest-mismatched output. Retained
evidence cannot overlap the candidate workspace or a declared source checkout.

When `control_plane.source_provenance` is present, it binds origin URL, immutable HEAD,
clean status, distinct candidate/source artifact fingerprints, and Git tree
type/mode/object identities. Candidate and source fingerprints may differ in POSIX mode
bits while both still bind the same Git blob and executable bit. Rooted source observations
derive each source fingerprint and Git identity together; the accepted candidate identity is
rechecked from the verifier-owned snapshot. The issuer pins the source checkout generation
across Git and filesystem reads, repeats the check before signing, and verify repeats it with
`--source-workspace`. Cleanliness is derived directly from the
pinned Git tree and rooted filesystem observations; local filters, worktree redirection,
index hiding flags, pathspec magic, and replacement refs cannot weaken it. This is not a
portable archive: verification intentionally needs the retained evidence directory and,
when declared, the pinned source checkout.

`source_fingerprint` is mandatory for hardened `vdd-evidence-0.4` source provenance.
Earlier development attestations that omit it must be reissued from the pinned checkout;
they are not accepted as parent evidence because their original materialized-source
identity cannot be reconstructed from the signature.

For fresh Oracle qualification, `known_bad_rejections`, `no_change_trials`, and
`flake_rate` are derived from executed, explicitly identified, dedicated qualification
plan steps. A known-bad exit is accepted only when its output contains the
Contract-owned semantic rejection signal; setup, import, dependency, or crash failures
do not qualify the Oracle. Stability IDs cannot overlap discovery, protected result
generation, or another non-stability control-plane role. For reused qualification, the
authenticated prior attestation must match the current Oracle, fixture/corpus, and
environment identities as well as the required trials and Defeater coverage.

Discovery, Improvement metric, Equivalence cutover, and release evidence are assembled
from structured artifacts emitted by Contract-declared protected producers. Each result
is captured at its producer step and sealed against later replacement. Proposal-supplied
samples, counters, policy values, result labels, rollback claims, and release decisions
are discarded.

Critical single-platform evidence binds `environment.details.runtime.platform_id` to its
matrix key. External multi-platform aggregation additionally records
`environment.details.platform_matrix_evidence` (platform to protected command ID) and
`environment.details.platform_attestation_digests` (platform to authenticated source
attestation digest); authentication remains the external aggregator's responsibility.

## Acceptance rules

An accepted attestation requires:

- no material invalidation event;
- no `refuted` required claim;
- every required contract claim represented;
- no unapproved discovery/skip/shard drift;
- protected scope unchanged or separately approved and requalified;
- every relied-upon oracle qualified under the recorded identity; reused qualification
  resolves to an authenticated prior attestation, while fresh qualification records a
  restoration pass after the known-bad rejection;
- every confirmed Claim and eliminated Defeater has semantically tagged passing/rejection
  command evidence;
- every Contract-declared stage gate passed;
- no failing required command;
- Standard/Critical issuer independent from candidate write authority;
- accepted residual risks match the Contract, have the correct stage/owner, and have not
  expired at issuance or at the verifier's current (or explicitly supplied historical)
  verification time;
- Critical unknowns blocked unless the contract was explicitly narrowed or a named risk
  owner accepted the residual for this stage;
- mode-specific baseline and completion evidence;
- release Evidence resolves an authenticated parent whose Contract and candidate match.

## Invalidation graph

Evidence should name both direct invalidators and dependency relationships. Typical
invalidators:

```text
contract/claim/defeater revision
oracle/harness revision
fixture/corpus/golden/normalizer/tolerance/threshold revision
reference classification or revision
candidate artifact
lockfile/dependency/toolchain/build-mode revision
test discovery/filter/shard/skip policy
environment, data, platform, runtime, configuration, feature flag
benchmark workload/parser/sampling policy
security/network/secret policy
production configuration or signal definition
```

When an invalidator changes:

1. mark affected attestations `INVALIDATED`;
2. determine which claims/oracles depend on the change;
3. assign new fingerprints;
4. requalify changed judges;
5. rerun affected gates;
6. issue a new attestation rather than rewriting history.

## Merge and release stages

### Merge attestation

Confirms repository integration, fresh claim evidence, intact protected scope, required
cutover, and declared restoration capability. It does not claim production conditions
were exercised unless explicitly included.

### Release attestation

Depends on a valid merge attestation and adds supported environment/workload evidence,
shadow/canary, production thresholds, rollback trigger/exercise, a named Release Owner,
and stage-specific residual risk acceptance.

## Evidence retention

Retain enough material to reproduce the decision:

- objective contract and revision history;
- oracle and fixture/corpus identities;
- commands and machine-readable outputs;
- counterexamples and minimization results;
- test discovery/skip/shard manifests;
- environment/toolchain/dependency fingerprints;
- claim/defeater disposition;
- rollback/cutover evidence;
- attestation and issuer identity.

Do not rely only on temporary Agent transcripts, ephemeral branches, or squashed commit
messages. Evidence history should remain auditable even after implementation history is
simplified.

## Runtime feedback

A production counterexample invalidates only the claims and attestations within its
scope, but it must not be dismissed as “outside the test suite.” Preserve it, minimize
it, add it to the permanent corpus, update the failure model, and re-accept the affected
candidate.
