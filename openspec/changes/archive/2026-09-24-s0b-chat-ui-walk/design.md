## Context
Existing fake-upstream emits every final-round frame synchronously; browser-only withholding can fake an in-flight display after server completion. User approved an actual upstream hold, scoped to test code. #105 already passes MODEL_UPSTREAM_BASE_URL/API_KEY to the runner; no new workflow setting should be needed.

## Goals / Non-Goals
- Goal: one real pinned-omp turn remains running across actual browser reload, then resumes to exact original text and durable done state.
- Non-goals: product code, arbitrary sleeps, browser route.fulfill/fake EventSource, server response fabrication, fake-omp acceptance, #107 control-plane edits.

## Decisions
- Governing invariant: refresh occurs while the same authenticated server session is genuinely running and its upstream response is held; only explicit release permits terminal completion.
- Add test-only HTTP gate endpoints on the existing loopback fake server, authenticated by its existing expectedKey, not on app-server. E2E Node request context calls this control origin directly; browser still accesses only production origin.
- Gate protocol: POST /__control/gates/{id} arms unique client-generated UUID id; GET same path returns phase armed/held; POST .../{id}/release succeeds only held; DELETE same path cancels/cleans. Repeated registration409, unknownid404, wrong/no bearer401, invalidid400. TTL30s and maximum32 gates bound forgotten arms; expired/cancelled held responses are destroyed, not falsely completed. Imported server close clears timers/maps and held responses. Timers unref and disconnect cleanup prevent process retention.
- Correlate gate id through a fixed prompt template `WORKBUDDY_UI_WALK:<uuid>` alongside fixed user text. Match only the last user text marker, reuse existing text extraction; no global pause flag or first-request ownership. Unarmed marker/default requests retain existing behavior. Each armed gate binds only one final text response; duplicate concurrent final claims fail explicitly rather than hijack it.
- First tool round unchanged: real bash command executes and steps appear. On marked final text round, write role plus first nonempty text part, mark held, and withhold remaining parts/finish/[DONE] until release. Preserve all final reply bytes and original frame semantics.
- E2E: arm, create via UI, capture session URL and prompt202 IDs, send template, wait held; assert same session REST running and captured assistant prefix/nonterminal plus visible bash and generating state. Reload while gate held; assert same URL/session, freshly fetched running snapshot and prefix DOM, new real SSE connection, then release. Assert exact full assistant text, bash done, session done, one user/assistant pair; reload completed page and assert identical pair/content/state.
- Assert prefix before release and exact text after release to reject snapshot-only/never-reconnected streams; await a post-reload native event-stream request and DOM installation without fabricating frames. Release only after these observable barriers.
- Always delete gate in finally; normal journey retains settings/theme/logout and exact error oracle functions unchanged. Gates have no production route or public network exposure.
- References: fake-upstream.mjs last-user text and framing; ui-walk.spec.ts walkProductionOrigin/attachAuthOracle; conversation-view article/status labels; existing #105 CI runner vars.
- Release fence: after reload observe the native event-stream response/open and its subsequent recovery messages GET; await that response's finished body and assert captured assistant prefix/session running. Every outstanding messages GET must finish while held. From release until final suffix/done DOM assertions, any further messages GET is a failure: completed REST must not supply the completion under test. The later deliberate completed-page reload is outside this no-REST interval. A new SSE request alone is not a sufficient release barrier.

## Evidence
- Characterization-first: preserve old journey GREEN, prove new gate tests fail semantically against current callable HTTP server; missing endpoint401/404 is setup signal only, additionally demonstrate current marked final response completes instead of holding.
- Paired actualHTTP tests cover arm/hold/release bytes, wrongidentity/auth, multiple isolated gates, invalid transitions, abort/delete/close/TTL and capacity. No fake timers for claimed network scheduling; injected bounded expiry option only if needed, named type owner.
- Actual built browser with official18.0.10 and same fixture: twice including screenshot and unchanged zero unexpected console/page errors, explicit running before/after reload and done after release. Full real smoke regression and nearest fixture/model-proxy consumers.
- Parent qualify plausible wrong candidates: no hold, wrong gate released, lost prefix/no post-reload live suffix, changed final text, extra browser error; expected failures must be semantic. Restore and dedicated stability; CI exact-head separately.
- Required browser sensitivity case: a disposable candidate still establishes the native connection and completes the running recovery snapshot, but suppresses post-reload data delivery; it MUST fail on missing final suffix/done, not pass via a completed REST response.
- Parent-owned external evidence/hash identities, no claim of OS-enforced enclave; candidate edits exclude spec/evidence. Review focuses identity, lifecycle and truthful reload proof.

## Risks / Trade-offs
- Unique marker means a fixed prompt template with a correlation UUID rather than ambiguous shared fixed literal; reply remains fixed. No user-facing production contract changes.
- TTL is failure cleanup not a timing mechanism; no acceptance waits for arbitrary sleep to hit the running window.

## Migration Plan
Atomic test-source change, revert as one unit; separately archive only delivered UI/gate requirements after source review/CI/merge.
