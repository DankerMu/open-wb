## Context
Current ci-compiled-server owns a server PID and a separate harness PGID; neither automatically owns an arbitrary background upstream. Existing fake-upstream supports POST chat endpoints and 401 without bearer, not healthz. The host has pinned omp/18.0.10 and Hurl8.0.1.

## Goals / Non-Goals
- Goal: each CI job fetches verified omp, starts its own fake upstream before compiled service, runs the existing Make target and reaps only owned processes on success/failure/cancellation.
- Goal: independent chat.hurl proves authenticated create201/prompt202/full completed history, exact fake text, bash>=1 and all steps done, foreign-account404 and missing-bearer401.
- Non-goals: product fixes, fake-omp replacement for real acceptance, UI dialogue steps, control-plane mirrors, dependency changes or new action/cache.

## Decisions
- Governing invariant: green means real pinned-runtime dialogue and owned lifecycle finished; missing prerequisites, assertion failures, early death or cleanup defects never become success.
- Keep existing process-group/cancel semantics and add upstream ownership through the existing teardown owner, not a detached job step or blanket pkill. Use ci-fake-upstream.sh as the single launcher of the existing fixture; do not duplicate the HTTP fake.
- Use explicit loopback job-local ports and runner-temp DB/omp state/sandbox roots; OMP_BIN points at the verified repository var/omp/omp artifact. Paths are quoted. No caller HOME/credentials forwarded by new harness plumbing.
- Establish bounded upstream readiness using its real protocol (expected unauthorized chat POST or parsed bound address plus live probe), and reject early exit/occupied-port confusion. Diagnostics must not leak cookies, generated bearer tokens or secrets.
- Keep global Hurl retry0/jobs1; bound polling on the one messages GET entry only. Assertion must bind the captured assistant ID, not an arbitrary previous assistant. Both identities logout so no auth-session rows leak.
- Make smoke preserves clean PATH-only invocation and raw baseURL; adds literal exact content_pattern and min_bash_steps1, then chat.hurl after public/auth. smoke-live remains byte-for-byte unchanged.
- Preserve all existing exact oracle cases and update only affected expected tuples/anchors. Qualify new oracle changes with semantically wrong candidates, not missing-file/setup failures.
- User scope decision: prohibit secrets in smoke/ui-walk; preserve secret-scan GITHUB_TOKEN and four-action matrix/counts.
- Sibling surfaces: both CI modes, install/fetch failure, startup/readiness, server early-exit, harness PGID, upstream and omp termination, signals during each lifecycle phase, static fixture vs web/dist, public/auth independent cookies, downstream #106/#107 and blocked #130.

## Required evidence
- Parent first runs newly added contract/behavior assertions against pre-implementation source, then production candidate; writer pauses at test-only handoff. Missing entry is setup RED, not semantic proof.
- Real compiled server + verified v18.0.10 + fake upstream: make smoke twice returns0, chat-only invocation starts with empty cookies, all exact responses pass. Run existing make ui-walk against its real static build without adding #106 steps.
- Wrong text, absent/failed bash step, foreign-account exposure, unauthenticated proxy access and nonterminal assistant must reject the chat oracle. Restore GREEN and one dedicated unchanged stability run; retain raw results.
- Exercise wrapper success, upstream start/early-death/readiness failure, server/harness failure and cancellation; observe bounded nonzero and no owned process residue, with unrelated sentinel process untouched. Full existing guardrails remain GREEN, including cancellation/escalation tests.
- Freeze oracle/candidate/reference hashes and toolchain identities; parent-controlled external evidence and independent exact-head CI. No claim of OS-enforced enclave on this checkout.

## Risks / Trade-offs
- Actual pinned binary may expose a previously hidden integration defect → retain real failure and stop source edits at product boundary; never substitute fake-omp or relax assertions.
- Hurl polling is bounded eventual-consistency observation, not command replay; POST prompt remains once.
- Existing cancellation tests use controlled processes; retain those plus actual owned-runtime teardown evidence.

## Migration Plan
One atomic source PR; rollback is revert of the entire integration slice. Separate canonical archive PR after source CI/merge. #106/#107 remain unpromoted.

## Open Questions
No unresolved user scope decisions. Any native-runtime incompatibility is an evidence-driven prerequisite, not permission for product edits.
