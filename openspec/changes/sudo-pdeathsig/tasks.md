## Risk Packs
- Auth / secrets — selected: sudoers launcher rules, allow/deny check, no credential in argv → 1.4, 2.3.
- Legacy compatibility — selected: direct spawn unchanged; sudo options before `--` unchanged; absent-ompUser path unchanged → 1.1, 1.2, 2.1.
- Concurrency / ordering — selected: SIGKILL of sudo reaps omp via pdeathsig → 1.5, 2.4.
- Config — selected: setpriv precondition at config and spawn when ompUser present → 1.2, 2.2.
- Release — selected: CI provisioning and deployment sudoers form change → 1.4, 1.6.
- Documentation — selected: ADR-0010 supplement incl. residual risks → 1.6.
- Public API, Schema, File IO, Resource limits, Error handling — not selected: no API/data change; failure paths reuse existing generic config failure and spawn rejection.

## 1. Implementation
- [x] 1.1 `process.ts` sudo argv inserts `/usr/bin/setpriv --pdeathsig KILL --` before OMP_BIN.
- [x] 1.2 Shared setpriv precondition in `process-path.ts`, called from `agent-config.ts` and `spawnOmp` when ompUser present.
- [x] 1.3 Tests: `sudoPrefix()` helper; inline-literal argv case in `omp-process.test.ts`; config/spawn precondition cases.
- [x] 1.4 `ci-uid-isolation.sh`: rule generator (runner + check-only user), argument-position escaping, `sudo -l -U` allow/deny check before preflight; `test-ci-harness.sh` contracts, fake sudo `-l` emulation reading `$sudoers_src`, launcher-drop mutation, wrong-rule-fails-early case.
- [x] 1.5 `uid-isolation.test.ts` SIGKILL reaping case per design.
- [x] 1.6 ADR-0010 supplement.

## 2. Verification
- [x] 2.1 Argv tests green; process.ts launcher mutation red (inline-literal case).
- [x] 2.2 Precondition tests green (missing launcher fails before effects; absent ompUser unaffected).
- [x] 2.3 `bash scripts/test-ci-harness.sh` green incl. launcher-drop mutation; CI rule check allow/deny.
- [x] 2.4 CI uid-isolation job green incl. SIGKILL reaping case and `make smoke`.
- [x] 2.5 `npm --workspace server run test`, `make lint`, `make typecheck`, `make anti-drift` exit 0.
