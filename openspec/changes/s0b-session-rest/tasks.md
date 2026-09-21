## 1. Fixture and baseline
- [x] 1.1 Expanded read-only fixture review PASS after one revision: preserve trusted-supervisor-only runtimeState and authorize REST via existing owner-scoped getMessages. Strict validation passed; 120 existing auth/store/http/runtime/config/test identities frozen before A1.
- [ ] 1.2 A1 paired tests before source; record missing-module SETUP if applicable. Separately authorized A2 callable inert route baseline must yield semantic RED at HTTP boundary; preserve original tests and source before B.
## 2. REST boundary
- [ ] 2.1 Implement four routes and owned injectable supervisor port using real auth/store/error contracts; focused GREEN covers payloads, owner isolation, UTF-8/parser boundaries, busy concurrency, compensation and done/failed re-admission.
## 3. Independent acceptance and delivery
- [ ] 3.1 Parent compiled real HTTP + SQLite acceptance with stub supervisor; qualify major failure classes on disposable copies, restore and dedicated stability checks; scoped static/build/type gates and full server coverage without discovery narrowing.
- [ ] 3.2 Expanded correctness/test-evidence+spec/invariant-state review; bounded fix gate; exact-head CI and source PR merge.
- [ ] 3.3 Separate docs-only canonical REST promotion/archive and parent3.5 update; no claim of actual runtime/SSE/startup assembly.
## Core risk mapping
Public API→2.1/3.1 four routes/exact payloads; schema/units→2.1 UTF-8 bytes and public projection; auth/permissions→2.1/3.1 real cookie guard, owner404, no-store; state/order→2.1 pending admission concurrency and terminal re-admission; compatibility→1.1/3.1 sibling auth/parser/store contracts; rollback/errors→2.1/3.1 real DB compensation, original/compensation failures; release→3.1/3.2 compiled HTTP and same-SHA CI; documentation→3.3.
Not selected config/environment/dependencies, filesystem paths, migrations, process spawning: untouched and not assembled. Resource bounding uses existing parser envelope and finite semantic text limit, tested2.1/3.1; no new timers/queues/listeners owned by module.
## Project domain mapping
Selected tenant isolation/auth-session lifecycle, SQLite admission transitions and HTTP envelope compatibility→2.1/3.1. Offline deployability→3.1 local HTTP/stub only, no dependency. Not selected sandbox file boundary, child environment/process lifecycle, model proxy integration or browser routing: #100+ and existing implementations, unchanged here.
## Governance
One writer, current checkout, no new worktree. Source/test changes only via implementer; parent owns fixture/oracles/acceptance. A1/A2/B separately authorized; parent evidence unreadable to writer except writer-owned reports/logs. Freeze neighbors and all verification configuration. No skipped/deleted/relaxed assertions to obtain GREEN. Reviewer read-only, no edits/commits/test runs/nested agents. Implementer skips formatter/linter/types/build/full suites/git; parent owns those final gates. No OS-enclave or release claim. User waived per-issue human review only; final Epic functional review remains required.
