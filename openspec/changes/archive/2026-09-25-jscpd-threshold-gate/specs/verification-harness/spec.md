## ADDED Requirements

### Requirement: Duplicate-code gate exit semantics follow the declared threshold
`npx jscpd --config .jscpd.json` — shared verbatim by `make anti-drift`, the CI `anti-drift` job and `npm run dupes` — SHALL exit non-zero on duplication only when jscpd's threshold reporter finds the duplicated-line percentage strictly greater than the `constraints.yaml` value of 3; the config SHALL NOT set `exitCode`/`exit-code` or any other switch that fails on clone presence alone. Threshold, pattern, ignore and reporters SHALL stay unchanged. `scripts/test-guardrails.sh` SHALL self-prove the gate against the real config on hermetic fixtures.

#### Scenario: Clones below the threshold pass
- **WHEN** the real `.jscpd.json` scans a fixture tree with zero clones, or with clones totalling ≈0.04% or ≈2.8% duplicated lines
- **THEN** jscpd exits 0

#### Scenario: Clones above the threshold block with the threshold diagnostic
- **WHEN** the real `.jscpd.json` scans a fixture tree with ≈3.2% or ≈5% duplicated lines
- **THEN** jscpd exits non-zero and its output contains `too many duplicates` and `over threshold`

#### Scenario: Guardrail self-proof detects a clone-presence gate
- **WHEN** `make test-guardrails` runs its duplicate-gate cases on hermetic tmp fixtures
- **THEN** the real config accepts the below-threshold fixture and rejects the above-threshold one with the threshold diagnostic, while a runtime-derived config equal to the real one plus `"exitCode": 1` rejects the same below-threshold fixture
