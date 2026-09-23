## Context
Base1a1837a8d42fceb80818d418edfa0842b07346d5. Makefile49–61 already freezes SMOKE_BASE_URL via $(value), exports raw bytes and invokes Hurl through /usr/bin/env -i PATH only. scripts/test-ci-harness.sh contract() parses exact protected Make targets and recipes; mutation generation failures are not rejection evidence. This same owner must protect smoke-live, including spaced duplicate headers.

## Decisions
- Gate MODEL_UPSTREAM_BASE_URL and MODEL_UPSTREAM_API_KEY separately before Hurl discovery/invocation; empty and absent are missing. Diagnostics contain the missing variable name, never value. No network probe of configured upstream, no server build/start/stop.
- The upstream values are operator environment/CLI prerequisites for the already-running service, not Hurl arguments. For each variable, check `ifneq ($(origin VAR),undefined)` before applying `override VAR := $(value VAR)` and `export VAR`; undefined variables remain absent on unrelated targets. Parent evidence rejected unconditional empty exports (make dev configuration failure) and target-local freezes (GNU make3.81 evaluated CLI-only function bytes). The origin-guarded form passes environment, mixed and CLI-only inputs plus unchanged default startup. Shell expansion stays quoted; Hurl/discovery children receive only PATH via env-i; exact argv and nonzero result propagation remain.
- Preserve existing smoke/ui-walk/omp-fetch behavior and exact recipes. Add smoke-live to protected header set, exact recipe checks, .PHONY count and all required mutations. Duplicate `smoke-live :` must be rejected rather than silently overriding.
- Existing shell-embedded Python contract stays at its owner. Require the two exact origin blocks once, substitute analysis-only markers, and let the existing conditional/define depth checks require both markers at top level. Erasing blocks was rejected by a real define-wrapper counterexample; markers preserve activation context. Reject preexisting/duplicate markers and extra MODEL freeze/export directives, then retain original protected-header/recipe parsing on the same indexed lines. No unrelated CI grammar redesign. Parent retains mutated Makefile bytes and hashes with independent rejection receipts.

## Scope and verification limits
smoke/chat.hurl does not exist yet and is explicitly delivered by #105. #94 proves manual command gating/invocation, not live model conversation completion. Positive boundary proof is real Make→clean child process recording argv/environment/exit; no fake production Hurl or placeholder chat fixture is committed. The queue's #105 will exercise the actual Hurl fixture and real omp18 against the controlled upstream. Real upstream secret/network use is not required or silently attempted in this issue.

## Risk / Evidence
- Public command/config + Error: missing-both/missing-one/empty -> nonzero, name diagnostic, no Hurl call; missing Hurl guidance; downstream exit propagation.
- Credential/input: sentinel gate values absent from output/child env/argv; raw baseURL with quotes/semicolons/$(shell ...) preserved byte-for-byte without execution. Gate values likewise never evaluated.
- Compatibility/resource: only caller-owned service; existing make smoke recipe byte-identical, no process/service lifecycle introduced. Missing gate variables remain absent from unrelated make dev, and actual compiled startup configuration still resolves defaults; origin checks prevent global empty settings while raw exports preserve CLI-only values.
- Oracle: baseline currentcontract GREEN; updated contract requires newtarget, wrong recipe/duplicate/.PHONY mutation RED; make test-guardrails completeGREEN plus parent independent runtime cases.
- Domain cross-service/offline: relative repo fixture, no credential injection to child; no new externaldependency. Auth/sandbox/SQLite/browser/process-runtime packs not selected, unchanged.

## Delivery
Single implementer current checkout, parent validation and compact review, exact-head CI then source merge and independent archive PR/CI. No worktrees. Rollback by reverting source PR, no persisted data change.
