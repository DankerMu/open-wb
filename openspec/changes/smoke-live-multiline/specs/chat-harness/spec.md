## MODIFIED Requirements

### Requirement: 手动真实上游冒烟入口
`make smoke-live` SHALL consume an already-running service without build/start/stop. If MODEL_UPSTREAM_BASE_URL or MODEL_UPSTREAM_API_KEY is absent or empty, it SHALL exit nonzero and identify the missing variable without printing its value or executing Hurl. Required values SHALL be transferred literally through Make and quoted shell expansion, without evaluating Make/shell syntax in their bytes. After gates, missing Hurl SHALL produce explicit installation guidance. Hurl SHALL run in a clean child environment containing only PATH, with `--test --jobs 1 --retry 0`, `base_url` from raw SMOKE_BASE_URL, `content_pattern=(?s)^.+$` (dot-all, so a real model's multi-line reply matches; the reply must still be non-empty), `min_bash_steps=0`, `skip_turn_control=true`, and only `smoke/chat.hurl`. Upstream gate values SHALL NOT appear in Hurl args/environment or diagnostics. Hurl failure SHALL propagate nonzero. The existing `make smoke` recipe SHALL change only by gaining `--variable "skip_turn_control=false"` (S1c A) and by appending `smoke/session-meta.hurl` as its last argument, directly after `smoke/files.hurl` (S1c B), so that its Hurl file arguments are exactly `smoke/public.hurl smoke/auth.hurl smoke/chat.hurl smoke/files.hurl smoke/session-meta.hurl` in that order and every other byte of the recipe (the hurl preflight line, `env -i`, flags and `--variable` arguments as left by A) is unchanged; B adds no Make target, no Hurl variable and no CI job, and the `smoke-live` recipe is not changed by B (it still runs only `smoke/chat.hurl`). The Make oracle (`scripts/test-ci-harness.sh`) SHALL pin both updated recipes; when B appends the file, the oracle's expected `smoke` recipe and every mutation decoy derived from it (the variants that today end in `smoke/chat.hurl smoke/files.hurl`, including the `endif`, spaced `smoke :` and `phase2-decoy` redefinition decoys) SHALL be updated in the same PR, so the guardrail suite accepts exactly the new recipe and still rejects each mutation.
The target SHALL be listed exactly once in .PHONY and the command header. The existing Make oracle SHALL protect its exact recipe and reject duplicate/redefined targets, including `smoke-live :`, missing/duplicated .PHONY entries and mutated invocation.

#### Scenario: Missing configuration fails before invocation
- WHEN either required upstream variable is missing or empty
- THEN make exits nonzero with that variable name and no Hurl invocation, without revealing configured values

#### Scenario: Literal clean invocation
- WHEN both gate values are nonempty and Hurl is discoverable
- THEN one clean child receives exact shape-only argv and caller baseURL bytes, no upstream values, and the target returns the Hurl result

#### Scenario: Exact command guard
- WHEN the Make oracle inspects a duplicate spaced smoke-live header, altered recipe or missing .PHONY entry
- THEN it rejects the changed contract; the current complete guardrail suite remains green

#### Scenario: smoke 配方追加会话元数据冒烟
- **WHEN** the Make oracle inspects the `smoke` recipe after S1c B, and separately a candidate that omits `smoke/session-meta.hurl`, places it before `smoke/files.hurl`, adds it to `smoke-live`, or adds a second recipe line for it
- **THEN** the exact recipe ending `smoke/files.hurl smoke/session-meta.hurl` is accepted together with the unchanged `smoke-live` recipe, each candidate is rejected, and `make test-guardrails` stays green on the real Makefile

#### Scenario: AGENTS.md 冒烟证据行随配方同 PR 更新
- **WHEN** the same PR appends `smoke/session-meta.hurl` to the `smoke` recipe
- **THEN** the `HTTP smoke` row in `AGENTS.md` (the row `scripts/test-ci-harness.sh` pins verbatim as the oracle) is rewritten in the same PR to list `session-meta.hurl` as the fifth file with five-file wording, the oracle's expected row text is updated to the identical string, and `make test-guardrails` rejects a Makefile/AGENTS.md pair where only one side changed

#### Scenario: Multi-line reply passes
- WHEN the real upstream answers the first prompt with a done reply whose content contains line breaks
- THEN the `content` assertion of `smoke/chat.hurl` matches under `content_pattern=(?s)^.+$` and the target exits 0; an empty content still fails
