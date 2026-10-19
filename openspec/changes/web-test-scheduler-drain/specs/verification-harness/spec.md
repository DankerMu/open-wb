# Spec Delta

## MODIFIED Requirements

### Requirement: Web assertions await the committed outcome they check
Web unit-test assertions on DOM that changes only after a route transition commits, or on a side effect performed in a React passive effect or its cleanup, SHALL wait for that outcome itself with a bounded retrying wait (`waitFor`/`findBy*`), not assert it synchronously after awaiting an earlier proxy signal such as `window.location` or the appearance of the next tree. Such waits SHALL NOT be implemented by raising timeouts, adding test retries, or deleting assertions, and assertions that depend on the handoff (for example element identity) SHALL run after the wait. The same rule applies to the `make ui-walk` controlled turn: a server snapshot read over REST SHALL be taken only after an observable precondition proves the content it asserts has reached the store. The fake upstream gate reaching `held` is not such a precondition, because it flips before the first chunk has crossed the model proxy, omp and the supervisor. The browser rendering the first reply part is such a precondition, because the supervisor's commit path persists each event (`persistEvent` → `store.appendDelta`) before it publishes that event to the ring and SSE subscribers (`#publish`). The web test harness SHALL additionally make every RTL wait (`findBy*`/`waitFor`) return only after the React Scheduler work queued up to that point, and the work it cascades into (passive effects and their cleanups, transitions, renders caused by setState inside effects), has run: `web/vitest.config.ts` SHALL register a setup file that wraps RTL's existing `asyncWrapper` and, after the wait's callback resolves and before RTL's own trailing drain, awaits IdlePriority callbacks scheduled on the same `scheduler` module instance that react-dom uses, repeating until no Scheduler task was enqueued between two consecutive idle probes (React schedules renders caused by setState inside effects from a microtask, so a single idle callback can run before that render is enqueued). This barrier is defence in depth: it SHALL NOT replace the per-assertion waits above, it SHALL NOT be implemented by raising timeouts or adding retries, and waits that do not go through `asyncWrapper` (`settle()`, `yieldMacrotask()`, `quiesce()`) are outside it. The server's shared Vitest configuration (`vitest.shared.mjs`) SHALL NOT carry this setup file.

#### Scenario: Route commit lags the URL
- **WHEN** a test navigates, the URL already reflects the new location, and React commits the new location in a later transition
- **THEN** the assertion that the previous view's DOM is gone retries until the commit and passes, and the dependent identity assertion runs afterwards

#### Scenario: Passive cleanup lags the committed tree
- **WHEN** a successful login replaces the login form with protected content and the form's in-flight request is aborted in a passive-effect cleanup scheduled after the commit
- **THEN** the abort assertion retries until the cleanup runs and passes, without a timeout or retry change

#### Scenario: Pre-reload snapshot follows the rendered first part
- **WHEN** `walkHeldDialogue` has the prompt accepted (202) and the fake upstream gate reports `held`
- **THEN** the walk first waits for the running UI prefix (`expectRunningPrefix`: status `运行中`, the assistant body starting with the first reply part, and the `bash` step), and only then fetches the pre-reload REST snapshot and runs `expectRunningSnapshot` with unchanged strength (`running`, user/assistant ids, `content` starting with the first reply part)

#### Scenario: Scheduler work cascaded from the awaited commit has run when the wait returns
- **WHEN** a commit made outside `act` shows the awaited element, its passive effect sets state, the resulting render contains a child that busy-waits longer than the Scheduler's 5 ms frame so the Scheduler yields before that commit's passive effects, and that passive effect records a call
- **THEN** after `await findBy*` for that element the call is already recorded when asserted synchronously; in the ordinary configuration with the setup file removed, the same test fails on every run, because the busy-wait starts after RTL's trailing `setTimeout(0)` is registered and so that timer has expired before the yielded passive effect runs

#### Scenario: Delayed Scheduler ticks no longer reorder web assertions
- **WHEN** the web suite runs with the React Scheduler's `setImmediate` delayed by 3 ms (a scratch `setupFiles` entry that wraps it in `setTimeout` before react-dom loads; the reproduction for #1541)
- **THEN** every test passes, including `previewers-loading`「第一次才加载…」, `chat-permission-tier`「缺省档位是 全部自动…」, `workspace-browser-only-paths`「选中后 file 答 404…」, `chat-message-waiting`「尚无可见块时回合结束…」 and `previewers-archive`「换一个 load…」, which fail under that perturbation without the change
