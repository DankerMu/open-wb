# Migration Artifact Contract

Artifacts are durable facts, decisions, and reproducible inputs. They are not a second task
runtime: do not add queue position, assignment, retry counters, worker identities, lease state,
or next-action fields to the migration manifest.

## Authority and placement

Keep a migration program under one root such as `migration/`. The program manifest identifies
source/target scope and units; Missions records execution state; VDD records accepted evidence.

| Artifact | Authority | Purpose |
|---|---|---|
| `FEASIBILITY.md` | Contract Owner | Evidence for/against starting the migration. Each inbound external consumer carries one decision: `multi-target` (serve both stacks during transition), `expand-scope` (migrate the consumer too), or `accept-break` (accept the breakage under a named owner). |
| `MIGRATION_BRIEF.md` | Contract Owner + approval | Objective, non-goals, variant, phase graph, consumers, cutover, rollback. |
| `manifest.json` | code-migration domain | Revisioned unit/dependency/source-target map; validates together with the classification ledger through `tools/validate_artifacts.py`. |
| `source-classification.json` | Contract Owner | Accepted/corrected/unknown reference behavior; validates together with the manifest through `tools/validate_artifacts.py`. |
| Rulebook / delta / behavior catalog | Migration domain | Translation, uplift, or redesign decisions. |
| `TARGET_ARCHITECTURE.md` | Contract Owner + approval | Approved target architecture; required by the producer on the `redesign-or-strangler` route. |
| `vdd/migration-binding.json` | VDD | Bound VDD contract identity for this program; digest-verified by the producer. |
| `cost-log.tsv` | code-migration domain | Append-only per-gate ledger: `step`, `timestamp`, `wall_clock_min`, `tokens`, `agents`, `model`; `unknown` where a value cannot be measured. |
| `gap-inventory.tsv` | Migration domain | Structure-preserving ports only: every site the rulebook's defaults do not decide. Column contract below. |
| `PILOT_PLAYBOOK.md` | Migration domain | Reusable pilot learnings, commands, limits, amendments. Its `Decision` field is `expand` (proceed to waves), `amend-and-repeat` (apply amendments, rerun the pilot), or `stop`. |
| `missions-v4-pack-request.json` | code-migration domain | Static request binding G1 qualification, G2 approval, unit scope, VDD binding, and context identities for one sealed v4 pack. |
| `MISSION_HANDOFF.md` | code-migration → humans | Derived index for one sealed v4 pack; never a Missions runtime input or state authority. |
| VDD Contract/Evidence | VDD | Qualified oracle and independently accepted evidence. |

## Gap inventory columns

Nothing parses this file: the producer copies and digests it by name, so the column contract
below is a convention held by reviewers, not a rule any tool refuses. Tab-separated, one row
per site, header exactly:
`unit file symbol source_construct gap_kind target_translation evidence decision_owner status`.

| Column | Contents |
|---|---|
| `unit` | Manifest unit ID that owns the site. |
| `file` | Source path, relative to the source root. |
| `symbol` | Function, type, or member the site belongs to. |
| `source_construct` | The construct the rulebook does not decide, in source vocabulary. |
| `gap_kind` | Why it is a gap — a project-defined category such as `no-equivalent`, `ownership`, `lifetime`, `error-model`, `platform`. Deliberately not called "classification": that word belongs to `source-classification.json`'s dispositions and the two must never satisfy each other. |
| `target_translation` | The decided target representation, or the conservative fallback for an `unknown` row. |
| `evidence` | `file:line` citations that justify the row. |
| `decision_owner` | Who owns the call for this row. |
| `status` | `confirmed` or `unknown`. An `unknown` row still carries the most conservative target representation plus the rulebook's greppable marker, and it does not block a batch — only the ledger's `unknown` disposition does that. |

## Provenance rules

Every artifact revision must name the immutable reference revision, its source authority, and an
invalidation list. Handoffs bind artifact digests, rather than trusting a mutable filename.

A material change to source inventory, source classification, dependency graph, reference
revision, fixture/oracle, rulebook/delta/behavior catalog, target toolchain, candidate snapshot,
or cutover policy invalidates dependent plans and VDD evidence. Preserve the old evidence; issue
a new revision rather than overwriting history.

## Inventory and classification

The source inventory is a protected scanner result, not a list created by the worker runtime.
Every unit has a stable ID and source/target paths. Do not use path existence as the disposition.

Inventory scanners and dependency mappers are deterministic scripts, never agent judgment: a
nondeterministic artifact cannot be verified. Qualify each script against a known fixture
before first use, and make it fail loudly on implausibly clean output — zero edges across
multiple files is a wrong map that looks like a clean map. Review the generated result with
independent samplers; a confirmed discrepancy is a bug in the script, not an edit to the map.
Fix the script for the pattern, regenerate the whole artifact, and re-review with fresh
samples and fresh reviewers. After three failed review rounds, or when the same discrepancy
category recurs, stop patching and bring the owner the misses themselves: dependencies that
are not statically discoverable are an owner decision, not another script patch.

`source-classification.json` records reference behavior as:

- `accepted`: target must preserve the named observable behavior;
- `corrected`: target deliberately differs under a named decision owner;
- `unknown`: must declare `blockingStage: batch` (not `release`) and blocks acceptance of every affected parity batch until the source behavior is resolved and the classification artifact is revised. A stage-scoped risk-acceptance assertion cannot make an unknown source behavior acceptable for parity.

## Conservative rule changes

A rulebook/catalog amendment is a new revision. Before a separately protected, qualified impact
oracle exists, assume it affects the entire dependent lineage: fresh bootstrap/pilot evidence is
required. Never use a candidate-supplied list of “unaffected” units as evidence for selective
reuse.

## Artifact validation

Run the bundled semantic validator from the skills root before approving a plan or issuing a
Mission handoff:

```bash
python3 code-migration/tools/validate_artifacts.py \
  --manifest migration/manifest.json \
  --classification migration/source-classification.json \
  --rulebook migration/RULEBOOK.md
```

The `--rulebook` argument is required whenever any unit carries the `excluded` disposition
(`excluded: { "decisionRef": "rulebook@N" }`): the validator resolves each decisionRef
against the `### rulebook@N` headings in `RULEBOOK.md` so an exclusion can only be authorized
by a real rulebook decision. A rulebook with no revision headings makes every exclusion
unverifiable and is rejected. The `excluded` disposition is currently defined only for the
`structure-preserving-port` route.

The command validates both Draft 2020-12 schemas and their cross-document invariants: unique
behavior and unit IDs, migration/reference identity, resolved acyclic dependencies, no self- or
duplicate dependency, a complete one-or-more-unit assignment for every classification ID,
canonical non-overlapping physical unit paths across the source and target systems,
source/target root containment, namespace-scoped include/exclude scope, the Missions-safe
identifier charset `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` (reserved Feature-ID names remain the
producer's to reject), and the `blockedBy` rules: a unit carrying no `classificationIds` must declare
`blockedBy`, `blockedBy` and `excluded` are mutually exclusive, and no non-excluded unit may
depend on an excluded unit. A `blockedBy` unit is a known-but-unresolved unit; the producer
refuses to schedule one into a pack. Each unit also lists its `artifactRefs` — the source
documents that justify it — which the tools carry but do not interpret.

The manifest records `scope.source` and `scope.target` separately; an
exclusion in one namespace never applies to the other. Independent system scopes may share a
checkout, but paths assigned to separate units must still be physically disjoint. Dependency
cycles must first be collapsed into an explicit `scc` unit.
Do not replace this command with syntax-only JSON checks or hand-edit a schema to make a candidate
pass.

## Sealed Missions v4 pack production

For every approved pilot, phase, or wave, add a static `missions-v4-pack-request.json` to the
program. It binds the selected manifest units, explicit G1 known-good / known-bad / restoration
judge qualification, G2 approval identity, route artifact, VDD binding, and optional pilot
playbook. It carries no queue, lease, retry, worker, status, attempt, or next-action fields.

Use `templates/G1_JUDGE_QUALIFICATION.json` and `templates/G2_PLAN_APPROVAL.json` for the gate
artifacts. They are strict proof records: G1 must bind the qualified three-step judge and current
manifest/classification/route/VDD identities; G2 must bind that exact G1 digest and every selected
plan field. The producer rejects a stale or merely digest-valid gate artifact.

Build exactly one new output directory after the migration artifacts validate:

```bash
python3 code-migration/tools/build_missions_v4_pack.py \
  --program migration \
  --output /outside-the-repository/migration-pilot-pack \
  --repository /absolute/canonical/repository
```

The producer copies only declared digest-verified source files into the closed pack, emits
`approved-plan.json`, and derives `MISSION_HANDOFF.md` as a human-readable index. It generates
the strict runtime approval envelope at `approval/execution-approval.json` and preserves the
raw `code-migration.g2-plan-approval.v2` bytes unchanged at `context/g2-plan-approval.json` for
provenance. The runtime envelope binds the generated Plan subject without including the Plan
content digest or its own artifact identity, so no digest cycle is introduced. The index is not
read by Missions. It may name pack and artifact identities plus limitations, but must not
contain runtime state. The producer refuses to create a pack without G1/G2 bindings, valid
manifest/classification semantics, all selected dependencies, matching artifact digests, or a
canonical repository baseline. It also refuses an output path that already exists, a symlink
anywhere in the program/repository/output ancestry, a `.git` that is not a plain directory,
an artifact over 8 MiB or a pack over 32 MiB, and any platform without atomic no-replace
rename. A material source artifact amendment must create a new request, pack, and Mission.

The producer additionally depends on the Missions runtime's approval-envelope schema, which
lives outside this skill's directory. Verify that dependency resolves in the current layout
before promising a pack; the skill is not self-contained on this point.
