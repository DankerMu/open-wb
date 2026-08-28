---
name: vdd
description: >-
  Use when software work must be governed by executable evidence: new behavior or
  bug fixes, behavior-preserving refactors, ports, migrations, measurable
  improvements, verifier or observability construction, verification-governed
  operating plans, audit closure, or repair of compromised validation evidence.
  Also use when the user explicitly asks for VDD, verification-first, oracle-first,
  self-verifying, or self-healing development. Do not use for pure explanation,
  non-software artifacts, ordinary review with no implementation or verification
  deliverable, or trivial coding where the user did not request VDD and ordinary TDD
  is sufficient.
version: 0.1.0
---
# Verification-Driven Development (VDD) v0.2

Make executable assurance the control plane for software work.

## Large migration profile

For multi-wave, behavior-preserving migrations, use the optional Equivalence-only
`migration_profile: large_equivalence`. It binds a protected source reference (revision, inventory,
and baseline identities), source inventory, dependency and gap identities, migration artifact and source-classification revisions, conservative
impact policy, candidate snapshot, and batch fencing fields. Batch fencing is a protected runtime assertion from Missions or another
external authority: VDD verifies and records it, but never grants or renews leases. It issues
distinct `bootstrap`, `batch`, `completion`, `cutover`, and `release` attestations with
authenticated parent references.

The profile is an **acceptance protocol**, not a migration runtime. VDD does not select batches,
assign workers, operate leases, retry work, merge patches, or schedule cutover. An external
orchestrator may submit those facts; VDD verifies protected producers and binds them to evidence.
Use the `code-migration` Skill to own migration artifacts and handoffs, and Missions (or another
runtime) to own durable execution.

For safe initial adoption, a migration artifact, source-classification, or source-inventory change
invalidates the dependent lineage. Selective reuse is not valid until a separately protected,
qualified impact oracle proves the scope; candidate-supplied unaffected-unit lists are not evidence.
Each accepted batch carries reference GREEN, semantic-deviation rejection, parity evidence, and a
protected runtime assertion that binds its exact submitted snapshot. A protected reconciliation
producer closes completion against bootstrap inventory unit IDs, exactly one authenticated bootstrap
parent, exact authenticated batch parents, and the accepted integration snapshot with zero blocked, unresolved, unknown, or unresolved-impact
units. Every excluded unit requires a named decision and owner.
Cutover and release remain separate attestations. See
[`references/large-migration-profile.md`](references/large-migration-profile.md) for the exact
contract fields, protected producers, lifecycle, and parent-verification requirements.

> **Self-verifying execution, independently governed acceptance.**
>
> A candidate may run checks, preserve counterexamples, diagnose failures, and repair
> itself. It may not control the definition of truth, the protected judge, or the
> final acceptance attestation.

The loop is not “generate, then test.” It is:

```text
validate intent
→ declare claims and defeaters
→ build and qualify an oracle portfolio
→ capture the mode-specific baseline
→ slice work
→ implement and actively falsify
→ diagnose and repair
→ independently accept
→ attest evidence
→ feed production counterexamples back into the corpus
```

VDD does not prove arbitrary software perfect. Evidence is always relative to declared
claims, oracle sensitivity, environments, assumptions, and time. Report those limits;
do not claim absolute correctness, zero defects, or “zero slop.”

## 1. Four governing modes

Choose the mode whose acceptance rule matches the work. Do not force every task into a
Construction-style RED/GREEN ritual.

| Mode | Use for | Required pre-change evidence | Acceptance gate |
|---|---|---|---|
| **Characterization** | observability, fact corpus, golden data, verifier construction, migration discovery | known-good GREEN, discriminating known-bad RED, stability/noise baseline | observable baseline + qualified judge + explicit unknown ledger |
| **Construction** | features, APIs, services, and bug fixes | validated intent + semantic RED at a public boundary | acceptance claims + required real boundary + hard constraints pass |
| **Equivalence** | behavior-preserving refactors, ports, migrations, replacements | accepted reference GREEN + plausible wrong candidate/mutant RED | candidate matches accepted behavior + approved corrections + complete cutover |
| **Improvement** | performance, memory, size, cost, throughput | semantic baseline GREEN + repeated metric baseline/no-change control | semantic and hard constraints pass before calibrated metric gate |

A Bug fix is Construction: the frozen production counterexample is the semantic RED.
Characterization may be an independent deliverable or a prerequisite for another mode.

## 2. Scale the method to risk

Choose a profile before changing code; upgrade it when new uncertainty appears.

- **Light:** low-impact, local, well-understood behavior. One public check, the nearest
  regression, protected expected results, and concise evidence are usually enough.
- **Standard:** crosses storage, network, process, filesystem, UI, schema, or another
  real boundary; or contains material semantic uncertainty. Add a failure model,
  multiple discriminating cases, a real integration, environment identity, and an
  acceptance run outside candidate write authority.
- **Critical:** authorization, money, deletion, irreversible data, migrations,
  concurrency, protocols, security, safety, or high oracle/environment uncertainty.
  Add independent acceptance, broad fault coverage, platform/hardening checks,
  rollback/restore evidence, durable attestation, and a separate release gate.

Verification strength follows failure cost **and epistemic uncertainty**, not line count.
Do not demand formal proof for a formatter; do not accept one mocked unit test for money
movement or destructive migration.

## 3. Validate intent before verifying implementation

Verification asks whether a candidate satisfies a declared contract. Validation asks
whether the declared contract represents the right outcome. Record, at minimum:

```text
intent owner and source authority
positive examples and negative examples
critical scenarios and irreversible decisions
ambiguities, unknowns, and explicit decisions
```

Treat the specification as a revisable executable hypothesis, not infallible truth. If
implementation or evidence exposes a conflict, enter `SPEC_DISPUTE`:

```text
stop candidate edits
→ preserve evidence
→ obtain the domain decision
→ revise claims/contract
→ invalidate affected evidence
→ re-qualify affected judges
→ resume
```

Construction, Equivalence, and Improvement require validated intent. Characterization
may proceed under `spec_dispute` or `blocked` intent only to resolve named unknowns; it
cannot issue accepted characterization evidence until the scoped intent is validated.

## 4. Build an executable assurance case

For Standard and Critical work, each consequential statement follows this graph:

```text
Claim
  → Defeater / plausible failure
  → Oracle(s)
  → Oracle qualification
  → Evidence
  → Scope and assumptions
  → Expiry / invalidation conditions
```

Use [`references/contract.md`](references/contract.md) for the full objective contract
and [`references/failure-model.md`](references/failure-model.md) for the defeater map.
For Light work, an inline record is enough:

```text
mode + profile
observable claim
plausible wrong result
focused judge
pre-change evidence
green evidence
nearest regression
known limit
```

Rules:

1. Claims are observable at a public or operational boundary.
2. High/Critical claims name plausible defeaters rather than merely listing examples.
3. Every covered defeater maps to at least one discriminating oracle.
4. An uncovered defeater is `unknown` or an explicitly accepted residual risk with a
   named owner; it is never silently treated as pass.
5. A reference implementation is evidence, not automatic truth. Classify observed
   legacy behavior as `accepted`, `corrected`, or `unknown`.

## 5. Select an oracle portfolio, not a test-count target

An oracle is a reproducible mechanism that can accept or reject a candidate against a
claim. Unit tests, differential execution, properties, metamorphic relations, formal
models, static checks, fuzzing, sanitizers, benchmarks, integration/E2E, shadow traffic,
and production telemetry can all contribute.

Choose checks from the failure model. Record each oracle’s:

- **fidelity** to the declared boundary;
- **independence** from candidate assumptions and code;
- **sensitivity** to plausible wrong implementations;
- **reproducibility** and flake/noise behavior;
- **environment realism**;
- **freshness**, cost, and latency.

Do not average these into one reassuring score. A Critical claim may require minimum
independence and sensitivity even when many lower-quality tests pass. See
[`references/oracles.md`](references/oracles.md).

Useful layers, selected proportionally:

- **L0 static:** type, compile, lint, schema, ABI/layout;
- **L1 focused:** deterministic unit, contract, characterization;
- **L2 semantic:** differential, property, metamorphic, model checks;
- **L3 integration:** real storage, network, process, filesystem, or service boundary;
- **L4 end-to-end:** user-visible workflow;
- **L5 hardening:** fuzz, race, sanitizer, resource, benchmark, bounded proof;
- **L6 environment:** supported platform matrix, shadow, canary, production signals.

Static checks and review are valuable signals, but compiler success or an LLM saying
“looks correct” does not prove runtime behavior.

## 6. Qualify the judge before trusting green

A new or materially changed oracle must demonstrate discrimination:

1. A known-good or minimal-valid case passes.
2. One or more known-bad cases tied to the failure model are rejected.
3. Rejection happens for the intended semantic reason, not merely setup, compile, crash,
   or dependency failure.
4. Restoration returns the oracle to green.
5. Repeated no-change trials measure flake/noise where relevant.
6. Oracle, fixture/corpus, normalizer, tolerance, reference, build mode, toolchain, and
   environment identities are recorded.

Classify qualification as `fresh` or `reused`. `fresh` records the known-good,
failure-model rejection, a later restoration pass, and only the stability trials
justified by the oracle's determinism/noise model. Stability trials use explicit,
dedicated plan step IDs, execute the known-good command after restoration, and retain
every pass/fail outcome. They must not overlap discovery, protected metric generation, or
another non-stability control-plane role. The observed flake rate is derived from those
outcomes and must stay within the declared budget. The initial known-good and restoration
passes never count as stability. `reused` cites an authenticated prior qualification
attestation by ID and digest; its qualified fingerprint must exactly match the current
oracle and it inherits only attested Defeater coverage. A caller-supplied status string is
not proof of reuse. Do not invent new mutants
or fixed trial counts for an unchanged deterministic reused oracle.

Qualification depth by profile:

- **Light:** one historical or plausible wrong behavior for a newly invented judge;
  reuse it while the mechanism is unchanged.
- **Standard:** each major boundary or failure class has a discriminating case.
- **Critical:** every High/Critical defeater is covered by a discriminating case,
  independent signal, or explicitly blocked/accepted residual. Report surviving
  mutants/faults instead of hiding them.

Do not mutate user production code merely to seed a fault. Use a disposable copy,
fixture, test seam, historical failure, mutation tool, or controlled fault injection.

## 7. Put the verifier in a protected acceptance domain

Prompt-level instructions are not sufficient independence. Use a **Verifier Enclave**:

- Candidate workers have write access only to declared candidate scope.
- Contracts, fixtures, golden outputs, normalizers, tolerances, benchmark parsers,
  thresholds, test discovery, CI acceptance scripts, and signing material are protected.
- Material verifier changes require the Verifier Owner, new identity/fingerprint,
  requalification, and rerunning affected gates.
- Declare machine-readable candidate capabilities: writable paths, readable protected
  paths, allowed/denied commands, network, secret, dependency, and destructive-Git policy.
- Final Standard/Critical gates run in CI or another permission domain the candidate
  cannot modify.
- Record discovered tests, executed tests, skips, shards, and holdout policy so “all
  remaining tests pass” cannot hide missing coverage.
- Acceptance subprocesses receive only an explicit Contract-owned environment allowlist;
  do not inherit CI credentials or unrelated process state.
- Critical multi-platform evidence names an
  `external-attestation-aggregator` authority and binds one authenticated source
  attestation digest plus one protected result command to every platform; a single-host
  issuer cannot self-assert foreign platform results.
- Inspect dependency, lockfile, build-script, environment-variable, cache, and network
  changes that could indirectly alter the judge.
- Candidate workers may produce an evidence proposal; they do not issue the final
  acceptance attestation.

The package includes `tools/vdd_accept.py` as a minimal reference control plane. Before
starting any child process it applies Draft 2020-12 Schema plus semantic validation to
the Contract and validates every plan step, verifies declared protected identities and
full workspace scope coverage, then copies the workspace and proves the copy's complete
file/type/mode and material directory manifest equals the preflight manifest. It remaps
source-workspace `argv`, `PATH`, and `PYTHONPATH` entries into the snapshot, rejects
unpinned external inputs, and derives the actual allowlisted environment and executable
identities. Each fixed shell-free plan step runs in a network-denied OS sandbox with
protected inputs read-only and only dedicated result paths writable. Linux uses a
`bwrap` PID namespace for process-tree containment; the macOS reference denies
`process-fork` because `sandbox-exec` cannot contain detached descendants race-free.
Acceptance plans that require child processes must therefore use Linux or another
independently governed control plane. The reference fails closed when its required
boundary is unavailable.
Candidate identity is the copied artifact identity digest, not a proposal label or
unchecked Git revision.

The control plane captures structured discovery, metric, cutover, and release results at
their Contract-declared protected producer steps, seals them against later replacement,
and discards proposal-supplied acceptance facts. Fresh known-bad qualification requires
the Contract-owned semantic rejection signal, while reused qualification is bound to the
current Oracle, fixture/corpus, and environment identities. It resolves authenticated
release-parent attestations, validates the assembled Evidence against Schema and semantic
rules before signing, and HMAC-signs its canonical digest. Its HMAC key handling is an
integration example, not a production trust boundary; production use requires
CI/KMS-backed key isolation.

The executable conformance runner additionally supervises each Python candidate call in
a network-denied OS sandbox with only verifier-declared writable roots and a read
allowlist limited to system/runtime files, trusted executor code, the exact candidate
artifact, and those writable roots. It keeps candidate source outside writable roots,
passes only a minimal trusted environment, and checks its digest before and after
evaluation. It requires `sandbox-exec` on macOS or `bwrap` on Linux and fails closed if
that boundary is absent. On macOS it denies candidate process creation; Linux contains
the candidate tree in a PID namespace. The supervisor—not candidate code—owns the
upstream result protocol, enforces a hard output/response byte limit, protects its
executor/worker/proxy chain, and terminates contained descendants on success, rejection,
timeout, or overflow.
Candidate return values remain untrusted and must still be rejected by qualified
semantic and side-effect
Oracles when incomplete,
hardcoded, or forged.

The packaged reference is regenerated with `python tools/package_vdd.py`. The generator
uses one stable, no-follow regular-file snapshot for both `MANIFEST.sha256` and
`vdd-0.4.0.zip`, rejects symlinks, special files, unsafe names, and inventory drift, then
publishes the pair with rollback. ZIP entries are sorted and byte-reproducible, with fixed
timestamps and each source file's complete Unix mode.

Roles:

- **Contract Owner:** owns intent and domain decisions.
- **Verifier Owner:** owns judges, fixtures, thresholds, and qualification.
- **Implementer Agent:** owns only candidate scope.
- **Independent Acceptor:** reruns final gates and attests acceptance.
- **Release Owner:** accepts residual operational risk and authorizes release.

For Light work, one person may hold several roles, but candidate write authority and the
acceptance judge still remain separated through protected files or CI. See
[`references/verifier-enclave.md`](references/verifier-enclave.md).

## 8. Design for verifiability

If a claim cannot be observed or controlled, first create the smallest trustworthy seam.
Useful patterns include controllable time/randomness/IDs, stable adapters, replayable
events, deterministic serialization, state snapshots, shadow execution, fault-injection
hooks, machine-readable diagnostics, and explicit idempotency boundaries.

Pure-core/effect-shell can help, but is not a universal requirement. The requirement is
that the architecture gives the verifier enough observation and control to distinguish
plausible wrong behavior.

If the requested property remains unobservable, return a Characterization result with
the exact missing prerequisite. Do not fabricate parity, hardcode a golden, or present a
stub as complete.

## 9. Slice work into independently falsifiable units

A work unit is independently executable, falsifiable, diagnosable, integrable, and
reversible. Use [`references/work-unit.md`](references/work-unit.md) for multi-unit,
parallel, long-running, or rollback-sensitive work.

Slice by behavior and failure signature, not merely by file count. Each unit names:

- claim and defeater IDs;
- public boundary and dependencies;
- candidate and protected scope;
- focused and broad gates;
- integration wave and shared-seam owner;
- rollback/restoration;
- acceptor and expected evidence.

Parallel execution is safe only when behavioral dependencies, shared state, verifier
assets, and integration order do not conflict. Disjoint files are a useful default, not
a proof of independence.

```text
effective agent parallelism
≤ independently diagnosable work units
≤ verifier and integration throughput
```

Use a work-in-progress limit. When verifier queues, merge conflicts, or repeated failures
grow, reduce batch size rather than adding agents.

For large or Critical Equivalence, build a source-fact corpus and classification
inventories first. Pilot at least one routine unit, one high-risk semantic unit, and one
shared-seam/platform-sensitive unit before scaling.

## 10. Execute the mode-specific loop

### Characterization

```text
name the boundary and unknowns
→ capture known-good/minimal-valid behavior
→ create/select a plausible wrong behavior
→ prove the judge rejects it
→ measure stability/noise
→ freeze identities and unknown ledger
→ independently accept the characterization artifact
```

Characterization is complete when the baseline and judge are usable for later work; it
does not claim a replacement implementation exists.

### Construction

```text
validate intent
→ encode one public claim
→ observe semantic RED
→ implement the minimum rightful change
→ observe focused GREEN
→ run required real boundary and regression
→ independently accept at the selected profile
```

A missing symbol can be an initial setup signal, but before the real implementation the
check must reach a callable boundary and observe a wrong value, state, effect, or error.
TDD is the normal local inner loop; VDD supplies intent validation, judge qualification,
risk-scaled broader gates, evidence integrity, and acceptance.

### Equivalence

```text
classify accepted/corrected/unknown reference behavior
→ capture reference baseline GREEN
→ prove the oracle rejects a plausible semantic deviation
→ run reference and candidate on identical semantic inputs
→ repair exact deltas
→ rerun integration/platform gates
→ update all callers and complete cutover
→ remove replaced production paths
```

Use incremental cutover when a stable seam permits it, batch ports only for repetitive
independent units with fast reliable judges, and big-bang only when the contract is truly
indivisible and rollback has been rehearsed. A permanent production fallback to the old
implementation is not completion; rollback is a separate restoration mechanism.

Cross-language work additionally covers ABI, layout, calling convention, ownership and
lifetime, destruction timing, error/panic/unwind protocol, evaluation order, overflow,
ordering/hashing, platform, and toolchain differences where relevant.

### Improvement

```text
freeze observable semantics
→ capture repeated no-change metric baseline
→ name one primary metric and direction
→ calibrate noise and minimum meaningful improvement
→ change one causal factor
→ prove optimized branch/fast path executed
→ rerun semantic and hard constraints first
→ retain only if the metric clears its gate
```

The Evidence metric identity, direction, sample counts, calibrated noise band, and
minimum meaningful improvement must match the Contract after normalizing supported
numeric forms such as `5` and `"5%"`. Retain raw baseline and candidate samples. In the
reference control plane, the final acceptance plan step writes a Contract-declared
structured metric result into protected output scope; proposal-supplied samples and
labels are discarded. The reference linter independently derives mean relative change
from protected samples and rejects an `improved`, `statistical_inconclusive`, or
`regressed` label that contradicts direction, noise, or minimum-change policy. More
advanced statistical gates require an equivalently protected, independently recomputable
parser.

Inventory behavior the proposed optimization could change: accepted input types,
equality/hash assumptions, duplicates and ordering, identity/aliasing, mutation and side
effects, laziness/short-circuiting, exception type/message/timing, malformed irrelevant
data, memory/resource ceilings, and platform behavior. A fast path without a
fixture/instrument proving it executed is outside the verified domain.

Correctness, safety, security, memory, and platform constraints are lexicographically
ahead of the metric. Results inside the noise band are `STATISTICAL_INCONCLUSIVE`, not a
win. See [`references/statistical-gates.md`](references/statistical-gates.md).

## 11. Repair from exact counterexamples

Use [`references/failure-taxonomy.md`](references/failure-taxonomy.md).

```text
run verifier
→ preserve exact input, output, seed, environment, and delta
→ classify failure
→ minimize or trace first divergence
→ locate the smallest rightful boundary
→ repair the root cause
→ rerun the cheapest reproducer
→ rerun focused gate
→ rerun every affected broad gate
```

Rules:

- Preserve the original failure before editing.
- A new failure signature is a new diagnosis, not automatic progress.
- After two unsuccessful repairs, add tracing or minimize the fixture.
- At the contract’s repair budget (default three attempts with the same signature), stop
  speculative edits and re-check intent, judge, seam, unit size, and environment.
- Never obtain green by sleeps, broad retries, catch-all fallbacks, ignored exits,
  skipped/deleted/filtered tests, relaxed thresholds, candidate-only normalization,
  hardcoded fixture outputs, or invoking the legacy implementation behind the candidate.
- After a systemic generator/type/schema/framework fix, rescan the frozen instance
  inventory. Close only with zero unresolved and zero unknown required entries.
- A Critical repair requires an independent acceptance rerun of the original
  counterexample, class-wide check, and broader regression.

## 12. Treat evidence as a versioned state machine

Recommended lifecycle:

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

`BLOCKED` and `INVALIDATED` may be entered from any stage. Characterization can end at an
independently accepted `JUDGE_QUALIFIED + BASELINE_CAPTURED` artifact.

An evidence manifest binds:

- candidate content-derived revision, stable-snapshot status, and artifact digests;
- canonical contract revision and content fingerprint;
- claim, defeater, oracle, fixture/corpus, reference, and environment identities;
- toolchain, dependency, build-mode, OS/arch/runtime, configuration, seed/clock/locale,
  and data identity;
- exact command IDs, command text, exits, outputs, artifacts, and mode-specific gate
  references;
- contract-pinned discovery manifest/count/shards plus executed tests and approved skips;
- Claim/Defeater dispositions whose evidence references resolve to executed commands;
- residual risk owners, stages, rationales, expiries, and invalidators; acceptance
  verification rejects risks expired at issuance or re-verification time;
- invalidation conditions;
- independent issuer, stage, retention location, authenticated reused-qualification
  snapshots, and an authenticated release-to-merge parent attestation;
- control-plane run identity plus before/after candidate/protected snapshots, discovery
  result digest, execution-plan results, canonical attestation digest, and signature.

Use [`references/evidence.md`](references/evidence.md). The included
`tools/vdd_lint.py` checks the reference JSON assurance graph and identity bindings;
`tools/vdd_accept.py` executes and signs a protected acceptance plan. They are protocol
guardrails, not proof engines.

Evidence becomes stale when any material input changes: contract, claim, failure model,
judge, expected result, fixture/corpus, normalizer, tolerance, threshold, reference,
dependency, lockfile, toolchain, build mode, test discovery/sharding, environment,
feature flag, security policy, benchmark parser, or production configuration. Assign a
new identity, re-qualify affected judges, and rerun affected gates.

## 13. Separate merge eligibility from release eligibility

**Merge eligible** means the repository candidate has fresh claim evidence, every
Contract-declared merge gate passed, protected scope is intact, equivalence cutover is
complete where applicable, and rollback/restore is available at the declared level.

**Release eligible** additionally requires every Contract-declared release gate to pass,
the declared supported environments or representative workload, shadow/canary evidence,
production-signal thresholds, rollback trigger and exercise, a named Release Owner,
explicit residual-risk acceptance, and an authenticated parent attestation that resolves
to the accepted merge candidate and Contract.

A green repository suite does not automatically imply production release. Preserve the
contract, judge identities, exact evidence, residual limits, and restoration result in a
durable repository or control-plane artifact. Agent transcripts and temporary branches
are not sufficient retention.

## 14. Close the production feedback loop

Every canary failure, incident, user report, or security finding should become:

```text
real evidence
→ minimized counterexample
→ claim/defeater classification
→ permanent regression corpus
→ affected attestation invalidation
→ VDD repair and re-acceptance
```

Runtime observations are not a separate afterthought; they expand the verified domain.

## 15. Completion criteria and reporting language

Completion requires the mode-specific baseline and gate, every required profile boundary,
fresh judge identities, intact protected scope, no unexplained flake/differential,
resolved normative requirements, and explicit residual unknowns. Critical `unknown`,
stale evidence, unexecuted required rules, or unresolved inventory entries block the
relevant stage unless a named risk owner narrows the contract.

Use [`references/report.md`](references/report.md) for complex work. Do not report only
“all tests pass.” Name commands, environment, claims, scope, and stage.

For conformance checks, `evals/run_fixtures.py` keeps its Oracle and qualification
mutants outside the candidate workspace. Cases 5, 6, 7, and 10 reject the packaged
known-bad candidates and can accept a repaired candidate only after the same protected
Oracle reaches qualified GREEN.

Preferred completion statement:

> Under Contract X, Oracle revisions Y, Environment Z, and assumptions A, Claims C have
> fresh accepted evidence. Residual unknowns/risks are R; this evidence expires under I.
> Current state: merge eligible / release eligible / blocked.

## 16. Relationship to other methods

- **SDD** supplies intent, constraints, and design context.
- **TDD** is the default local Construction loop from semantic RED to GREEN.
- **E2E** is one high-realism oracle, not the entire method.
- **Differential, property, fuzz, mutation, sanitizer, benchmark, and formal methods**
  are oracle techniques selected by the failure model.
- **Code review** proposes defeaters and maintainability/security risks; it is not the
  final truth oracle.
- **VDD** governs selection, qualification, permissions, repair, evidence lifecycle, and
  acceptance across all of them.
