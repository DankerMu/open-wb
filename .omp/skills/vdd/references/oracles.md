# Oracle Portfolio Design

An oracle is a reproducible mechanism that can accept or reject a candidate against a
declared claim. Do not optimize for the number of tests. Optimize for discrimination
against the failure model.

## Quality vector

Record the following dimensions for each oracle instead of assigning a universal rank:

| Dimension | Question |
|---|---|
| Fidelity | Does the oracle observe the actual contractual boundary? |
| Independence | How much code, data, or assumption does it share with the candidate? |
| Sensitivity | Which plausible faults can it distinguish? |
| Reproducibility | Can the result be repeated with bounded flake/noise? |
| Environment realism | Does it cover the dependencies/platform/configuration that matter? |
| Freshness | Is the evidence bound to the current oracle, corpus, candidate, and environment? |
| Cost/latency | Is it suitable for the inner loop, batch gate, or release gate? |

These dimensions are not averaged. A Critical contract may require `high` independence
for one claim and `high` environment realism for another.

## Common oracle types

- **Static/type/schema/ABI:** strongest for structural claims expressible in the type,
  schema, linker, or compile-time system; weak for unencoded runtime semantics.
- **Focused contract/unit:** fast and local; can share implementation assumptions.
- **Differential:** excellent for ports and rewrites; can preserve legacy bugs.
- **Golden master:** useful at a stable public boundary; vulnerable to stale or
  over-broad snapshots and blind snapshot updates.
- **Property/metamorphic:** covers broad input spaces and relations; quality depends on
  the strength of the property.
- **Independent implementation/model:** high independence when genuinely separate;
  models can be incomplete.
- **Real integration/E2E:** covers dependency and workflow behavior; slower and often
  nondeterministic.
- **Fuzz/mutation/fault injection/sanitizer/race:** exposes classes of plausible faults;
  needs reproducible seeds and interpretable findings.
- **Benchmark/statistical:** judges measured improvement; cannot replace semantic gates.
- **Shadow/canary/production telemetry:** highest environment realism for selected
  signals; detects only what is instrumented and safely exposed.
- **Human/LLM review:** useful for new defeaters, omissions, security, and maintainability;
  nondeterministic and not a final executable truth oracle.

## Boundary checklists

### CLI

Compare argv/stdin, stdout bytes or declared normalization, stderr, exit code, files,
process signals, environment effects, and timing/order only where contractual.

### HTTP/API

Check method/path, status, headers, body schema/value, authentication/authorization,
persistence, downstream calls, retries/idempotency, and partial-failure behavior. Do not
normalize away semantic fields as “transport noise.”

### Data migration

Check row counts, keys, null semantics, aggregates, referential integrity, duplicate
rules, ordering only where contractual, schema constraints, reversible round-trips,
partial restart, and rollback/restore.

### Compiler/parser

Use corpus differential, diagnostics, AST/IR invariants, generated output execution,
known-bad cases, fuzzing, minimization, ABI behavior, and platform/toolchain matrices.

### Cross-language runtime

Cover symbols, calling convention, layout/padding, alignment, ownership/lifetime,
destruction timing, aliasing/reentrancy, error/panic/unwind protocol, startup/shutdown,
overflow/bounds, malformed slices, invalid enum/union states, ordering/hashing,
evaluation order, compile-time versus runtime evaluation, and debug/release differences.

### UI

Use actual interaction and accessible state/DOM, state transitions, keyboard/pointer
behavior, persistence/network effects, and calibrated visual fixtures where appearance is
contractual. Screenshots alone do not prove interaction semantics.

### Performance and probabilistic systems

Use repeated measurements, warmup, no-change controls, environment identity, fixed and
random seed policy, distribution/percentiles or confidence intervals, minimum meaningful
difference, resource ceilings, visible retry policy, and an explicit inconclusive state.
See `statistical-gates.md`.

## Qualification protocol

Before trusting a new or materially changed oracle:

1. Run a known-good or minimal-valid case and observe pass.
2. Select one or more known-bad cases from the defeater map.
3. Observe rejection for the intended claim/failure class.
4. Restore the known-good state and observe pass again.
5. Run repeated no-change trials to measure flake/noise where applicable.
6. Record fingerprints for oracle code, expected output, fixture/corpus, normalizer,
   tolerance, benchmark parser, reference, build mode, toolchain, and environment.
7. Record which defeaters remain untested, survive, or conflict with other oracles.

A compile error, missing dependency, setup failure, or crash before the contractual
boundary does not qualify a behavioral oracle, even if the command exits nonzero.

Record `qualification.status` as `fresh` for this protocol. An unchanged deterministic
Oracle may instead use `reused` only when the acceptor resolves and authenticates the
named prior qualification attestation, verifies its digest, matches its attested Oracle
revision/fingerprint to the current Contract, and confirms that its rejected-fault
coverage includes every inherited Defeater. A caller-supplied status or fingerprint is
not proof. Stability trials are required by the Oracle's flake/noise model, not by a
universal profile count; a reused deterministic static check does not need ceremonial
mutants or repeated trials.

In the reference acceptance control plane, fresh qualification coverage is derived from
plan records after the post-mutant restoration. Every no-change trial has an explicit,
dedicated `stability_command_ids` entry, runs the known-good command after restoration,
and retains its actual pass/fail outcome. A stability ID cannot also own discovery,
protected metric generation, or another non-stability control-plane role. The initial
known-good and restoration passes are never trials. The observed flake rate is the
failed-trial fraction and must not exceed the Contract's declared budget. Candidate
evidence starts only after every fresh Oracle has
restored and completed its declared stability steps. Reused values come only from an
authenticated prior qualification attestation. Proposal-supplied coverage or stability
statistics cannot upgrade either path.

Do not modify user-owned production code solely to seed a fault. Use a temporary copy,
test seam, mutation tool, historical bug, fault injector, or disposable fixture.

## Oracle conflict resolution

When qualified oracles disagree:

```text
mark ORACLE_CONFLICT
→ freeze candidate edits for the disputed claim
→ reproduce each result under recorded identity
→ compare scope, assumptions, and boundary fidelity
→ inspect shared dependencies/normalization
→ obtain the Contract Owner decision if the contract is ambiguous
→ revise or narrow the claim
→ invalidate and re-qualify affected evidence
```

Do not pick the oracle that makes the candidate green.

## Evidence invalidation

Qualification expires after a material change to:

- contract, claim, or defeater map;
- oracle code, expected output, fixture/corpus, golden, normalizer, tolerance, or threshold;
- reference revision or accepted/corrected behavior classification;
- dependency/lockfile, toolchain, build mode, platform, runtime, configuration, data, or
  feature flag;
- test discovery, filtering, shard assignment, skip manifest, cache, or CI runner;
- benchmark parser, workload, warmup, sampling, or environment;
- security/network/secret policy affecting execution.

Assign a new identity, rerun qualification, and rerun every affected acceptance gate.

## Anti-cheating rules

Reject a candidate or evidence proposal that obtains green by:

- editing protected oracle code, expected outputs, fixtures, goldens, parsers, or thresholds;
- updating snapshots without an independently approved contract change;
- deleting, skipping, filtering, renaming, or conditionally bypassing tests;
- reducing test discovery or hiding shard failures;
- adding candidate-only normalization or treating missing output as empty success;
- hardcoding fixture outputs or stubbing a required real dependency in production code;
- invoking the legacy implementation behind the candidate interface;
- narrowing the benchmark workload or changing semantics;
- masking errors with sleeps, broad retries, catch-all fallback, ignored exit codes, or
  swallowed telemetry;
- changing dependencies, build scripts, environment, network, cache, or CI so the judge
  no longer measures the declared boundary.

## Oracle gaps

When a trusted reference is unavailable, combine independent specifications/standards,
properties, metamorphic relations, models, separate implementations, human-approved
fixtures, and production observations. Record residual unknowns. “The output looks
right” is not an oracle.
