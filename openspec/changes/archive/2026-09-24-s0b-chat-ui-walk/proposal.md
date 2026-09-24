## Why
#106 must prove a real in-flight reload, not a race against an immediately finishing fake reply. The current upstream synchronously writes all text frames; a controlled test-only hold enables honest running-state observation while retaining real omp/proxy/SSE/browser behavior.

## Triage
Issue type: test
Fixture level: expanded
Upstream suggested level: none (override: browser reload/state transitions plus test HTTP control resource lifecycle and real cross-process acceptance).
Selected risk packs: API/CLI, config, auth/secrets, concurrency/state, resource/error cleanup, legacy compatibility, documentation; browser/process/network domain.
Evidence floor: real pinned18.0.10 browser journey with gate-held REST running before/after reload, native reconnect, exact completion and final reload, preserved error oracle, qualified bad behaviors, local and exact-head CI.

## What Changes
- Extend existing journey with create/send/bash card, real running reload, resumed completion and completed reload.
- User explicitly approved scope extension to existing fake-upstream plus paired tests/necessary harness wiring for isolated bounded pause/release. No product source changes.
- Preserve existing login/four routes/theme/logout and exact two expected401/error classification.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `chat-harness`: permanent browser dialogue walk.
- `verification-harness`: fully restated UI walk requirement only.
- `omp-test-harness`: controlled fake-upstream hold/release seam, default responses unchanged.

## Impact
Primary `web/e2e/ui-walk.spec.ts`; existing `server/test/support/fake-upstream.mjs` and declaration owner; paired fixture tests (current test file762lines: use coherent separate gate test file rather than exceeding800). Necessary test harness wiring only if existing MODEL_UPSTREAM_BASE_URL/API_KEY cannot be reused. No product code, deps, action versions, thresholds or #107 control-plane mirrors. Existing upstream consumers and chat.hurl must retain behavior.
