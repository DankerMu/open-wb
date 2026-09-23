## Context
Base1a1837a8d42fceb80818d418edfa0842b07346d5. Makefile49–61 already freezes SMOKE_BASE_URL via $(value), exports raw bytes and invokes Hurl through /usr/bin/env -i PATH only. scripts/test-ci-harness.sh contract() parses exact protected Make targets and recipes; mutation generation failures are not rejection evidence. This same owner must protect smoke-live, including spaced duplicate headers.

## Decisions
- Gate MODEL_UPSTREAM_BASE_URL and MODEL_UPSTREAM_API_KEY separately before Hurl discovery/invocation; empty and absent are missing. Diagnostics contain the missing variable name, never value. No network probe of configured upstream, no server build/start/stop.
- The upstream values are operator environment/CLI prerequisites for the already-running service, not Hurl arguments. Freeze them only for smoke-live using `smoke-live: override VAR := $(value VAR)`; existing environment/CLI export status is retained. Do not create global empty MODEL_* exports: parent real Make→compiled resolveAgentSettings proof caught default make dev failing on empty injected values. GNU make3.81 rejects combined target `override export`/`export override`; the target-local override form is verified. Shell uses quoted variable expansion; no eval or recipe interpolation. Hurl/discovery children receive only PATH via env -i; --test --jobs1 --retry0 and exact shape variables remain; Hurl status propagates.
- Preserve existing smoke/ui-walk/omp-fetch behavior and exact recipes. Add smoke-live to protected header set, exact recipe checks, .PHONY count and all required mutations. Duplicate `smoke-live :` must be rejected rather than silently overriding.
- Existing shell-embedded Python contract stays at its owner; no unrelated reformat/extraction or CI grammar redesign. Parent independently exercises real Make with a disposable argv/environment recorder in PATH and isolated Makefile copies for wrong-candidate discrimination.

## Scope and verification limits
smoke/chat.hurl does not exist yet and is explicitly delivered by #105. #94 proves manual command gating/invocation, not live model conversation completion. Positive boundary proof is real Make→clean child process recording argv/environment/exit; no fake production Hurl or placeholder chat fixture is committed. The queue's #105 will exercise the actual Hurl fixture and real omp18 against the controlled upstream. Real upstream secret/network use is not required or silently attempted in this issue.

## Risk / Evidence
- Public command/config + Error: missing-both/missing-one/empty -> nonzero, name diagnostic, no Hurl call; missing Hurl guidance; downstream exit propagation.
- Credential/input: sentinel gate values absent from output/child env/argv; raw baseURL with quotes/semicolons/$(shell ...) preserved byte-for-byte without execution. Gate values likewise never evaluated.
- Compatibility/resource: only caller-owned service; existing make smoke recipe byte-identical, no process/service lifecycle introduced. Missing gate variables remain absent from unrelated make dev, and actual compiled startup configuration still resolves defaults; target-local raw overrides cannot leak global empty settings.
- Oracle: baseline currentcontract GREEN; updated contract requires newtarget, wrong recipe/duplicate/.PHONY mutation RED; make test-guardrails completeGREEN plus parent independent runtime cases.
- Domain cross-service/offline: relative repo fixture, no credential injection to child; no new externaldependency. Auth/sandbox/SQLite/browser/process-runtime packs not selected, unchanged.

## Delivery
Single implementer current checkout, parent validation and compact review, exact-head CI then source merge and independent archive PR/CI. No worktrees. Rollback by reverting source PR, no persisted data change.
