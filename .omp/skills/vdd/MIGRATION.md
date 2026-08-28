# Migrating from VDD 0.1 to 0.2

## 1. Update mode selection

Old contracts using `construction | equivalence | improvement` remain conceptually
valid. Add `characterization` for harness/baseline/observability work.

## 2. Replace the universal RED requirement

- Construction keeps semantic RED.
- Equivalence records reference GREEN and a discriminating wrong candidate/mutant RED.
- Improvement records semantic GREEN and a repeated metric baseline.
- Characterization records known-good GREEN, known-bad RED, and stability.

Existing Equivalence/Improvement reports should not manufacture a broken production
baseline merely to satisfy TDD ceremony.

## 3. Add intent and claims

Move prose acceptance properties into identified `claims`. Record intent owner/source,
examples, ambiguities, and decisions. When the specification changes, invalidate affected
evidence rather than silently updating expected results.

## 4. Add defeaters and qualification coverage

For every High/Critical claim, list plausible defeaters and map them to Oracle IDs. A
single seeded fault remains enough for many Light judges; Standard/Critical work needs
coverage of major failure classes.

## 5. Protect the judge

Move fixtures, snapshots, thresholds, normalizers, discovery rules, and final CI gates
out of candidate write authority. Record Verifier Owner and Independent Acceptor.

## 6. Replace report-only evidence with an attestation manifest

Bind candidate, contract, Oracle, fixture, reference, environment, command, discovery,
claim, residual risk, issuer, stage, and invalidation identities. Keep old reports as
human-readable views over this evidence.

## 7. Reclassify completion

Use `characterization accepted`, `merge eligible`, `release eligible`, `blocked`, or
`invalidated`. Do not infer release eligibility from repository CI alone.

## 8. Adopt incrementally

A practical sequence:

1. Fix mode-specific baseline and add Characterization.
2. Add intent/claim/defeater fields to Standard/Critical work.
3. Protect verifier assets and final acceptance.
4. Add evidence identity/invalidation.
5. Add statistical, runtime feedback, and full attestation automation where risk warrants.

## 9. Large code migrations

For a migration spanning multiple dependency-aware waves, retain VDD's Equivalence mode and add
`migration_profile: large_equivalence`. This opt-in profile binds a protected independent source
reference (revision, inventory, and baseline identities), source inventory, graph/gap/migration-artifact/source-classification identities,
conservative impact policy, exact candidate snapshot, and a required protected runtime fencing
assertion for each batch. It separates
`bootstrap`, `batch`, `completion`, `cutover`, and `release` evidence; completion does not imply
cutover, and cutover does not imply release. A batch independently records reference GREEN,
semantic-rejection, and parity evidence. An accepted completion is derived from a protected
reconciliation producer and must close the bootstrap inventory unit IDs plus exactly one
authenticated bootstrap, its authenticated batch set, and accepted integration snapshot with zero blocked, unresolved, unknown,
or unresolved-impact units. Every excluded unit requires a named decision and owner.

The profile does not create a scheduler. Use `code-migration` for domain artifacts and phase
handoffs, and a durable runtime such as Missions for assignments/retries/recovery. VDD verifies
submitted protected results and attests them independently.

## 10. Adopt the hardened reference artifacts

The executable 0.2 reference format requires:

- a Contract `revision` and canonical content fingerprint in linked Evidence;
- explicit fixture/corpus identities and an environment digest derived from the actual
  allowlisted process environment and command executables;
- a Contract-pinned test-discovery manifest, totals, shards, and approved skips;
- `candidate_capabilities` whose writable paths equal or descend from `scope.editable`,
  plus read/command/network/secret/dependency/Git policy;
- `fresh` qualification with known-good, Defeater-linked known-bad, post-rejection
  restoration, and relevant stability requirements, or `reused` qualification resolved
  to an authenticated prior attestation with an exact Oracle fingerprint;
- mode-specific command evidence and semantically tagged Claim/Defeater dispositions;
- stage-scoped, unexpired residual-risk records;
- Contract-declared merge/release gates and an authenticated release-to-merge parent
  attestation;
- a fixed control-plane execution plan, complete candidate/protected/output scope,
  Contract-owned environment allowlist, structured discovery result, and before/after
  artifact snapshots;
- copied-workspace content/type/mode/directory manifest equality, source-workspace argv
  remapping, content-derived candidate revision, and executed/authenticated qualification
  statistics;
- explicit `stability_command_ids` for fresh no-change trials after restoration;
- for Improvement, a Contract-declared protected metric-result path produced by the
  final plan step.

Validate migrated artifacts with both Draft 2020-12 Schema and `tools/vdd_lint.py`; the
linter CLI now applies both in that order. Standard/Critical control planes can use
`tools/vdd_accept.py` as the executable protocol reference, with production
key/workspace isolation supplied by CI/KMS.
The executable Python conformance fixtures additionally require `sandbox-exec` on macOS
or `bwrap` on Linux. Candidate source must remain outside declared writable roots;
candidate reads must be restricted to runtime/trusted/candidate scope, and calls fail
closed when the OS sandbox is unavailable.
