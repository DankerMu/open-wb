## Why
Issue #98 provides the credential-isolated model boundary needed by sessions: omp sends only a per-runtime bearer, while app-server alone supplies the upstream API key. #88 and #84 are merged and archived.

## Triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree: public parser/auth/streaming credential boundary)
Blast radius: unauthorized model use, request-byte corruption, leaked credentials, buffered/truncated streams or live sockets after cancellation.
Selected risk packs: public API, config, schema, auth/secrets, ordering/concurrency, resource limits, compatibility, error handling, release, documentation.
Evidence floor: staged test-first semantic RED; real upstream HTTP and downstream streaming boundary; qualified independent oracle, fullserver/static gates and same-SHA CI. VDD Construction/Critical for credential boundary.

## What Changes
- Add registerModelProxy(app,{upstream,tokens}) and model-proxy-owned TokenLookup={lookup(token:string):string|null}; no sessions imports.
- Auth first, raw JSON request bytes and content-type forwarding, replaced Authorization, bounded4MiB input, streaming non5xx responses and no-store.
- User decision: upstream5xx becomes local502 agent_unavailable; invalid bearer stays401 even if upstream config is absent. Source: issue98 comment5750569111 and current conversation.
- Connection-establishment deadline10s (DNS/TCP/TLS), cancellation and owned-resource teardown; no response-header/TTFT or whole-stream timeout and no retries.
- Synchronize conflicting parent spec/design text to those explicit user decisions before freezing tests.

## Capabilities
### New Capabilities
None.
### Modified Capabilities
- model-proxy: add the proxy endpoint requirement alongside the already-canonical fake-upstream requirement. Do not modify the fake fixture requirement.

## Impact
New server/src/model-proxy/index.ts, paired server/test/model-proxy*.test.ts and a small shared model-proxy test helper only if needed. Existing raw-http helpers/patterns should be reused. No changes to auth, guard, app/server assembly, TokenRegistry, models.yml, fake-upstream/fake-omp, dependencies, compiler/test configs, thresholds or CI.
The module imports canonical core/errors for typed errors; HTTP error mapping is supplied by the existing app caller. Human per-issue review waiver applies; agent/CI/final Epic functional review remain.
