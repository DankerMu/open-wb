## Why
#94/#105 delivered command behavior while explicitly deferring command mirrors to #107. This atomic slice closes the documented drift and records the S0b same-uid credential exposure without claiming OS isolation.

## Triage
Issue type: test/documentation
Fixture level: expanded
Upstream suggested level: none (override: exact source-derived verification schema and security downgrade ledger are acceptance controls, not prose-only).
Blast radius: AGENTS matrix/enforcement/directory, constraints surfaces/downgrade, Make header and their existing oracle.
Selected risk packs: CLI/config/schema, auth risk disclosure, legacy compatibility, error handling, documentation; domain process/credential/offline boundaries by explicit non-goals.
Evidence floor: baseline oracleGREEN → new requirementsRED on old mirrors → atomic candidateGREEN, independent mirror/downgrade mutantsRED/restored, complete make test-guardrails; unchanged recipes/workflow/products/thresholds.

## What Changes
- Add omp-fetch prerequisite and smoke-live manual verification rows, enforcement entries and dialogue Directory Map descriptions.
- Extend constraints surfaces from8 to10 and register S0b same-uid /proc/config exposure with ADR0010 closure condition.
- Replace deferred Make header and atomically extend exact existing oracle/mutations, no second parser or implementation.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-harness`: control-plane synchronization requirement.
- `verification-harness`: fully restated CI/control-plane requirement preserving actual delivered jobs, including concurrent file harness additions.

## Impact
Only AGENTS.md, constraints.yaml, Makefile header and scripts/test-ci-harness.sh; no runtime recipes, product source, CI job steps, dependencies or gate thresholds. #141 dead RPC doc-link issue remains separate, not silently swept into this slice.
