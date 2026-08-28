# Migration Lifecycle and Gates

`code-migration` owns phase definitions and domain artifacts. Missions owns work execution;
VDD owns independent qualification and acceptance. No phase advances because source or target
files merely exist.

## Lifecycle

```text
G0 Proceed
→ G1 Judge qualified
→ G2 Plan approved
→ G3 Pilot accepted
→ G4 Wave accepted (repeat)
→ G5 Completion and cutover accepted
→ G6 Release accepted
→ Post-parity work under separate objectives
```

## G0 — Proceed

Create `FEASIBILITY.md`. Record source/target versions, source authority, scope and exclusions,
external consumers, runnable build/test census, reference survivability, candidate oracle, scale
band, rollback feasibility, selected variant, and `proceed | defer | do-not-proceed` decision.

The Contract Owner also decides the model plan at this gate, and it binds every later phase.
Tier by blast radius, not task prestige: route-artifact authorship and amendments — rulebook,
delta catalog, or behavior catalog — use the largest available model, because one wrong entry
replicates into every unit that entry governs; skeptic and
adversarial reviewers use the largest or mid tier; high-volume translation implementers use a
mid or small tier; fixers use a mid tier. Token spend concentrates in loops, and a mechanical
referee stands behind the implementers, so the fan-out is where a smaller model pays.

Estimate cost as a visible multiplication — units of work × per-unit estimate × review topology
(implementer, reviewers, and fixer per unit) × referee price — and report it in banded,
order-of-magnitude ranges; a precise number is forbidden, because precise predictions will be
wrong and erode trust. During execution, report progress as mechanical burndown counts from the
work queue, never narrated prose. Append one row per gate to `cost-log.tsv` in the program
directory — tab-separated `step`, `timestamp`, `wall_clock_min`, `tokens`, `agents`, `model`,
with `unknown` where a value cannot be measured — and end every gate report with a banded
duration estimate for the next phase derived from the counts just measured. Record the model
plan and the banded cost estimate in `FEASIBILITY.md` at this gate.

A feasibility report is not approval. The Contract Owner approves the decision to proceed.

## G1 — Judge qualified

Invoke VDD Characterization or the pre-change portion of an Equivalence contract. A qualified
judge has a known-good pass, plausible known-bad rejection for the intended semantic reason,
restoration pass, and appropriate stability evidence. Protect inventory scanners, fixtures,
normalizers, reference revision, thresholds, discovery, and signing authority.

Debug the judge before believing its verdicts: a judge that fails everything is usually
broken, not strict, and a first parity run's failures indict the harness before they indict
the candidate. A characterization baseline is the oracle recorded in a file, not in anyone's
head, and it records every check's result — including checks the reference itself fails.
Equivalence means reproducing the baseline, failures included, not making everything pass.

When the judge is built from existing tests, first categorize them: portable tests exercise the
public surface and can run against both implementations; internal-bound tests stay behind
because they import internals that do not survive the move — a dying language on a port, a
removed framework API on an uplift, a replaced module boundary on a redesign. Rewrite the
portable tests into assertions that
run against both sides through the external interface, and have adversarial reviewers in
separate contexts verify that no rewrite weakened an assertion — no loosened tolerance, no
dropped field, no truthy check where the original checked an exact value. A confirmed weakening
is a bug in the rewrite, not in the reviewer.

Only durable translation fan-out waits for the judge. Discarded-output stress-test
mini-migrations are exempt: run small samples in parallel while the judge is being qualified,
use them to refine the rulebook and the plan, and delete their outputs.

When the only missing qualification evidence is environment-bound — a device window, an
external runtime, a long-run stability soak — qualify the judge provisionally: record the
exact missing evidence as named debt in `MIGRATION_BRIEF.md`, ask the user to choose wait /
degraded evidence / risk acceptance, and let G2 plan approval and stress testing proceed.
A provisional qualification emits no G1 gate artifact — that artifact's only valid verdict is
`qualified`, and the producer refuses a pack without it, so the missing artifact is what
mechanically blocks sealed-pack production and durable fan-out. Do not write a provisional
verdict or a debt field into `evidence/g1-judge-qualification.json`; the gate schema is closed
and will reject it.

The gate artifacts are pack-production inputs, not the approval itself. G2 is reached when the
plan artifacts are finished and the Contract Owner approves the plan; that approval is recorded
with its real date in `MIGRATION_BRIEF.md`'s approval block.

On both paths the JSON pair is written when a pack request for a given pilot, phase, or wave
exists — never at plan-approval time, because the pair binds that request's selected units and
its repository baseline, neither of which exists yet at G2. What differs is only what
`approvedAt` means. With the judge already qualified it is the approval of that pack's plan.
Under a provisional qualification it records the Contract Owner re-affirming the then-current
plan against the now-qualified judge, no earlier than `qualifiedAt`, as the producer requires.
Never backdate `approvedAt` to the brief's date, and never move the brief's date to match it.
If the plan changed materially in between, that re-affirmation is a fresh approval decision,
not a signature on the old one, because a prior approval cannot authorize an amended request:
record it as a new dated entry under a new brief revision, leaving the original entry intact.

Until that pair exists its absence blocks pack production only — never planning, and never the
plan-approval decision.

## G2 — Plan approved

Freeze a revisioned manifest and classification ledger. Complete the route-specific artifacts:

- structure-preserving port: rulebook and gap inventory;
- same-stack uplift: exact version pair and delta catalog;
- redesign/strangler: behavior catalog and approved target architecture.

For a structure-preserving port the rulebook comes before the gap inventory: the inventory is
defined by what the rulebook's defaults will not cover. Accept the two together through a joint
audit — adversarial reviewers read the rulebook and the inventory against each other and hunt
contradictions, and every conflict must name the rule, the row, and the concrete translation
that goes wrong. Rulebook amendments are queued for the Contract Owner and applied between
Missions, never self-applied inside a loop and never absorbed by a sealed pack. An amendment
is material — and therefore requires a new request, pack, and Mission — when it changes a
canonical mapping, an escape-marker format, a path or naming rule, an exclusion decision, or
any obligation an already-dispatched unit was translated under; a purely editorial change that
alters no unit's required output is not material and needs no new pack. Execution guardrails — command denies on
compilers, test runners, and destructive version-control commands inside loops — are installed
by the human at plan approval, because installation is the moment the referee price is
decided; an agent that can compile starts optimizing for the compiler instead of the rulebook.
Loop agents never install, edit, or route around guardrails, and a loop diff touching the
rulebook or the guardrails is an automatic finding.

Where the route defines a rule-refinement shakedown, G2 acceptance also requires that it has
run and its amendments have been applied: the disposable bakeoff for a structure-preserving
port, the disposable end-to-end run for a redesign. Its outputs are discarded; the amendment
queue is the deliverable. `same-stack-uplift` defines no pre-G2 shakedown — its delta catalog
is refined by the G3 pilot and playbook instead — so this criterion does not apply there.

The plan names unit boundaries, dependency order, shared-seam owners, pilot set, VDD contracts,
Mission handoffs, cutover, rollback, external-consumer policy, unknowns, and invalidators.
Source-classification unknowns block acceptance of every affected parity batch; a stage-scoped
risk-acceptance assertion cannot override that block. Human approval is required before
implementation work starts.

## G3 — Pilot accepted

Use a representative pilot, not a disposable happy path. It should exercise routine behavior,
high-risk semantics, and a shared seam or platform concern when applicable.

1. Build one sealed v4 pack from an approved `missions-v4-pack-request.json`; its G1 judge
   qualification and G2 approval bindings must be present before the producer can emit output. The
   producer emits a strict runtime approval envelope and retains the raw G2 artifact as immutable
   context provenance.
2. Have Missions validate and admit `approved-plan.json`; `MISSION_HANDOFF.md` is only a derived
   human index and is not a runtime input.
3. Let Missions complete its own implementation/testing/review workflow.
4. Run VDD independent acceptance over the submitted snapshot.
5. Update `PILOT_PLAYBOOK.md` and upstream artifacts before any next wave.
6. A material amendment starts a new pack and Mission and requires the appropriate reapproval.

## G4 — Wave accepted

Create dependency-aware waves only after pilot acceptance. A wave is a collection of independent,
reversible units; shared or cross-cutting seams have one explicit owner. When integration or
verifier throughput becomes the bottleneck, plan a smaller next wave and ask the runtime owner
to lower WIP; concurrency, stopping, and resuming are the runtime's, not this skill's.

"Batch" means two different things here and they are not interchangeable: a fan-out batch is a
group of units dispatched together inside one wave, and a VDD `batch` is an attestation stage
bound to one candidate snapshot. One wave may contain many fan-out batches and still submit a
single VDD batch attestation.

Fan out in escalating batches — small first, growing only while quality holds — and judge the
circuit breaker per batch, never cumulatively: healthy early batches must not mask a batch that
has started failing. A unit counts as built only when its check actually ran and succeeded;
self-reported success is not evidence. Dependents of a failed unit are not attempted — they
would fail for the dependency's reason and falsely trip the breaker. Trip when a batch's
measurable pass rate falls below two-thirds — count only units whose check actually ran, and
declare the minimum batch size below which the ratio is not evaluated. A batch where nothing
could run its check at all is an environment fault, not a playbook fault. After a trip, queue
the observed gaps as playbook/rulebook amendments; a playbook-only amendment may resume the
same Mission, while a material rulebook amendment requires a new pack and Mission per G2.
Re-verify the fix on one failed unit before resuming, and report remaining, failed, and
blocked units as re-passable lists, never as a merged "attempted" total.

For `large_equivalence`, the required VDD stages are:

| VDD stage | What it attests | What it does not attest |
|---|---|---|
| `bootstrap` | Protected independent inventory/reference/rule baseline. | Any candidate implementation. |
| `batch` | One batch bound to its candidate snapshot, rulebook, manifest and fencing fields. | Whole-program completion or cutover. |
| `completion` | Inventory closure over authenticated batch evidence and current rule lineage. | Production caller cutover or release. |
| `cutover` | Controlled callers moved, production legacy paths removed, rollback exercised. | Canary/production threshold success. |
| `release` | Release gates, owner, thresholds, rollback trigger, authenticated cutover parent. | Future defect absence. |

Missions does not issue any of these attestations. VDD does not dispatch or retry a wave.

## G5 — Completion and cutover

Order behavior evidence cheap-to-expensive. Before any full judge run: hello world, then the
smallest end-to-end smoke command the target supports. Smoke failures are a mechanical queue,
grouped by root cause, and burn down before the expensive judge runs. Only after smoke is
clean do you shard and run the full judge across the inventory. The judge run carries a control
leg: run the same checks against the immutable reference at the reference revision, so
inherited failures are classified rather than counted against the candidate, and report both
counts in the completion evidence.

Completion is an inventory closure decision, not a file count. A protected scanner establishes
expected units; the completion result accounts for each unit as accepted, explicitly excluded by
a named decision, or blocked. Accepted completion has no unresolved/unknown required entries.

Manifest-level exclusions are currently defined only for the `structure-preserving-port` route:
an excluded unit declares `excluded: { "decisionRef": "rulebook@N" }` naming a real
`### rulebook@N` revision heading in `RULEBOOK.md`, and `validate_artifacts.py --rulebook`
verifies that the named decision exists. The other route variants have no revisioned
name-bearing catalog with a defined decision-reference format yet; until one exists, exclusions
for `same-stack-uplift` / `redesign-or-strangler` manifests are rejected by the validator with an
explicit message, and the workflow's "explicitly excluded by a named decision" accounting for
those variants must be expressed through their delta/behavior catalog instead. Extending the
exclusion disposition to those routes requires defining a decision-reference format and the
catalog heading convention first.

Cutover is separate. It proves caller migration, legacy production-path removal, zero legacy
runtime dependencies within declared scope, and a rehearsed restoration route. A permanent
production fallback to the old implementation is not completion.

## G6 — Release and post-parity

Release requires VDD release evidence, a Release Owner, operational thresholds/canary or shadow,
and rollback trigger. The authenticated parent is the accepted cutover evidence for migration
profiles, not a prose assertion.

Deferred bug fixes, performance work, and redesign follow-up are separate Construction or
Improvement objectives. They may reuse qualified oracles only when identity bindings remain valid.
