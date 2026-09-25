## Why
#392 — the `contract()` oracle in `scripts/test-ci-harness.sh:92` (run by `make test-guardrails`) only allow-lists the SMOKE/UI_WALK freeze lines through `safe_overrides`; it never checks that they exist. A read-only mutation run in the issue showed `contract` returning rc=0 after deleting any of `SMOKE_BASE_URL ?= …`, `override SMOKE_BASE_URL := $(value SMOKE_BASE_URL)`, `export SMOKE_BASE_URL` and the UI_WALK equivalents (`Makefile:49-54`, `:65-68`); `export X` lines are not inspected at all. The `Makefile` comment promises a `$(value)` freeze then export; a scratch GNU Make probe shows that dropping the override makes `make t 'X=$(shell echo PWNED)'` expand the shell call, and dropping the export leaves the recipe with an empty base URL. The guard is green in both cases.

#298 (merged) added the pattern to follow for `UI_SHOTS_*`: an exact, contiguous, ordered `ui_shots_block` directly followed by the `ui-shots` target header, plus rejection of stray `UI_SHOTS_*` directive lines outside the block, with drop/reorder/duplicate mutations in the `cm` list. This change applies the same shape to SMOKE and UI_WALK so all three groups use one mechanism, as #392 recommends after #298.

## Triage
Issue type: test (guard hardening)
Fixture level: compact
Upstream suggested level: absent (compact: one guard function in one script plus mutation cases; no Makefile behavior change). Not the profile's "smoke/UI harness, CI/production configuration" expanded trigger: that names the `make smoke`/`make ui-walk` runtime surfaces (Hurl, Playwright, Makefile recipes) and CI config, none of which change; this is a local-only guard's internal oracle.
Blast radius: `make test-guardrails` only — it is not run by CI (`ci.yml` fast-checks runs biome/ruff/typecheck; no hook or `make check` calls it; `AGENTS.md`/`constraints.yaml` mark it manual). A too-strict or too-loose oracle is exposed only by a local run, so the evidence must be pasted output of that run.
Selected risk packs: Config / project setup (Makefile control-plane contract); Legacy compatibility (baseline `contract "$oracle_root"` rc=0 and every existing `cm` case keep their expected results; Makefile semantics unchanged).
Evidence floor: new `cm` mutations each expected rc=1 and observed rc=1; baseline rc=0; `make test-guardrails` green; `make lint`, `make anti-drift` exit 0; `git diff --stat` touches only `scripts/test-ci-harness.sh` (plus this change).
design.md omitted (compact).

## What Changes
- Implementation note: the SMOKE block is not contiguous in raw text (`Makefile:50` `?=` and `:54` override are separated by comment lines `:51-53`), so the `makefile.count(block) == 1` whole-text form used for `origin_url_block` (suggested in the issue) would fail the baseline; the check must run on `active_make` (comments/blank lines dropped) like `ui_shots_block`.
- In `contract()`, next to `ui_shots_block`: `smoke_block = ["SMOKE_BASE_URL ?= http://127.0.0.1:3000", "override SMOKE_BASE_URL := $(value SMOKE_BASE_URL)", "export SMOKE_BASE_URL"]` and `ui_walk_block = ["UI_WALK_BASE_URL ?= http://127.0.0.1:3000", "override UI_WALK_BASE_URL := $(value UI_WALK_BASE_URL)", "export UI_WALK_BASE_URL"]`, each checked exactly like `ui_shots_block` on `active_make`: all lines present once, contiguous, in order, immediately followed by the `smoke` / `ui-walk` target header; and no other active directive/assignment line whose tokens start with `SMOKE_BASE_URL` / `UI_WALK_BASE_URL` outside its block (recipe lines unaffected — they start with a tab and a command, not a directive). Prefer one small helper used by all three groups over three copies.
- New `cm` mutation cases (expected rc=1), per group: drop the `?=` line, drop the override line, drop the export line, export before override (reorder), block duplicated, stray `export X` after the target; plus cases only the stray-directive rule can reject (they pass the ordered block check): `unexport SMOKE_BASE_URL` / `unexport UI_WALK_BASE_URL` appended (anchored like `scripts/test-ci-harness.sh:166` on `'precommit: guard'`) — rc=0 on today's contract — and a whitespace variant (`export  SMOKE_BASE_URL` with two spaces, `export\tUI_WALK_BASE_URL`).
- `safe_overrides` keeps its entries (it still guards against unknown assignments); presence/order now come from the block check.

Must preserve: baseline `contract` rc=0 on the current Makefile; all existing `cm` cases (UI_SHOTS, MODEL_UPSTREAM origin blocks, AGENTS/constraints mutations) keep their current expected results — if a shared helper replaces the inline `ui_shots_block` code, every UI_SHOTS case at `scripts/test-ci-harness.sh:159-168` including the `:168` rc=0 positive control must keep its result; no `Makefile` change; `make smoke`/`make ui-walk` semantics unchanged. Out of scope: UI_SHOTS and MODEL_UPSTREAM checks (already exact), Makefile behavior.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: ADDED requirement that the control-plane oracle rejects a Makefile missing, reordering or duplicating the SMOKE/UI_WALK freeze-and-export lines (ADDED rather than MODIFIED because the active `s1e-frontend-parity` change restates `CI 接线与控制面同步`).

## Impact
`scripts/test-ci-harness.sh`. No production, Makefile or CI workflow change.
