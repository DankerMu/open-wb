# Delegation Contract

## Handoff to Missions

Create one bounded sealed Missions pack for an approved pilot, phase, or wave. Missions owns
the durable execution plan and is authoritative for execution status, retries, assignments,
recovery, review, and evidence ingestion.

`missions-v4-pack-request.json` is the static producer input. It binds:

```text
migration ID, selected manifest units, dependencies, and allowed target paths
G1 qualified judge artifact plus known-good, known-bad, and restoration obligations
G2 approval artifact, approver identity, and approval timestamp
manifest, source classification, route artifact, VDD binding, and optional playbook identities
per-unit QA flow artifacts under qa/, and the declared closed-world worker skill package
review policy and execution budgets for this bounded pack
```

Constraints the pack producer enforces. Satisfy them while writing the request rather than
discovering them at pack time; only the identifier *charset* — not the reserved names — is
also checked by `validate_artifacts.py`, so the rest surface for the first time at pack build:

- **Dependency closure.** Every dependency of a selected unit must itself be selected. A wave
  whose units depend on units migrated in an earlier pack must re-include that transitive
  closure in `plan.units`; the producer rejects the request otherwise.
- **Identifier charset.** Migration, unit, and behavior IDs must match
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — no spaces, no slashes. `judge-qualification` and any
  `validator.`-prefixed ID are reserved and rejected.
- **Closed-world skill package.** The declared `skillFiles` set must equal every regular file
  under `<program>/skills/<skillName>/`, must include that skill's `SKILL.md`, and may contain
  no symlinks.
- **QA flows.** Every selected unit declares its `qaFlows`, and each flow artifact lives under
  `qa/`.
- **Output placement.** The pack is written outside the target repository, to a path that does
  not already exist, with no symlink anywhere in the program, repository, or output ancestry,
  and with `.git` present as a plain directory (linked worktrees and submodules are rejected).
- **Size caps.** 8 MiB per artifact, plan, and envelope; 32 MiB aggregate.
- **Route-specific `routeArtifacts`.** The shipped JSON templates show the
  structure-preserving shape (`rulebook` + `gapInventory`). A same-stack uplift binds
  `deltaCatalog`; a redesign binds `behaviorCatalog` + `targetArchitecture`. Copying a
  template without switching this block is *not* caught by schema validation: the request
  carries no variant field and `routeArtifacts` is a `oneOf` over all three shapes, so every
  shape validates. The producer is what rejects it, by looking the manifest's `variant` up in
  its own route table at pack build.

The review policy bound into every pack requires the adversarial topology: two reviewers per
unit in separate, read-only contexts — assume the work is wrong, touch nothing — where every
finding cites a rule or a source line. A third agent rules on any disagreement, defaulting to
not-confirmed. Fixer agents apply confirmed findings only and flag what they cannot fix. The
machine layer records only `reviewPolicy.scrutiny` and a checklist; reviewer count and
arbitration are a contract on the executing runtime, not a producer-enforced invariant.

`build_missions_v4_pack.py` preserves the verified raw G2 approval in
`context/g2-plan-approval.json`, generates the strict `missions.approval.v1` runtime envelope
at `approval/execution-approval.json`, copies the other verified artifacts into `context/`,
creates the single runtime input `approved-plan.json`, and derives `MISSION_HANDOFF.md` as a
human index of pack/artifact identities and limitations. Missions reads only `approved-plan.json`
and its declared closed-world artifacts; it never reads the handoff index.

No migration artifact or index can contain queue position, worker identity, lease, retry, run,
attempt, mutable status, or next action. The producer does not decide a lease, retry, or worker
result. A material upstream amendment requires a new request, pack, and Mission.

`Mission ready` means that Mission's execution workflow reached its configured closure. It does
not independently establish behavioral equivalence, inventory completion, cutover, or release.

## Handoff to VDD

Use VDD before implementation to qualify the public/systems judge, and after a submitted
Mission result to independently accept the evidence.

For large multi-wave equivalence, bind VDD migration context to:

```yaml
migration_profile: large_equivalence
migration_context:
  program_id: MIG-001
  role: bootstrap | batch | completion | cutover | release
  program_generation: sha256:...
  source_reference:
    revision: git:<immutable-reference>
    inventory_digest: sha256:...
    baseline_digest: sha256:...
  dependency_graph_digest: sha256:...
  gap_inventory_digest: sha256:...
  migration_artifact:
    kind: rulebook | delta_catalog | behavior_catalog
    revision: rulebook@N | delta-catalog@N | behavior-catalog@N
    digest: sha256:...
  source_classification:
    revision: source-classification@N
    digest: sha256:...
  impact_index:
    digest: sha256:...
    soundness: conservative-transitive
    unknown_link_policy: invalidate
  candidate_snapshot_digest: sha256:...
```

Batch context additionally includes a batch ID, manifest digest, candidate base digest, lease
generation, and attempt. Add artifact-specific fields to VDD migration context only when VDD's
context model does not already carry the required protected asset, fixture, normalizer, or
external runtime producer identity; do not duplicate generic Mission handoff fields. The named
implementation runtime producer supplies these bindings; VDD verifies and attests submitted work.
VDD does not choose batches, dispatch workers, or mutate candidates.

## Degraded direct execution

When the user has explicitly chosen degraded direct-execution mode (no Missions runtime), the
coordinating session owns execution, and disk state is the only execution state:

- The queue is derived, never stored: pending work is every manifest unit whose target
  artifact does not yet exist on disk. Done means the output artifact exists and passes an
  emptiness/shape check — a zero-byte or placeholder output is not done, and that check runs
  before any batch is reported. Batches are rebuilt from disk each round, so stopping is free
  and resume is a re-invocation, not a recovery.
- Parallel producers write disjoint shards — one output path per worker or unit, never a
  shared appended file. The session merges deterministically (dedupe on stable keys, sorted
  output) and reports the merged count as a receipt.
- Progress invariant: each worker's on-disk output must grow between polls. Declare the poll
  interval and the stall window in the brief before fan-out — nothing enforces either, so the
  brief is the only place they become checkable — with three minutes of no new completed
  output as a serviceable default. A stalled worker is treated as failed: recover its completed
  rows, reissue the rest, and report the stall. Stalls are the session's to heal, not the
  user's to notice.
- Degraded mode has no Missions batch runtime, so G4's wave circuit breaker does not apply.
  The shape-checked output artifact is the check for burndown purposes; if no independent
  check runs per unit, say so rather than reporting a pass rate.
- This derives *execution* progress only. Manifest disposition still comes from the
  classification ledger and the protected inventory, never from path existence.
- Migration artifacts still carry no queue position, lease, retry, worker identity, or status
  field; the filesystem is the execution state and the artifacts remain domain facts.
- The degraded limitation stays recorded in the brief. Without VDD, direct execution produces
  candidate work and receipts, never parity, cutover, or release acceptance.

## Other skills

- Invoke `eng-init` when repository readiness or harness ownership is missing.
- Use `tdd` or `diagnosing-bugs` inside an accepted bounded work unit.
- Use `self-evolution` only for isolated candidate rule/catalog/prompt experiments with a frozen
  corpus and an objective oracle. Promotion is an explicit migration artifact amendment followed
  by review and pilot evidence.
