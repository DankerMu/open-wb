# Tasks

## 1. Fixture and prerequisite
- [x] 1.1 Preserve actual Linux RED and minimal loader/sudo comparison; record user approval and corrective issue link.
- [x] 1.2 Independent expanded fixture review PASS and openspec strict validation exit0 before implementation.

## 2. Atomic correction
- [x] 2.1 Update canonical sudo launch only; existing focused tests cover absent/present/empty/path characters and cold/resume, no credential argv, direct compatibility.
- [x] 2.2 Update ADR-0010 and active S1a proposal/design/spec siblings to one narrow noncredential exception; no historical rewrite or parent archive.

## 3. Acceptance and integration
- [x] 3.1 Main proves unchanged parked #131 test fails original source for missing TMPDIR and passes corrected source non-skipped on native nonroot Linux; exact-value native checks and zero omp residuals before teardown.
- [x] 3.2 Main runs focused/full server test coverage, typecheck/lint and corrective OpenSpec strict validation; commands exit0. Active-parent validation retains pre-existing HTTP/harness reconciliation errors, with touched spawn omissions repaired (#111 comment5795982481).
- [x] 3.3 Frozen SHA expanded cross-review clean, exact-head CI35871077882 all8green, PR240 merged as56fc05d; selective archive promotes only the corrected uid requirement. #131 resumes separately after this archive merge.

## Risk pack mapping
- Selected Public API / CLI / script entry: 2.1,3.1 argv parser boundary.
- Selected Config / project setup: 2.1 optional and empty env semantics.
- Selected File IO / path safety / overwrite: 3.1 exact paths and shared probe write; filesystem policy is unchanged.
- Selected Auth / permissions / secrets: 2.1,3.1 native sudo and credential exclusions.
- Selected Concurrency / shared state / ordering: 2.1 preserve async spawn/environment snapshot and existing runtime generations; 3.2 regressions.
- Not selected Schema / columns / units / field names: no persisted schema change.
- Not selected Resource limits / large input / discovery: no new limits or discovery.
- Selected Legacy compatibility / examples: 2.1 unchanged direct mode, 2.2 consumers.
- Selected Error handling / rollback / partial outputs: 3.1 shutdown census; 3.2 existing sudo failure tests unchanged.
- Not selected Release / packaging / dependency compatibility: no dependency/package/CI changes; GitHub first-green remains #132.
- Selected Documentation / migration notes: 2.2 and3.3 selective promotion.

## Evidence before review
- #131 comment5795271507: canonical native nonroot RED, loader comparison and disposable repair GREEN; comment5795515817: user approval.
- Actual candidate: native Linux unchanged #131 probe 1/1 passed, exact-value spawn checks 4/4 passed (absent, empty, spaces/colon, literal shell characters), no omp processes after shutdown.
- Node24.13.1 local gates: focused 50/50; server 1213/1213 with coverage; typecheck, lint and anti-drift exit0, zero clones. Linux proof uses Ubuntu24.04 aarch64 container, not #132 GitHub job.
- Pre-review repair: local TMPDIR name shadowed os.tmpdir in one test; fixed binding. Duplicate expected-prefix helpers consolidated into existing test support, independent of production construction; all four consumers migrated.
- Parent baseline strict validation already failed four requirements; touched runtime scenarios restored, leaving three unchanged HTTP/harness failures. No weakened validator or parent archival.
