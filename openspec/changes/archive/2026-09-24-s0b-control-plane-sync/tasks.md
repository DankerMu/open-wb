## Risk Packs
- CLI/config/schema selected: exact mirror tuples/headers and owner parsing →1.1,1.2,2.1–2.2; no runtime CLI change.
- Auth/secrets selected: accurate same-uid residual disclosure and ADR0010 removal condition →1.2,2.1; no new auth enforcement.
- Legacy compatibility selected: current10-target context, unchanged existing8surfaces and4recipes/workflow including fileharness →2.2.
- Errors selected: missing/duplicate/drift/decoy controls fail closed →2.1.
- Documentation selected: AGENTS matrix/enforcement/directory/header/riskledger and archive →1.2,3.1.
- File IO, concurrency, resource, packaging not selected: no changed file/runtime ownership, process/network behavior or deps; oracle scratch inherits existing fixture lifecycle.
- Domain process/credential and offline selected as disclosure-only: S0b environment whitelist is not OS isolation; no real upstream run claimed →1.2,2.1.
- Domain browser/SQLite/tenant-sandbox behavior not selected: product and runtime unchanged; guarded by scope hashes2.2.

## 1. Atomic mirror implementation
- [x] 1.1 Test-only extension of existing source-derived oracle/mutations, parent validates syntax and observes old mirrors fail semantically after baselineGREEN.
- [x] 1.2 Update exactly AGENTS, constraints and Make header to the new protected mirror contract; record same-uid downgrade with ADR0010 exit, no recipe/CI/product/threshold changes.

## 2. Parent verification
- [x] 2.1 Independent scratch mirror/field/enforcement/header/directory/downgrade decoy mutations reject; restore baseline; all four spacedduplicate targets reject with intended contract exit1, generators must succeed.
- [x] 2.2 Complete make test-guardrails, shell/size/naming/strictspec; preserve exact existing runtime recipe/workflow/product/threshold identities and old positive controls.
- [x] 2.3 Expanded review and exact-head CI green before source merge. PR258 head0a73d9a8cbf76824d8f4dab851dad40552852b87 round2 clean, CI35969664073 eight checks passed; 611 guard oracle cases and22 independent mutants qualified.

## 3. Delivery
- [x] 3.1 Merge107, update parent6.4 and independently archive via PR/CI before Epic acceptance reconciliation. Source PR258 merged; this archive delivery is isolated in its own PR, with merge gated on exact-head CI.

Evidence /tmp/open-wb-issue107-evidence. Parent owns external oracle execution and fixture; writers no validation/formatting/commits, no worktrees/nestedagents. No concreteReturnType contracts. No manual real-model call necessary for mirror acceptance; rows describe future operator evidence rather than claiming that evidence here.
