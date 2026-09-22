## Why
#100 closes the missing composition between merged REST admission, runtime transport, pure events, store and token registry. An iterable existing is not evidence that a prompt was sent; the integration must separate pre-dispatch rejection from asynchronous turn failure.
## What Changes
- Add SessionSupervisor and registerSessions with real fake-child integration, persisted events and orderly resource ownership.
- Extend the existing runtime prompt iterable with a truthful dispatch receipt; extract its existing FrameStream to stay within800 lines, without a second stream implementation.
- Extend existing fake-omp support only for discriminating crash-after-deltas/ordering cases not expressible today; retain existing scenario semantics.
## Capabilities
### Modified Capabilities
- `chat-sessions`: supervisor persistence, generation lifecycle and module registration.
- `omp-runtime`: awaitable prompt dispatch receipt while preserving async iteration.
## Impact
Source supervisor/index and the minimal runtime stream seam; paired tests and existing fake child support. No schema, dependency, threshold, startup/config/SSE or #190 repair.
## Risk Triage
Issue type: feature. Fixture level: expanded (agree with upstream).
Blast radius: tenant data, compensation/terminal persistence, native process/token lifetime and request/event correlation.
Selected packs: API, filesystem evidence, schema/units, auth/secrets, concurrency/order, resources, compatibility, errors/rollback, release, documentation; configuration is unchanged.
Evidence floor: semantic RED before source-only implementation; real child+SQLite+HTTP acceptance, delayed/failed dispatch and native exit cases, store-fault containment, scoped static/full server coverage, qualified parent oracles and same-head CI. Human per-issue waiver remains, agent review and final Epic review do not.
