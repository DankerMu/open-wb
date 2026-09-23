## ADDED Requirements

### Requirement: 手动真实上游冒烟入口
`make smoke-live` SHALL consume an already-running service without build/start/stop. If MODEL_UPSTREAM_BASE_URL or MODEL_UPSTREAM_API_KEY is absent or empty, it SHALL exit nonzero and identify the missing variable without printing its value or executing Hurl. Required values SHALL be transferred literally through Make and quoted shell expansion, without evaluating Make/shell syntax in their bytes. After gates, missing Hurl SHALL produce explicit installation guidance. Hurl SHALL run in a clean child environment containing only PATH, with `--test --jobs 1 --retry 0`, `base_url` from raw SMOKE_BASE_URL, `content_pattern=^.+$`, `min_bash_steps=0`, and only `smoke/chat.hurl`. Upstream gate values SHALL NOT appear in Hurl args/environment or diagnostics. Hurl failure SHALL propagate nonzero. Existing `make smoke` recipe SHALL remain unchanged in this slice.
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
