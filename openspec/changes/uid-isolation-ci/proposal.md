# Proposal

## Why
#132 makes the delivered Linux isolation test and real omp smoke a mandatory hosted-runner gate. #131's native container proof cannot establish GitHub runner provisioning or real omp under sudo; #130/#105 now supply the four-file harness baseline.

## What Changes
- Add one Ubuntu uid-isolation job, timeout15, to the eight-direct-job aggregate; install existing pinned tools and invoke a dedicated provisioning script.
- Provision dedicated omp/workbuddy identities, exact three binary-scoped SETENV rules, shared job directories, minimal-environment HOME preflight, and effective-group execution of both the selected Linux test and real compiled-server smoke.
- Preserve optional OMP_USER through the existing shared helper; synchronize exact workflow/helper/AST cardinality and runtime fault oracles atomically.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-uid-isolation`: add the formal CI job requirement, not the separate downgrade deletion.
- `verification-harness`: extend current CI wiring requirement to the third harness/eighth direct job, preserve existing scenarios.

## Impact
.github/workflows/ci.yml, .github/scripts/ci-uid-isolation.sh, ci-compiled-server.sh, scripts/test-ci-harness.sh, inspect-ci-workflow.js and directly affected existing guardrail consumers. No product source, Linux test oracle, AGENTS/downgrade, browser journey or dependency changes. Host workstation sudo/users/groups are never modified.

## Risk triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded (agree: privileged process/permission/CI acceptance boundary).
Blast radius: false-green skipped/same-uid proof, secret output, inaccessible shared state, orphan cross-uid child, unrequired CI job.
Selected risk packs: all except persisted schema changes; map in tasks.
Evidence floor: source/runtime guardrails with genuine positive and failing controls, existing jobs unchanged, hosted uid-isolation non-skipped test plus real pinned omp four-file smoke and exact-head aggregate green; capture successful master run for #134.
Width exception: multi-path workflow, provisioning and exact oracle must ship atomically.
