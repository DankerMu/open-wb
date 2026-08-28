# Large Equivalence Migration Profile

Use `migration_profile: large_equivalence` only for a multi-wave, behavior-preserving code
migration. It is an **acceptance protocol**. It does not schedule workers, manage queue state,
grant leases, retry work, merge patches, or execute cutover. `code-migration` owns migration
artifacts and phase gates; Missions or another durable runtime owns execution and leases.

## Contract context

Every stage contract is Equivalence at Standard or Critical risk and carries one immutable
`migration_context`:

```yaml
migration_profile: large_equivalence
migration_context:
  program_id: MIG-001
  role: bootstrap | batch | completion | cutover | release
  program_generation: sha256:...
  source_reference:
    revision: git:legacy@...
    inventory_digest: sha256:...
    baseline_digest: sha256:...
  # The same source_reference is copied into every migration Evidence record.
  dependency_graph_digest: sha256:...
  gap_inventory_digest: sha256:...
  migration_artifact:
    kind: rulebook | delta_catalog | behavior_catalog
    revision: rulebook@... | delta-catalog@... | behavior-catalog@...
    digest: sha256:...
  source_classification:
    revision: source-classification@...
    digest: sha256:...
  impact_index:
    digest: sha256:...
    soundness: conservative-transitive
    unknown_link_policy: invalidate
  candidate_snapshot_digest: sha256:...
  batch: # required only for role=batch
    id: B-001
    manifest_digest: sha256:...
    lease_generation: 1
    attempt: 1
    candidate_base_digest: sha256:...
    fencing:
      authority: missions-runtime
      record_digest: sha256:...
      batch_id: B-001
      lease_generation: 1
      attempt: 1
      candidate_base_digest: sha256:...
      submitted_snapshot_digest: sha256:...
```

The control plane derives `candidate_snapshot_digest` from the exact copied candidate artifact
snapshot; a proposal label is not sufficient. Changes to the migration artifact, source
classification, or source inventory invalidate dependent evidence. Until a separate protected impact oracle is qualified, unknown
dependency links invalidate rather than permit selective reuse.

## Protected producers

- **Bootstrap** requires `control_plane.migration_inventory_result`, produced by a protected
  scanner. Its output is exactly `{scan_digest, expected, discovered, unit_ids}`; `unit_ids` is the
  unique canonical inventory used later for reconciliation. The control plane replaces proposal
  inventory values wholesale and rejects missing or extra fields.
- **Batch** requires `control_plane.migration_fencing_result`, produced by a protected runtime
  authority. Its output is exactly `{authority, record_digest, batch_id, lease_generation,
  attempt, candidate_base_digest, submitted_snapshot_digest}`. The protected runtime assertion
  must name the exact submitted candidate snapshot that VDD accepts, so a stale or substituted
  workspace cannot inherit a valid lease. A batch may build from the accepted bootstrap or one
  directly authenticated preceding batch; the runtime remains the only lifecycle owner of leases.
- **Completion** requires `control_plane.migration_completion_result`, produced by a protected
  reconciliation authority. Its output includes the inventory counts, per-unit dispositions,
  disposition digest, impact-index digest, integration snapshot digest, unresolved-impact count,
  and committed batch-attestation set. Every excluded unit carries a named decision reference and
  owner. VDD replaces proposal completion values wholesale, then verifies exact closure against
  bootstrap `unit_ids`, authenticated direct batch parents, and the accepted integration snapshot.

Each producer path is a protected asset and each producer command/result path is unique and cannot
be reused as an oracle stability trial. Candidate-supplied inventory, fencing, reconciliation, or
snapshot data is never evidence.

## Lifecycle and evidence

```text
bootstrap
  → batch (one or more independently accepted slices)
  → completion
  → cutover
  → release
```

- `bootstrap` has no parents and establishes the independently scanned source inventory.
- `batch` has exactly one accepted `bootstrap` or preceding `batch` parent; its
  `candidate_base_digest` must equal that parent’s issuer-derived candidate revision, while the
  protected fencing result binds the exact submitted snapshot. It must include reference GREEN, a
  semantic deviation rejection, and parity commands over identical semantic inputs.
- `completion` has exactly one bootstrap parent plus every batch parent it summarizes. Its
  `batch_attestations` list must exactly equal those authenticated batch parent `(ID, digest)`
  pairs, its integration snapshot must be the accepted candidate snapshot, and its dispositions
  must exactly cover bootstrap `unit_ids`. An accepted completion has a closed inventory and
  **zero** `blocked`, `unresolved`, `unknown`, and `unresolved_impact_links` entries.
- `cutover` has exactly one accepted completion parent and independently proves caller migration,
  legacy-path removal, and rollback exercise.
- `release` has exactly one accepted cutover parent. It separately binds protected release facts,
  canary/shadow evidence, thresholds, rollback trigger, and Release Owner. Migration release uses
  its cutover parent, not a legacy merge parent.

Parent documents are signature-verified and their full `(ID, digest, stage, status, contract
fingerprint, candidate revision)` references must exactly match the child evidence. This prevents
an attester from swapping a valid parent’s digest or stage after authentication.

## Issuance and verification

Supply each direct parent to the reference control plane with repeatable
`--migration-parent-attestation <path>` arguments. The tool verifies signatures, expiry, parent
stage, source/migration-artifact/source-classification/graph/impact identities, proposal references, and stage-specific snapshot
continuity before issuing or verifying an attestation.

The reference HMAC implementation demonstrates canonical binding only. Production issuance
requires independently controlled CI/KMS signing and an authenticated runtime producer.
