## Why
Issue #157: `.jscpd.json` sets both `"threshold": 3` and `"exitCode": 1`. In the locked jscpd 5.0.16, `exitCode` is an independent "exit with this code whenever ≥1 clone exists" switch (`src/main.rs` tail: `if let Some(code) = opts.exit_code { if !clones.is_empty() { exit(code) } }`), evaluated after the percentage gate (`cpd-reporter 0.1.9 threshold.rs`: fail only when `actual > threshold`). The two stacked form a de facto zero-clone gate, contradicting the declared contract `constraints.yaml:85-89` (`duplicate_code_threshold_percent: 3`, block) and `AGENTS.md:22/86/106/145` (重复代码 ≤3%). It already forced out-of-scope helper extraction in #95/PR #156.

## Triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (expanded: the file is the block-level CI/control-plane gate config consumed by `make anti-drift`, CI `anti-drift` job and `npm run dupes`; project-profile lists CI configuration as an expanded trigger)
Blast radius: every future PR's anti-drift result; a wrong fix either keeps the zero-clone gate or silently disables duplicate blocking above 3%.
Selected risk packs: Config / project setup; Public API / CLI / script entry; Error handling; Legacy compatibility; Documentation.
Evidence floor: jscpd exit-code matrix on disposable fixtures (0 clones / ≈0.04% / ≈2.8% / ≈3.2% / ≈5%) before and after; permanent guardrail cases in `scripts/test-guardrails.sh`; `make anti-drift`, `make test-guardrails` exit 0.

## What Changes
- Delete `"exitCode": 1` from `.jscpd.json`; keep `"threshold": 3` and every other key byte-identical.
- Add permanent self-proof cases to `scripts/test-guardrails.sh` that run the real `.jscpd.json` against tmp-dir fixtures: clones below 3% are accepted; clones above 3% are rejected with jscpd's `too many duplicates … over threshold` diagnostic. This closes the regression path "someone re-adds `exitCode`" or "threshold silently stops blocking", which today has no mechanical guard (`scripts/test-ci-harness.sh` only pins the command literal, not the config semantics). Deliberate addition beyond the issue's temporary-fixture acceptance; recorded here, not a deviation.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: ADDED requirement for the duplicate-code gate's exit semantics.

## Impact
`.jscpd.json` (one key removed) and `scripts/test-guardrails.sh` (new cases). Command literals in `Makefile:31-33`, `.github/workflows/ci.yml:44`, `package.json:15` and the `scripts/test-ci-harness.sh` oracle stay unchanged; `constraints.yaml`/`AGENTS.md` already state the target contract and stay unchanged. No product code, dependency, or threshold change.
