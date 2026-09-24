## Risk Packs
- API/CLI selected: test-only HTTP control and existing Make journey →1.1–2.3.
- Config selected: reuse runner MODEL_UPSTREAM vars, explicit test origin, default no gate →1.2,2.2.
- File IO not selected: no new path/publish behavior; screenshot/evidence parent-owned outside repo.
- Schema not selected: no product DTO/storage change; named test contracts only.
- Auth/secrets selected: gate bearer, no app/browser credential leakage, existing login/error oracle →1.1,2.1–2.3.
- Concurrency/shared state selected: gate correlation, concurrent ownership, reload/reconnect ordering →1.1,2.1,2.2.
- Resources/errors selected: TTL/capacity/disconnect/delete/close cleanup and finally paths →1.1,2.1.
- Compatibility selected: default fake streaming, model-proxy tests, smoke, old full browser journey/error oracle →2.1–2.3.
- Packaging not selected: official18.0.10/Node/Hurl/action/dependencies unchanged; verify existing pinned identity in2.2.
- Documentation selected: scoped spec promotion and parent6.3 receipt →3.1.
- Domain browser selected: actual navigation/reload/SSE/persistence/error budget →2.2,2.3.
- Domain process/network/offline selected: realomp/proxy/localupstream, caller-owned services, no external model →2.2.
- Domain tenant/auth selected only existing account/session correctness and gate isolation →2.1,2.2; production sandbox/uid/migration/catalog not changed.

## 1. Fixture and implementation
- [x] 1.1 Single implementer test-only handoff; parent actual HTTP test observed marked final response complete all three parts instead of first prefix (10fail/1pass), distinct from missing control endpoint setup RED.
- [x] 1.2 Existing fixture gained isolated bounded gate and journey gained actual held reload; existing defaults/error classifier and product hashes preserved.

## 2. Parent acceptance
- [x] 2.1 Paired gate plus legacy fake/model-proxy tests38/38 passed. Five disposable wrong implementations (no hold, wrong owner release, missing disconnect cleanup, missing expiry, cap off-by-one) rejected semantically; restored11/11 and dedicated stability11/11.
- [x] 2.2 Actual built app/official18.0.10 journey twice passed1/1: held running/prefix before and after same-session reload, post-open recovery finished before release, no further REST until native suffix/done, completed reload; screenshot browser-completed.png inspected, old browser error oracle passed.
- [x] 2.3 Actual native text.delta suppression after reload left only prefix and failed exact final text; injected console.error failed unchanged error oracle; restored and independent stability passed. Wrong message.delta event-name initial mutant did not modify behavior, survived and receives no qualification credit. Real smoke3files/22requests, scoped static/types/knip/jscpd0clones, fullguards563PASS and strictspec passed; hashes bound externally.
- [ ] 2.4 Expanded independent source review and exact-head CI ui-walk/all-checks passed.

## 3. Delivery
- [ ] 3.1 Merge source/close106, update parent6.3, independently archive via PR/CI before107.

Evidence /tmp/open-wb-issue106-evidence. User approved fake-upstream/pairedtests/necessarytestwiring scope extension; no product code. Parent owns checks; writers skip all validation/formatting/commits and reviewers remain read-only. No concrete ReturnType-derived contracts. Characterization of verification code requires known-good/wrongbehavior discrimination, not manufactured production regressions.

Evidence notes: first abort test read server gate before close notification; bounded actual404 observation now detects cleanup and missing-onClose mutant fails. Initial types exposed exactOptional/unsupported withResolvers/Response.timing/current locator options and one extracted type omission; final owner types compile with unchanged compiler settings. Gate tests originally duplicated existing SSE parser; canonical test-only fake-upstream-helpers.ts now serves both consumers while expected output literals remain independent of producer. Parent formatting only; writer reported no validation runs. Source diff exceeds400-line review-only guidance because user-approved gate lifecycle plus browser/paired fault oracles form this atomic verification slice; no thresholds changed.
