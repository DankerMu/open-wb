## Risk Packs
- Config / project setup — selected: Makefile control-plane contract for SMOKE/UI_WALK freeze+export → 1.1, 1.2, 2.1.
- Legacy compatibility — selected: baseline rc=0, all existing `cm` cases unchanged, no Makefile change → 2.2.
- Public API, Schema, File IO/path safety, Auth/secrets, Concurrency, Resource limits, Error handling, Release, Documentation — not selected: guard-internal change; Makefile and CI behavior untouched.

## 1. Implementation
- [x] 1.1 `scripts/test-ci-harness.sh:92` `contract()`: `smoke_block` / `ui_walk_block` exact contiguous ordered checks followed by the target header, plus stray-directive rejection, mirroring `ui_shots_block` (shared helper preferred).
- [x] 1.2 `cm` mutation cases, expected rc=1, for each of SMOKE and UI_WALK: drop `?=`; drop override; drop export; export before override; duplicated block; stray `export <VAR>` after the target; stray-rule-only cases `unexport <VAR>` (anchored on `'precommit: guard'`) and a whitespace variant (`export  SMOKE_BASE_URL` / `export\tUI_WALK_BASE_URL`).

## 2. Verification
- [x] 2.1 Local `make test-guardrails` output lines showing each new mutation rc=1 (CI does not run this target, so the pasted local output is the evidence); before the 1.1 change, show the drop-override, drop-export and `unexport` mutations were rc=0 (the blind spot), then rc=1 after. Also show that removing only the stray-directive rule from the new check makes the `unexport`/whitespace cases rc=0 again (proves that rule is load-bearing), then restore.
- [x] 2.2 Baseline `contract "$oracle_root"` rc=0; every pre-existing `cm` case keeps its result (incl. UI_SHOTS `:159-168` and the `:121`/`:168` rc=0 positive controls); local `make test-guardrails` exit 0 with its summary pasted.
- [x] 2.3 `make lint`, `make anti-drift` exit 0; `git diff --stat` touches only `scripts/test-ci-harness.sh` and this change.
