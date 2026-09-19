## Why
Issue #86 supplies the frozen official omp binary needed by the S0b runtime without relying on PATH.

## What Changes
- Add `make omp-fetch` and `scripts/omp-fetch.sh`, pinned v18.0.10 assets and digests.
- Extend the existing Make contract oracle in `scripts/test-ci-harness.sh` atomically.

## Capabilities
### New Capabilities
- `omp-runtime`: binary supply only, extracted from the parent S0b fixture.
### Modified Capabilities
None.

## Impact
Makefile, scripts/omp-fetch.sh, scripts/test-ci-harness.sh; ignored var/omp/omp. No TS or CI wiring changes.

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree; public command and executable file publication)
Blast radius: wrong or corrupt binary could enter all subsequent agent runtimes.
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Error handling / rollback / partial outputs; Release / packaging / dependency compatibility; Documentation / migration notes.
Evidence floor: real macOS binary version, both pinned asset digests, idempotence without download, bad-digest and unsupported-platform rejection, make test-guardrails.
Parent fixture remains unarchived until the epic finishes; this change owns only binary supply.
