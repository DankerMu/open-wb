# Package Validation Record

Date: 2026-07-20

## Scope

This record validates package structure, reference code, nested JSON Schemas, example
Contracts/Evidence, executable conformance fixtures, and selected anti-bypass invariants.
It does not prove the VDD methodology is universally optimal or that applying it
guarantees defect-free software.

## Positive checks

```text
python3 -m compileall -q tools tests evals/run_fixtures.py \
  evals/candidate_proxy.py evals/candidate_worker.py evals/candidate_executor.py \
  evals/files
→ pass

python3 -m unittest discover -s tests -v
→ 354 tests passed; 1 non-UTF-8 filename case skipped on macOS because APFS rejected
  creation of that byte sequence

python3 tools/vdd_lint.py contract examples/light-construction/contract.json
→ PASS

python3 tools/vdd_lint.py evidence examples/light-construction/evidence.json \
  --contract examples/light-construction/contract.json
→ PASS

python3 tools/vdd_lint.py contract examples/standard-equivalence/contract.json
→ PASS

python3 tools/vdd_lint.py evidence examples/standard-equivalence/evidence.json \
  --contract examples/standard-equivalence/contract.json
→ PASS

Draft 2020-12 Schema validation in tests/test_schemas.py
→ 16 tests passed, including both Contract and Evidence examples, conditional mutants,
  protected-result producer plans, and runtime control-plane output

python skill://skill-creator/scripts/quick_validate.py .
→ Skill is valid!

python tools/package_vdd.py
→ regenerates the closed manifest and byte-reproducible `vdd-0.4.0.zip` archive
  with sorted entries, fixed timestamps, and source Unix modes

shasum -a 256 -c MANIFEST.sha256
→ all 72 archive entries (71 source files plus manifest) OK
```

`tests/test_eval_runner.py` additionally establishes both directions of the executable
conformance Oracle:

- packaged wrong candidates for cases 5, 6, 7, and 10 are rejected;
- each protected Oracle rejects its declared qualification mutant for a semantic
  assertion failure rather than import/setup/crash;
- repaired Webhook, slugify, email-normalization, and discount candidates reach qualified
  GREEN through the same protected tests;
- candidate modules execute through a protected subprocess chain, so direct process exit
  cannot terminate or forge the parent test runner;
- candidate workspaces overlapping protected fixture assets are rejected, and the Oracle,
  qualification mutants, proxy, worker, and executor identities are checked before/after
  grading;
- every candidate call uses a network-denied OS sandbox with candidate source read-only,
  no ambient secret inheritance, an exact-file host read allowlist, and only
  verifier-declared writable roots; sibling files and directory-valued failure targets
  do not broaden that authority;
- candidate stdout, stderr, and serialized responses have a hard byte limit, and detached
  descendants are terminated on success, rejection, timeout, or overflow;
- timed-out protected fixture runners terminate their unreaped new-session process group,
  including ordinary inherited-stdout descendants after the fixture root exits, while never
  signaling a known-reaped group whose numeric PGID could have been reused;
- lifetime descriptors cannot alias standard streams, high descriptor numbers are polled
  without `select(2)` limits, broken request pipes stop writes promptly, and a sandbox-child
  guardian establishes lifetime monitoring and a trusted execution gate before allowing the
  sandbox command to exec, then terminates the candidate if its executor dies before normal
  cleanup, including after candidate `exec` replacement;
- verifier output rejects symlink targets and uses atomic replacement;
- the Webhook fixture exercises invalid HMAC, stale timestamp, invalid payload, real
  SQLite persistence, sequential and concurrent idempotency, exact body retention, and
  persistence failure.

`tests/test_vdd_accept.py` confirms complete preflight before child execution, immutable
snapshot execution, environment-path remapping, external-input identity checks, Linux
PID-namespace process-tree containment, and fail-closed macOS process creation. Every
plan step runs in a network-denied OS sandbox with protected inputs read-only and only
that step's declared output paths writable. Candidate artifacts are never writable by
acceptance-plan subprocesses. Protected discovery, metric, cutover, and release artifacts are
captured at their declared producer step and sealed against replacement; forged proposal
facts are discarded. Fresh qualification rejects wrong-reason exit codes, and reused
qualification is invalidated by fixture/corpus or environment drift. The control plane
also binds candidate file/link/ancestor identity, rejects transient protected-asset ABA
tampering, issues a Schema-valid signed canonical digest, re-resolves prior/parent
attestation chains, exercises the public issue/verify CLI, safely writes outputs without
following symlinks, and detects post-signature tampering. It also retains every bounded command stdout/stderr
stream and executed sandbox policy in a private staging directory, atomically publishes it only
after signing, binds both raw-byte digests and filesystem identities into the signed attestation,
rejects path traversal through hostile command IDs, and detects retained-output replacement.
Package integrity independently validates the closed source inventory, rejects duplicate
manifest paths, unsafe names and symlinked source/output paths, detects inventory drift,
uses one stable snapshot for both projections, serializes concurrent pair publication, restores
the prior pair on publication failure while preserving an unapplied backup if rollback fails,
preserves complete Unix modes, and reproduces the committed archive bytes.
Source provenance pins the checkout generation and rechecks the trusted system Git executable identity
before and after every query, then binds a clean raw
local origin/revision to rooted Git-tree blob identities and independent candidate/source
fingerprints, supports unrelated clean submodules, and treats Git paths as raw filesystem
bytes. It rejects staged, untracked, ignored, hidden-index, replacement-ref, filter-driver,
special-file, and source-drift paths, plus retained or attestation outputs that would dirty
the source checkout.

## Real-Upstream Validation

The retained real-project target is `pallets/itsdangerous` at immutable commit
`672971d66a2ef9f85151e53283113f33d642dabd`.

```text
PYTHONPATH=src /opt/homebrew/bin/python3 -m pytest -q \
  tests/test_itsdangerous/test_signer.py
→ 17 passed

PYTHONPATH=src /opt/homebrew/bin/python3 -m pytest -q \
  tests/test_itsdangerous/test_signer.py \
  tests/test_itsdangerous/test_serializer.py \
  tests/test_itsdangerous/test_encoding.py
→ 66 passed
```

Both selectors were re-run inside a macOS `sandbox-exec` profile that denies
`process-fork`, has no network permission, and grants `/dev/null` only as the pytest log
sink. The focused selector is the genuine upstream signer test module; the distinct broad
selector is the available 66-test upstream regression subset. The full package suite is not
claimed because its pinned test extra `freezegun` was absent in this environment.

This target has no scoped process/filesystem/service integration boundary beyond its Python
library API. Its repaired real validation is therefore **Light**, not Standard: no command is
labeled `integration`, and no direct vector oracle is mislabeled as an upstream broad suite.
A Standard attestation must add a genuinely distinct integration boundary or remain blocked.

The reference control plane issued and independently reverified a signed Light attestation:

```text
attestation_id: vdd_accept:itsdangerous-signer-light-20260719
attestation_digest: sha256:31f40504f220519731462d212657494f16aaab2fde90ec31be174088dc3414bb
retained outputs: stdout, stderr, and executed sandbox policy for all 6 steps, reverified from an explicit control-plane root
source provenance: clean origin + pinned Git-tree/blob/mode identities for the candidate and all focused/broad upstream test inputs
```

The original upstream checkout remains clean at the recorded revision.

## Negative/discrimination checks

The suite confirms rejection of:

- accepted Evidence without an independently supplied linked Contract;
- semantic Contract changes hidden behind a stale fingerprint;
- changes to nested Oracle, fixture, environment, or control-plane fingerprints;
- Oracle, fixture, environment, or Contract-pinned discovery identity drift;
- coordinated reductions in expected/discovered/executed tests or shard totals;
- unapproved or duplicate skips and protected/forbidden-scope changes;
- invalid command result/exit combinations, wrong-reason known-bad exits, and unexecuted
  focused, integration, merge, or release gates;
- confirmed Claims or eliminated Defeaters without executed command evidence;
- non-reciprocal Claim/Defeater/Oracle assurance-graph links;
- a Claim referencing another Claim's Defeater;
- fresh qualification without a known-bad case or post-rejection restoration evidence;
- stability commands that overlap discovery or protected result roles;
- reused qualification without an authenticated prior attestation matching current
  Oracle, fixture/corpus, environment, trials, and Defeater coverage;
- candidate self-attestation or issuer/Release Owner authority mismatch;
- duplicate test-discovery skip identities and incomplete Critical platform matrices;
- proposal-selected Improvement hard constraints or proposal-only cutover/release facts;
- Light-profile acceptance without issuer separation from candidate write authority;
- Unknown Claims, surviving Defeaters, or residual risks without matching stage, owner,
  rationale, expiry, and Evidence records;
- invalidated Evidence without a concrete invalidation event;
- mode/stage mismatch, missing mode-specific Evidence, undersampled or policy-mismatched
  Improvement metrics, inconclusive Improvement results, and Equivalence unknown/cutover
  gaps;
- accepted Characterization while intent remains `spec_dispute` or `blocked`;
- release Evidence without protected canary/threshold/rollback/owner results, an executed
  Contract release gate, or an authenticated accepted merge attestation;
- schemas missing nested candidate identity, capability, qualification, and mode-evidence
  fields.

## Remaining limits

- `vdd_lint.py` validates declared records but does not execute arbitrary project-specific
  validators; `vdd_accept.py` executes only the Contract's fixed acceptance plan.
- The reference HMAC signature and stable canonical digest provide tamper evidence, not a
  production trust boundary unless the key, workspace, protected assets, and issuer
  authority are isolated by CI/KMS.
- `vdd_accept.py` and the packaged Python conformance runner require `sandbox-exec` on
  macOS or `bwrap` on Linux and fail closed if that boundary is unavailable. The macOS
  reference denies `process-fork`; acceptance plans or candidates that need child
  processes require Linux or another independently governed control plane. Production
  still requires CI/KMS ownership of signing keys, verifier assets, issuer authority, and
  the trusted system Git path; replacement of that executable path invalidates provenance.
- JSON Schema extensions remain allowed; domain-specific fields still require a project
  Oracle or policy linter.
- Executable candidate grading is packaged for eval cases 5, 6, 7, and 10. The remaining
  planning/disposition evals still need an external model/human rubric runner for semantic
  answer scoring.
