# VDD Completion and Assurance Report

Report the decision, evidence, scope, and limits—not merely activity.

## Reference format

```text
Result: accepted | blocked | invalidated
Stage: characterization | merge | release
Mode/Profile: characterization|construction|equivalence|improvement / light|standard|critical
Objective/Contract: <ID + revision/fingerprint>
Candidate: <revision + artifact digest + dirty state>

1. Intent validation
- Owner/authority: <identity/source>
- Positive/negative/critical examples: <summary>
- Ambiguities/unknowns: <resolved, narrowed, residual, or blocking>
- Contract changes during work: <none | revision + evidence invalidated>

2. Assurance case
- Claim <ID>: <statement>
  - Defeaters: <IDs and status>
  - Oracle argument: <why selected evidence distinguishes them>
  - Scope/assumptions: <boundary/environment>
  - Result: confirmed | refuted | unknown
- Residual risks: <owner + accepted stage + expiry>

3. Judge qualification
- Known-good/minimal-valid: <command -> result>
- Known-bad discrimination: <fault/defeater -> intended rejection>
- Stability/no-change: <runs, flake/noise>
- Qualified identities: <oracle/reference/fixture/build/platform fingerprints>
- Surviving faults or oracle conflicts: <none | disposition>

4. Mode-specific baseline
- Characterization: <baseline/corpus/unknown ledger>
- Construction: <semantic RED evidence>
- Equivalence: <reference GREEN + wrong candidate/mutant RED>
- Improvement: <semantic GREEN + repeated metric baseline/no-change control>

5. Implementation verification
- Focused: <command -> result>
- Broad/integration/E2E: <command/scenario -> result>
- Hardening/platform/statistical: <command/metric -> result>
- Test discovery: <expected/discovered/executed/skipped/shards + manifest digest>
- Environment: <digest and material details>
- Forbidden/protected-scope diff: none | <blocker/requalification>
- Inventory rescan after systemic fix: <command + zero unresolved/unknown>

6. Integration, cutover, and restoration
- Updated callers/surfaces: <list>
- Removed replaced production path: <yes/not applicable/blocker>
- Integration wave result: <evidence>
- Rollback/restore exercised: <evidence>

7. Independent acceptance and attestation
- Acceptor: <identity + independence mechanism>
- Attestation: <ID/path>
- Delivery state: characterization accepted | merge eligible | release eligible | blocked
- Canary/shadow and release owner: <evidence or not required>
- Durable evidence location and retention: <path/policy>

8. Remaining limits and expiry
- Unknowns/residual risks: <explicit list>
- Evidence invalidated by: <conditions>
- Runtime feedback added to permanent corpus: <counterexample IDs or none>
```

## Reporting rules

- Name exact commands and key outputs; do not write only “all tests pass.”
- Distinguish structural checks from behavioral evidence.
- Distinguish Intent Validation from Implementation Verification.
- Do not generalize one platform, fixture, or unit test into E2E or release evidence.
- Mark inference explicitly when direct execution was impossible.
- A qualified judge’s identity must match final evidence or show requalification.
- For Critical work, stale evidence, unexecuted required claims, unexplained flake,
  unapproved skips, or unknown required defeaters block the relevant stage.
- Do not claim release eligibility from merge-only CI evidence.
- Preserve negative evidence, failed qualification cases, and counterexamples; they are
  part of the assurance record, not disposable noise.

## Preferred completion language

> Under Contract `<revision>`, Oracle identities `<ids>`, Environment `<digest>`, and
> assumptions `<A>`, Claims `<C>` have fresh accepted evidence. Residual unknowns/risks
> are `<R>` and invalidate/expire under `<I>`. Current state: `<stage>`.
