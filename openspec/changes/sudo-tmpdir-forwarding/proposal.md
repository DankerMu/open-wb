# Proposal

## Why
#131's real nonroot Ubuntu Linux probe fails because glibc removes TMPDIR before setuid sudo starts; preserve-env cannot restore it. User approved corrective issue #239 as an independent PR, retaining every isolation assertion, before resuming #131 (approval: #131 comment5795515817).

## What Changes
- Amend the exact sudo argv contract: if TMPDIR is present, pass its noncredential value as one assignment argument before `--`; absent adds nothing, empty remains empty.
- Preserve credential-only environment transport, direct spawn, sudo command authorization, runtime lifecycle, and the existing allowlist.
- Update focused launch tests and active parent/ADR wording; no #131 test, CI job, dependencies or privilege expansion in this slice.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-uid-isolation`: correct exact sudo argv and actual TMPDIR forwarding.

## Impact
server/src/sessions/omp/process.ts, existing launch tests, active S1a parent contract, ADR-0010. Existing promoted omp-runtime direct-spawn contract stays unchanged. Historical archives remain historical; selective archive updates the promoted uid clause.

## Risk triage
Issue type: bugfix
Fixture level: expanded
Upstream suggested level: absent (permission/credential process boundary requires expanded)
Blast radius: privileged process launch; lost temporary directory or credential argv disclosure.
Selected risk packs: Public API / CLI / script entry; Config / project setup; File IO / path safety / overwrite; Auth / permissions / secrets; Concurrency / shared state / ordering; Legacy compatibility / examples; Error handling / rollback / partial outputs; Documentation / migration notes.
Evidence floor: captured native Linux semantic RED, unchanged #131 candidate GREEN with repair, focused boundary tests/full server suite/type/lint, independent static cross-review, exact-head CI. No skipped test counts as isolation proof.
