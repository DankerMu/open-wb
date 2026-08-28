# Failure Model and Defeater Map

A test list says what was exercised. A failure model says which plausible wrong worlds
the evidence is expected to distinguish.

## Core mapping

```text
Claim
→ plausible defeater
→ failure class
→ discriminating input/fault/mutant
→ oracle(s)
→ qualification result
→ residual status
```

Example:

```yaml
claim:
  id: C-IDEMPOTENCY
  statement: Retrying the same event ID does not create a second persisted event.

defeaters:
  - id: D-CONCURRENT-RETRY
    description: Two concurrent retries pass an application-only existence check.
    failure_class: RACE_ORDER
    severity: critical
    discriminating_fault: Remove the database unique constraint or bypass the transaction.
    oracle_ids: [O-DB-CONCURRENCY]
    status: covered

  - id: D-RESPONSE-LOSS
    description: Commit succeeds but the response is lost, causing a later retry.
    failure_class: CONTRACT
    severity: high
    discriminating_fault: Inject response failure after commit, then replay the event.
    oracle_ids: [O-DB-FAULT-INJECTION]
    status: covered
```

## How to derive defeaters

For each claim, ask:

1. What implementation would look reasonable in review but still violate the claim?
2. What boundary, timing, data shape, platform, or error path could make the claim false?
3. What shared assumption could make several tests pass together while remaining wrong?
4. How could a candidate obtain green without implementing the behavior?
5. What production incident would surprise us if this claim were false?

Common sources:

- boundary/error behavior;
- duplicate, ordering, identity, aliasing, mutation, and lazy/eager semantics;
- concurrency, retries, partial failure, and recovery;
- cross-language ABI, lifetime, overflow, panic/error, and evaluation-order differences;
- stale data, configuration, feature flags, platform, dependency, and toolchain drift;
- test discovery, fixtures, snapshots, normalization, thresholds, and fallback bypasses;
- security capabilities, prompt injection, secrets, network, dependency, and CI tampering.

## Coverage by risk profile

### Light

A newly invented judge demonstrates at least one historical or plausible wrong behavior.
Do not manufacture a mutant for every trivial assertion.

### Standard

Every major boundary or independent failure class has at least one discriminating case.
A pile of cases from one shared assumption does not cover a different class.

### Critical

Every High/Critical defeater is one of:

- `covered`: linked to a qualified discriminating oracle;
- `accepted_residual`: explicitly accepted for the current stage by a named risk owner;
- `unknown`: blocks the current stage.

Report surviving mutants/faults and why they survived. Mutation score is diagnostic, not
a universal target; easy mutants can inflate it while important semantic failures remain.

## Defeater status transitions

```text
proposed
→ covered
→ confirmed by fresh evidence
```

or:

```text
proposed
→ accepted_residual (named owner + stage + expiry)
```

or:

```text
proposed
→ unknown / blocked
```

A contract or oracle change can return a previously covered defeater to `unknown` until
requalification and affected gates are rerun.

## Review role

Human or LLM reviewers are useful for proposing defeaters, finding shared assumptions,
and challenging the assurance argument. They are not themselves the final oracle. Convert
credible findings into executable checks when practical, then preserve the resulting
counterexample.
