## Why
Issue #94 adds the manual smoke-live command surface without altering the normal smoke suite, CI or deployment. The command must fail closed before any Hurl execution when required upstream configuration is missing and must never pass those credentials to Hurl.

## What Changes
- Add smoke-live env gates and exact Hurl argv: one job, global retry0, only smoke/chat.hurl, shape variables content_pattern=^.+$ and min_bash_steps=0.
- Preserve existing raw SMOKE_BASE_URL transfer and clean PATH-only Hurl child environment; add raw handling for gate values so Make/shell do not reinterpret their bytes.
- Update .PHONY/header and the existing Make contract oracle/negative mutations atomically.

## Capabilities
### New Capabilities
- `chat-harness`: manual smoke-live command contract only.
### Modified Capabilities
None. HTTP chat fixture/normal smoke and CI wiring remain #105; control-plane mirror rows remain #107.

## Impact
Only Makefile and Make-related parts of scripts/test-ci-harness.sh plus this fixture/parent receipts. No CI, dependencies, server/web, AGENTS/constraints, existing smoke recipe changes.
Fixture **compact**, raised from issue's none suggestion because Make interpolation, credential non-disclosure, argument transport and command discovery introduce a concrete public command/error boundary. Harness itself remains the main executable verifier; one compact source review is appropriate. Existing guard implementation is extended, not replaced.
