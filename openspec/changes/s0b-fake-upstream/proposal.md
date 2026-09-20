## Why
Issue #88 supplies the deterministic HTTP upstream required by model-proxy #98, startup/log-boundary #102 and real-omp smoke #105. Tests and CI must not call a real model vendor.

## What Changes
- Add one zero-dependency Node .mjs fixture with an importable start/close API and standalone FAKE_UPSTREAM_PORT entry.
- Enforce the expected bearer, emit the specified tool-call-first/text-second OpenAI SSE responses, and expose deterministic 401/500 paths.
- Add independent real-HTTP and real-CLI contract tests; no server/src changes.

## Capabilities
### New Capabilities
- `model-proxy`: initially only the fake upstream fixture contract; production proxy and managed models configuration remain later slices.
### Modified Capabilities
None.

## Impact
server/test/support/fake-upstream.mjs and paired contract tests. A minimal .d.mts declaration for that single JS module is allowed if needed by the existing strict TypeScript consumers; no second implementation or compiler/config changes. No dependencies, application routes, CI or Makefile changes.

## Triage
Issue type: test fixture feature.
Fixture level: expanded; agrees with upstream inherited level because real HTTP authentication, streaming and CLI resource ownership cross boundaries.
Blast radius: falsely green model integration, wrong credential boundary, hanging server/child or malformed tool-call stream.
Selected packs: public API/CLI, schema, auth/secrets, concurrency, resources, compatibility, errors, documentation; domain cross-service/offline/process lifecycle.
Evidence floor: test-first semantic RED at actual HTTP boundary; real in-process and standalone HTTP proofs; independent parent smoke and fault qualification; scoped/full-server gates, expanded review and same-SHA CI.
