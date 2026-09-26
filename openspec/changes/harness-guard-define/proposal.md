## Why
#414: the Makefile contract oracle in `scripts/test-ci-harness.sh` `contract()` (`:92`, `freeze_block`) misses a bare multi-line `define NAME … endef` placed outside a freeze block.
- Why it gets through:
  - the `define` line has no `=` and no `$`, so it is not treated as an assignment;
  - `define` is not in the stray-directive tuple `("export", "unexport", "override", "undefine")`;
  - a body without `$` or a second `:` is not taken for a rule header.
- Effect: GNU Make treats the variable as defined, so the `?=` default does not apply and `$(value …)` freezes the `define` body. The #414 repro (read-only copy, GNU Make 3.81) shows `SMOKE_BASE_URL := http://evil` under `make -pn smoke`. The same holds for `UI_WALK_BASE_URL`, `UI_SHOTS_BASE_URL` and `UI_SHOTS_OUT`, and the guard still exits 0.
- Operator forms (`define NAME :=` / `define NAME =`) are already rejected, and so is `undefine`.
- The promoted spec (`openspec/specs/verification-harness/spec.md` `控制面 oracle 校验 base URL 冻结块的存在与顺序`) promises "块外 SHALL NOT 存在……赋值行" — `define` is a multi-line assignment, so the spec promises more than the code checks. Its "各组默认值" wording is also inexact: `UI_SHOTS_OUT` has no `?=` default by design (`Makefile:77`).

## Triage
Issue type: bug (guard blind spot)
Fixture level: compact
Upstream suggested level: absent (compact: one tuple entry plus four mutations plus spec wording)
Blast radius: `make test-guardrails` only. It is local (not wired into CI); product and runtime are unaffected. The current Makefile has no `define` lines, so it keeps passing.
Selected risk packs: none beyond test evidence (mutation self-proof).
Evidence floor:
- the four new `cm` mutations are each rc=1;
- the unchanged Makefile is rc=0;
- `make test-guardrails` all PASS locally;
- `make check` green.

## What Changes
- `scripts/test-ci-harness.sh` `contract()`: the stray-directive tuple becomes `("export", "unexport", "override", "undefine", "define")`. The code is an encoded one-line Python string at `:92`, so edit it without changing anything else.
- Four `cm` mutations in the existing style, each expecting rc=1. Each inserts `define <VAR>\nhttp://evil\nendef` right after `SHELL := /bin/bash`, which is before every `?=` default so the mutation is a real override, for `SMOKE_BASE_URL`, `UI_WALK_BASE_URL`, `UI_SHOTS_BASE_URL` and `UI_SHOTS_OUT`.
- Spec: verification-harness MODIFIED `控制面 oracle 校验 base URL 冻结块的存在与顺序`:
  - it lists `define` (including bare multi-line) among the stray forms;
  - it corrects the default-line wording for `UI_SHOTS_OUT`;
  - it adds the scenario `块外裸 define 被拒`.

  The active parent change does not contain this requirement.

Must preserve:
- every existing `cm` mutation and positive control keeps its expected rc;
- the unchanged Makefile passes;
- no Makefile change.

Out of scope: replacing the oracle with a Make parser or `make -p` diffing; wiring `test-guardrails` into CI.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: MODIFIED `控制面 oracle 校验 base URL 冻结块的存在与顺序`.

## Impact
`scripts/test-ci-harness.sh` only.
