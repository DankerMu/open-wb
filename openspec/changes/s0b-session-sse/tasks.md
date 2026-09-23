## 1. Contract and baseline
- [ ] 1.1 Expanded fixture read-only review PASS and strict validate; freeze source/protected identities, consume prior characterization and refresh real authenticated route404 RED on current base.
- [ ] 1.2 Verify current LSP consumers of Supervisor/registerSessions/new exported interfaces; record blind spots, preserve #204/#214 contracts and parent stage agreement.

## 2. Replay and HTTP implementation
- [ ] 2.1 Test-first synchronous Supervisor replay/subscription seam consumes the existing ring and captured event IDs; no-observer recording, empty/malformed/no-runtime/epoch/min−1/running-refresh paths and atomic handoff remain correct.
- [ ] 2.2 Test-first SSE route and real registerSessions wiring: exact headers/frames, cookie/owner401/404 before frames, control empty-id, lossless JSON, injectable15000ms comment heartbeat, two clients and disconnect cleanup.
- [ ] 2.3 Isolate throw/error/false writers: bounded near1000-record replay pauses/resumes on drain, live-arrival-during-pause ends and reconnect recovers suffix; ordinary live writefalse ends without queueing. Track paused/end-pending responses and heartbeat ownership, destroy at preClose and keep native→store→DB order; preserve #204 external return validation and #214 live/sealed fences.

## 3. Independent verification
- [ ] 3.1 Parent compiled app + real HTTP/native fake-omp proof: authenticated200/headers/live frames; disconnect/replay/gap/refresh/multiple subscribers; owned native processes/ports cleaned. Permanent inject raw-stream tests cover >highWaterMark near1000-record replay draining completely, live-during-pause cutoff/reconnect suffix, exact14.999/15s heartbeat (skipped while replay paused), subscriber0 after disconnect and preClose of paused/end-pending responses.
- [ ] 3.2 Qualify protected judges against plausible missing mount, missing empty-id, skipped replay/bad handoff and client-failure leakage; semantic rejection then restoration and dedicated stability where timing is material. Existing #91/#204/#214 suite and selected protected compatibility probes preserve boundaries.
- [ ] 3.3 Parent scoped Biome/typecheck/build/server suite/anti-drift/strict validate exit0, no test-discovery/config/dependency weakening; full CI owns unrelated modules. Update affected architecture/parent tasks/docs only after positive smoke, remove generated scaffold and temporary copies then.

## 4. Delivery
- [ ] 4.1 Expanded three-seat review, bounded2fixpasses, same-head source CI/merge, separate preserving canonical archive PR/CI before92.

## Core risk mapping
Selected entry/API→2.2/3.1 rawroute/headers; schema/types→2.1 named owner DTO and existing event IDs; concurrency/state→2.1/2.3 replay/live/generation/drain; resources→2.3 timer/response/subscriber/native cleanup; compatibility→2.1/3.2 unchanged REST/ring/sinks/cursor; errors→2.3 writefalse/throw/error isolation; auth/secrets→2.2 ownerbeforeheaders/cookie; tests/evidence→1.1/3.1/3.2 realHTTP+inject and qualifiedoracle; release/docs→3.3/4.1 assembly and archive. Not selected config (no key), fileIO (no newproductionfilesystempath).

## Domain risk mapping
Selected tenant isolation→2.2 ownernegative; auth/session lifecycle→2.1/2.2/2.3 generations+cookie; process/child-environment isolation→2.3/3.1 cleanup/noenvchange; server/web HTTP-envelope→2.2 SSEwire; offline deployability→3.3 no dependency/networkaddition. Not selected SQLite migration/catalog (read/publishseam only), browser runtime/navigation/persistence (web later92/93/104), cross-service network (HTTP client transport only, no outboundservicecall).

## Scope and evidence limits
One implementer/currentcheckout/no newworktree/no nesting. Source allowed stream/sse.ts, supervisor.ts, index.ts; app.ts only for necessary injectable assembly plumbing; rest.ts only reuse of existing narrow owner/no-store helper if duplicate guard otherwise unavoidable. Ring-buffer.ts only if exposing its already-retained publication is needed, never changing push/since semantics. Existing sessions/runtime helpers and focused SSE/supervisor/assembly tests allowed. No store mutation/runtime/process/tokens/config/dependencies/CI/threshold changes; concrete ReturnType aliases prohibited, named owner exports required. Writer runs focused RED/GREEN only, no format/lint/build/full suites; parent owns protected /tmp/open-wb-issue103-evidence, acceptance and Git. Every source addition must be preceded by focused failing test. Protected scripts are not candidate-writable; local OSuser shared, independent CI required. #219 remains separate; do not silently absorb it.
