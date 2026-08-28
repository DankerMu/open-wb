# VDD Objective Contract and Assurance Case

Create one objective contract per independently accepted software outcome. A contract is
not a large design document; it is the smallest durable record that makes claims,
possible failure, judges, permissions, and acceptance gates explicit.

Light work may keep an inline contract. Standard and Critical work should use the full
manifest below or the JSON form validated by `tools/vdd_lint.py`.

## Reference template

```yaml
schema_version: vdd-0.4
revision: contract@1
objective_id: OBJ-001
mode: characterization | construction | equivalence | improvement
risk_profile: light | standard | critical
goal: ""

intent:
  status: validated | spec_dispute | blocked
  owner: ""
  authority: ""
  sources: []
  positive_examples: []
  negative_examples: []
  critical_scenarios: []
  ambiguities: []
  unknowns: []
  decisions: []

claims:
  - id: C-001
    statement: ""
    scope: ""
    severity: low | medium | high | critical
    assumptions: []
    oracle_ids: []
    defeater_ids: []

# A defeater is a plausible way a claim could be false even when the implementation
# looks reasonable or some tests pass.
defeaters:
  - id: D-001
    claim_id: C-001
    description: ""
    failure_class: BEHAVIOR_DIFF
    severity: low | medium | high | critical
    status: covered | accepted_residual | unknown
    oracle_ids: []
    qualification_fault: null
    risk_owner: null
    risk_acceptance: null # accepted_residual requires owner, stages, rationale, expiry, invalidators

oracles:
  - id: O-001
    type: static | unit | contract | differential | property | metamorphic | integration | e2e | fuzz | sanitizer | benchmark | model | production
    owner: ""
    protected: true
    revision: ""
    fingerprint: "sha256:..."
    claims: []
    failure_classes: []
    quality:
      fidelity: low | medium | high
      independence: low | medium | high
      sensitivity: low | medium | high
      reproducibility: low | medium | high
      environment_realism: low | medium | high
    qualification:
      status: fresh
      known_good_command: ""
      restore_command: ""
      known_bad_cases:
        - defeater_id: D-001
          fault: ""
          expected_rejection: ""
      stability_command_ids: []
      stability_required: false
      required_no_change_trials: 0
      max_flake_rate: 0.0

fixtures:
  - name: corpus
    fingerprint: "sha256:..."

baseline:
  semantic_red_command: null
  reference_green_command: null
  semantic_green_command: null
  metric:
    name: null
    direction: null
    baseline_command: null
    runs: null
    noise_band: null
    minimum_improvement: null

scope:
  editable: []
  protected:
    - contract and claim definitions
    - oracle and acceptance harness
    - fixtures, golden outputs, normalizers, tolerances
    - benchmark parser and thresholds
    - test discovery, shards, CI acceptance scripts
    - attestation signing material
  dependency_change_policy: ""
  network_policy: ""
  secret_policy: ""
  destructive_commands: []

candidate_capabilities:
  writable_paths: []
  readable_protected_paths: []
  allowed_commands: []
  denied_commands: []
  network_policy: deny
  secret_policy: none
  dependency_change_policy: deny | review | allowlist
  destructive_git_policy: deny

control_plane:
  candidate_artifacts: []
  protected_assets:
    - path: ""
      fingerprint: "sha256:..."
  allowed_output_paths: []
  environment_allowlist: []
  discovery:
    command_id: ""
    result_path: ""
  metric_result: # required for Improvement acceptance
    command_id: ""
    result_path: ""
  execution_plan:
    - id: ""
      display: ""
      argv: []
      expected_exit_code: 0
      result: pass | expected_reject
      write_paths: [] # exact output paths owned by this step; [] for read-only checks
      artifact_refs: []
      claim_ids: []
      defeater_ids: []

roles:
  contract_owner: ""
  verifier_owner: ""
  implementer: ""
  acceptor: ""
  release_owner: null

environment:
  digest: "sha256:..."
  required: []
  matrix: []
  # Required when Critical evidence aggregates more than one platform:
  platform_evidence_authority: external-attestation-aggregator
  fingerprint_fields:
    - candidate revision and dirty state
    - lockfile/dependency digest
    - compiler/runtime/toolchain
    - build mode and feature flags
    - OS/architecture/container image
    - seed/clock/locale/timezone
    - fixture/data/reference revisions

test_discovery:
  manifest_digest: "sha256:..."
  expected: 0
  approved_skips: []
  shards:
    - id: all
      expected: 0

gates:
  fast: ""
  focused: ""
  broad: ""
  integration: ""
  merge: ""
  release: null

cutover:
  strategy: null # incremental | batch | big-bang
  completion: null
  rollback: ""

statistical_gate: null
# For probabilistic or performance evidence, see statistical-gates.md.

evidence:
  path: ""
  retention: ""
  invalidated_by:
    - claim or contract change
    - oracle, fixture, corpus, expected output, normalizer, tolerance, or threshold change
    - reference, dependency, lockfile, toolchain, build mode, or platform change
    - test discovery, shard, feature flag, security policy, data, or production configuration change

runtime_feedback:
  enabled: false
  signals: []
  permanent_corpus_path: null

stop_conditions:
  - required behavior is not observable
  - judge cannot reject a failure-model fault for the intended reason
  - same failure signature exhausts the repair budget
  - required claim or defeater remains unknown at the selected stage
  - protected scope or judge identity is compromised
  - evidence identity differs from the qualified identity
```

For a large, multi-wave behavior-preserving migration, add
`migration_profile: large_equivalence` and the immutable `migration_context` described in
[`large-migration-profile.md`](large-migration-profile.md). A bootstrap uses a protected inventory
producer; every batch uses a protected external runtime fencing producer and independently records
reference GREEN, semantic rejection, and parity; completion uses a protected reconciliation producer
for exact per-unit inventory closure, the integration snapshot, and the committed batch set. VDD
binds those facts but does not manage runtime leases or queues.

The reference control plane resolves a bare executable through the Contract-allowlisted
`PATH`; a relative executable containing `/` is resolved inside the copied workspace.
The resolved executable identity and effective allowlisted environment are fingerprinted.
For Improvement, `control_plane.metric_result.command_id` must name the final plan step,
and `result_path` must be both its declared artifact and an allowed output path.
Critical single-platform evidence binds the matrix key to the issuer runtime identity.
Critical multi-platform evidence must set
`environment.platform_evidence_authority: external-attestation-aggregator`, provide one
protected platform-result command per matrix entry, and retain one external attestation
digest per platform. The standalone linter validates those bindings; the external
control plane remains responsible for authenticating the platform attestations.

Every fresh no-change trial has a unique `stability_command_ids` entry whose plan step
runs the known-good command after restoration. The initial known-good and restoration
steps are not trials. Acceptance artifact fingerprints bind file content, type, and mode;
the complete snapshot manifest also binds material directory metadata. Absolute
source-workspace argv path elements are remapped into the copied snapshot, while an
embedded source-workspace path is rejected.

## Pinned real-upstream validation

For a reproducible validation against an external Git project, add a top-level
`source_provenance` declaration and pass the original checkout as
`vdd_accept.py issue --source-workspace`. The declaration pins the canonical `origin`
repository URL, immutable commit revision, and whether the checkout must be clean. The
control plane binds every candidate artifact to both its checked-out identity and the
fixed Git tree/blob, then repeats that check immediately before signing. Untracked,
ignored, index-only, or mid-run changes therefore cannot be presented as revision
provenance.

A Contract may additionally carry `real_upstream_workflow` with the same repository and
revision, explicit `focused_command_id`/`broad_command_id`, their protected upstream test
artifacts, and issuer platform. The IDs must name distinct execution-plan steps with distinct
`argv`; their declared artifacts must be both protected assets and bound to the pinned Git
tree/blob. Evidence requires both steps to pass. Never relabel a direct vector Oracle as a
broad upstream suite. Standard work still needs an honest separate `integration` command.
If the selected target has no integration boundary in scope, downgrade to Light or retain a
blocked Standard attestation rather than relabeling the focused test as integration.

## Mode-specific contract requirements

### Characterization

- Intent may remain `spec_dispute` only for an explicitly blocked characterization; an
  accepted characterization requires validated intent for the scoped baseline claim.
- At least one observable claim describes the boundary being characterized.
- The baseline names a known-good/minimal-valid run.
- Oracle qualification names at least one plausible known-bad result.
- Stability/no-change trials are recorded.
- The output is a reusable baseline, corpus, or judge—not a claim that implementation is
  complete.

### Construction

- Intent is `validated`.
- Each behavior slice has semantic RED at a callable public boundary before the real
  implementation.
- Bug fixes freeze the original production counterexample.
- Standard/Critical work identifies a real integration boundary.

### Equivalence

- Intent is `validated`.
- Reference behavior is classified as `accepted`, `corrected`, or `unknown`.
- Reference baseline is GREEN.
- A plausible semantic deviation is rejected before candidate parity is trusted.
- Candidate and reference receive identical semantic inputs.
- Cutover, caller updates, replaced-path deletion, and rollback are concrete.

### Improvement

- Intent is `validated`.
- Observable semantics are frozen before optimization.
- Semantic baseline is GREEN.
- A repeated no-change metric distribution, noise band, and minimum meaningful change
  are defined.
- Correctness and hard constraints precede the primary metric lexicographically.
- The optimized path has a discriminating fixture or instrumentation proving execution.

## Contract quality checks

A contract is not ready when any of the following is true:

- a claim is phrased only as internal implementation detail without an observable effect;
- a High/Critical claim has no plausible defeater;
- a covered defeater has no discriminating oracle or qualification fault;
- a reference implementation is accepted wholesale despite known bugs or unknowns;
- candidate workers can edit the judge, declare writable paths outside or above
  `scope.editable`, or indirectly alter truth through dependencies, discovery, CI,
  environment, or network;
- normalization or tolerance lacks measured nondeterminism/calibration;
- a benchmark can win by shrinking the workload or changing semantics;
- a destructive change has no restoration path;
- Standard/Critical acceptance is issued by the same write authority as the candidate;
- `unknown` is treated as pass rather than a blocker, narrowed contract, or accepted
  residual risk with a named owner;
- the Contract's environment digest was copied from a proposal instead of derived from
  the actual allowlisted process environment and command executables;
- evidence retention and invalidation conditions are absent.

## Minimal Light contract

```text
Mode/Profile: Construction / Light
Intent: validated by <owner/source>
Claim: slugify(" A  B ") == "a-b"
Plausible wrong result: repeated separators produce repeated hyphens
Judge: public API test <command>
Before: semantic RED <result>
After: focused GREEN <result>; nearest regression <result>
Protected truth: expected results/tests unchanged
Known limit: ASCII-only by contract
```
