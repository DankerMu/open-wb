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
- [ ] 1.1 Single implementer test-only handoff for controlled upstream gate behavior; parent runs baseline and discriminator against current implementation before gate edits.
- [ ] 1.2 Implement isolated bounded gate in existing test upstream and extend existing UI journey; preserve old fixture defaults/error oracle and no product edits.

## 2. Parent acceptance
- [ ] 2.1 Run paired gate tests and existing fake-upstream/model-proxy consumers; qualify identity/lifecycle wrong behavior and restoration, no hidden skips.
- [ ] 2.2 Build actual apps and run official18.0.10 journey twice: gate-held prefix/bash/serverrunning before reload and after same-session reload, native reconnect, explicitrelease then exacttext/bashdone/sessiondone, completedreload two messages, exact browsererror oracle; retain screenshot.
- [ ] 2.3 Qualify browser false-positive candidates and restore/stability; real three-file smoke unchanged, scoped lint/typecheck/guards/strictspec; bind protectedproduct and oracle hashes.
- [ ] 2.4 Expanded independent source review and exact-head CI ui-walk/all-checks passed.

## 3. Delivery
- [ ] 3.1 Merge source/close106, update parent6.3, independently archive via PR/CI before107.

Evidence /tmp/open-wb-issue106-evidence. User approved fake-upstream/pairedtests/necessarytestwiring scope extension; no product code. Parent owns checks; writers skip all validation/formatting/commits and reviewers remain read-only. No concrete ReturnType-derived contracts. Characterization of verification code requires known-good/wrongbehavior discrimination, not manufactured production regressions.
