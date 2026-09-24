## Why
#134 closes only the S0b same-UID credential risk registration after the agreed official merged-master CI boundary is proven. #107 is closed; #132 PR257 merged8f6d033, master run35978802687 / uid job107565512880 passed with1nativepass0skip and real-omp four-file smoke. #133archiveCI35986266409 independently keeps UID and aggregate green.
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded (agree: security control-plane/evidence contract).
Blast radius: active downgrade ledger, enforcement row and precise guardrail oracle; no runtime change.
Selected risk packs: script entry; config; auth/security evidence; ownership/order; compatibility; error handling; documentation.
Evidence floor: unchanged baseline GREEN, new expectations RED against old registry/docs, final guardrails GREEN with negative controls, exact-head CI.

## What Changes
Remove only strictness_profile.downgrades control s0b_same_uid_credential_exposure; keep remaining three byte-identical. Add exact UID block enforcement row and bind oracle to active parsed owners. Known blind spots already has no proc entry: verify unchanged. Replace obsolete registration mutation cases with closure regressions, not keyword probes.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- omp-uid-isolation: evidence-bound downgrade closure.
- verification-harness: current CI contract reflects closed registration and UID enforcement.
- chat-harness: replace earlier S0b registration obligation with evidence-bound S1a closure, preserving other control-plane rules.

## Impact
Only constraints.yaml, AGENTS.md and scripts/test-ci-harness.sh implementation. No workflow/helper/product/ADR/dependency/threshold changes; no new make target or verification surface. CI proof is not user production-deployment certification; absent OMP_USER development mode remains unchanged and not claimed isolated.
