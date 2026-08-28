# Migration Variants

## Structure-preserving port

Use when the source implementation remains the primary specification during a language or
platform port. Build a source inventory, dependency graph, rulebook, gap inventory, and
accepted/corrected/unknown classification. Preserve architecture unless the brief explicitly
changes it. Use VDD Equivalence and differential/semantic oracles over identical inputs.

Units follow behavioral/dependency boundaries. Strongly connected components and shared seams
stay atomic under one owner. A compiler green result is an L0 signal, not parity.

Before any translation fan-out, stress-test the rulebook with a disposable shakedown on a few
high-risk files. Select those files by score, not taste: rank candidates by how many high-risk
rulebook sections and inventory rows they exercise, and record the scores and the rejections.
Run a dual-translation bakeoff: one translator follows the rulebook to the letter, another
translates the same files natively without ever seeing the rulebook, both outputs pass through
the target formatter so style noise never reaches the inspector, and a diff inspector turns
every remaining difference into a verdict on a rule — rulebook right, native right, both
defensible, or both wrong. "Native right" must stay sayable: a report where every difference
indicts a rule is as suspicious as one with none. Rehearse the production pipeline on the same files
exactly as the fan-out will run it, and grade obedience: every deviation must cite the rulebook
section it broke, because a correct output from an implementer that quietly ignored the rules is
a failed rehearsal. Throw away every translated file — the only surviving output is rule
amendments queued for the Contract Owner. This shakedown refines the plan before the G3 pilot
Mission; it produces no shippable evidence itself.

"Referee" means the mechanical in-loop check — typecheck, compiler, test runner. The
independent oracle that accepts evidence is always called the judge, and it never runs inside
an implementation loop. Every referee has a price, and the price decides its position in the
loop. A cheap typecheck
(seconds per unit) runs inside each unit's loop — a separate compile step dissolves into
translation. An expensive compiler is banned from the loop: one scripted survey build grades the
whole tree, its diagnostics are parsed into a machine queue sliced by module (leaves-to-root per
the dependency graph), and fixers write patches from the error text and source without compiler
access. One named build owner reruns the build once per round and publishes numbered outputs —
the most expensive operation is serialized under a single owner, never triggered independently
by parallel agents.

A translation-time UNKNOWN marker is not the classification ledger's `unknown` disposition.
The marker records an undecided *translation* and keeps the batch moving; the ledger's
`unknown` records an unresolved *source behavior* and blocks acceptance of every affected
parity batch. Never let one satisfy or clear the other.

UNKNOWN is an answer. When neither the rulebook nor the gap inventory decides a case, translate
to the most conservative representation the target offers, leave a greppable marker in the
format the rulebook names, and keep moving — a searchable artifact beats a stalled batch. The
markers are the queue for later steps: after parity, each burns down as its own flagged change
proved by a parity re-run, never bundled silently under the parity claim.

## Same-stack uplift

Use for framework/runtime/toolchain/dependency upgrades. Pin the exact source and target version
pair. Build a delta catalog whose entries name affected units, silent-behavior risks, required
checks, and disposition.

Weigh route fitness by touched sites, not delta count: one judgment delta can touch thousands
of sites, and a codebase-wide mechanical codemod is a de-facto rewrite. When the catalog forces
most of the tree to change, reclassify the route before planning waves.

Migrate test-harness prerequisites before production units when target validation otherwise cannot
run. Treat externally consumed libraries as an explicit transition decision. If only the target
runtime is available, state `target-only` and do not imply dual-run parity. VDD Characterization
must establish and qualify the target baseline before implementation; implementation is accepted
under VDD Construction against that baseline. Characterization alone never accepts the
implementation. Pilot first, update the playbook, then progress in dependency-aware waves with a
circuit breaker when wave quality drops.

## Redesign or strangler

Use when target boundaries or behavior intentionally change. First approve target architecture and
make a behavior catalog. Slice by observable vertical capability, not source files. Preserved
behavior uses Equivalence; intentional changes use separate VDD Construction claims.

Do not use a line-for-line translator bakeoff — for a redesign the diff measures the redesign,
not the rules. Validate the design document directly instead: adversarial reviewers attack the
design itself, and disposable end-to-end runs replace the bakeoff as the rule-refinement loop —
run the whole migration cheaply, review what came out, revise the design, and throw the run
away. A temporary compatibility
adapter requires explicit ownership, removal trigger, and rollback purpose; it cannot silently
become the production fallback.

## Not a codebase migration

For a small local conversion or incremental refactor, skip migration artifacts and Missions.
Use TDD or a normal VDD objective at the smallest relevant public boundary.
