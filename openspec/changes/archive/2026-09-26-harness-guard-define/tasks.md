## Risk Packs
- None selected: guard-only change. The evidence is mutation self-proof plus the unchanged Makefile staying green → 1.2, 2.1.

## 1. Implementation
- [x] 1.1 `scripts/test-ci-harness.sh:92` `contract()`: in the encoded Python, change the stray-directive tuple `("export", "unexport", "override", "undefine")` to `("export", "unexport", "override", "undefine", "define")`. The tuple appears once. Confirm by decoding and diffing the embedded source before and after; nothing else may change.
- [x] 1.2 Add four `cm` mutations next to the existing base-URL mutations (`:161-170` area), one per variable, each expecting failure (the default rc).

  Anchor them on `SHELL := /bin/bash`, which precedes every `?=` default. For example:

  `cm "contract Make smoke define mutation" Makefile 'SHELL := /bin/bash' $'SHELL := /bin/bash\ndefine SMOKE_BASE_URL\nhttp://evil\nendef'`

  and the same for `UI_WALK_BASE_URL`, `UI_SHOTS_BASE_URL` and `UI_SHOTS_OUT`. Add one more variant with a leading tab before `define` (e.g. `$'SHELL := /bin/bash\n\tdefine SMOKE_BASE_URL\nhttp://evil\nendef'`, modelled on the tab-led override mutation at `:165`) to pin the whitespace path. Follow the file's existing line and grouping style (several `cm` per line separated by `; ` where neighbours do).

## 2. Verification
- [x] 2.1 RED: with only 1.2 applied (tuple unchanged), the four new mutations report that the guard did not fail. Record the output lines. After 1.1 all four pass, and every existing mutation or positive control is unchanged.
- [x] 2.2 `make test-guardrails` exits 0 with all PASS; record the PASS count before and after (+5). Optionally (read-only, on a scratch copy) confirm with `make -pn smoke` that the mutation really changes `SMOKE_BASE_URL`, as the issue's repro shows.
- [x] 2.3 `make lint`, `make typecheck`, `make test` and `make anti-drift` exit 0. `openspec validate harness-guard-define --strict --no-interactive` passes.
