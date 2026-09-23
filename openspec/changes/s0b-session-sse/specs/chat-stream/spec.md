## ADDED Requirements

### Requirement: Authenticated session SSE endpoint
GET /api/sessions/:id/events SHALL return200 with Content-Type:text/event-stream; charset=utf-8, Cache-Control:no-store and Connection:keep-alive after existing cookie authentication and owner-scoped authorization. Missing/foreign sessions SHALL return identical404 not_found and unauthenticated requests401 before any stream headers/data; runtimeState SHALL NOT authorize a caller. Route reads SHALL NOT allocate a runtime or mutate history. Each data event SHALL contain id:<epoch>:<seq>, event:<canonical type>, data:<JSON> and a blank-line delimiter. replay.gap SHALL contain empty id:, event:replay.gap, data:{} and consume no sequence. Comment-only : keepalive frames SHALL occur every15000ms through an injectable clock and SHALL NOT alter event IDs/history.

#### Scenario: Actual assembled owned route
- WHEN an authenticated owner connects through the fully assembled app
- THEN status200 and exact SSE/no-store/keep-alive headers arrive without waiting for response end, and subsequent real canonical events arrive with ring IDs and JSON payloads
- WHEN an anonymous, foreign-owner or missing-session request arrives
- THEN401 or identical404 occurs before any SSE frame or subscriber registration

#### Scenario: Framing and idle keepalive
- WHEN canonical text includes newlines, NUL, BOM or Unicode and injected time advances to14999 then15000ms
- THEN JSON round-trips exact data, no heartbeat precedes15000, a comment-only keepalive follows, and no data sequence is consumed

### Requirement: Atomic replay and live subscription
SSE SHALL consume Supervisor's single generation-owned RingBuffer and IDs, not a second buffer/counter. Subscription registration and initial replay decision SHALL be synchronous with no await gap. Retained successors SHALL precede live events exactly once using canonical ring min−1 decisions. Last-Event-ID is present even when empty/malformed; absent cursor with a running turn replays the retained active turn.start inclusive or emits gap. Absent cursor with nonrunning state is fresh. If no ring exists, a present cursor or running state SHALL emit gap; absent cursor/nonrunning is fresh. Gap SHALL precede live-only delivery. Subscribers SHALL remain session-scoped across generation replacement while old rings retain #214 drain/seal semantics.

#### Scenario: Reconnect and accepted lower boundary
- WHEN a client reconnects after1:5 while the ring retains1:6..1:9
- THEN1:6..1:9 arrive in order followed by live1:10 exactly once
- WHEN the retained range is2..1001 and cursor is1:1
- THEN2..1001 are replayable; cursor1:0 or a subsequent eviction yields gap under the unchanged pure-ring decision

#### Scenario: Running refresh and gaps
- WHEN no-ID connection arrives during a turn with retained start, steps and deltas
- THEN replay starts with that turn.start and contains its ordered successors before live delivery
- WHEN start is evicted, cursor is empty/malformed/old epoch/too old, or process reconstruction lost the ring
- THEN the first control frame resets the cursor with empty id and replay.gap before live events; no historical partial replay is fabricated

#### Scenario: Multiple subscribers and replacement
- WHEN two clients subscribe before a turn, one disconnects, and later a runtime generation is replaced
- THEN both initially see identical event IDs/payloads, the surviving client alone receives later events, and new generation events use its actual new epoch starting at1 without old-generation relabeling

#### Scenario: Bounded replay pause and reconnect recovery
- WHEN a near1000-record replay exceeds the writable high-water mark without concurrent live events
- THEN drain resumes after each accepted frame until every retained successor has been sent once before live delivery
- WHEN a new live event arrives while that replay is paused
- THEN that connection ends without queueing/overtaking; reconnect from its last received ID replays the retained suffix or reports gap for snapshot recovery, so delivery guarantees apply across reconnect rather than requiring an unbounded queue

### Requirement: Bounded subscriber isolation and teardown
Transport writers SHALL be synchronous and contain each client's failures without retiring the session runtime or interrupting other clients. During initial replay, raw.write(false) SHALL advance the accepted frame once and pause further writes/heartbeats until drain resumes the suffix; only the bounded initial replay array returned by the ring may be retained. A live event arriving while replay is paused SHALL unregister/end that client rather than queue or reorder it. During ordinary live delivery, raw.write(false) SHALL immediately unregister/end that client and cancel heartbeat, flushing only already-accepted bytes without resending the accepted frame or accumulating a live-event queue. Write throw/error SHALL close only that client. Paused or end-pending responses SHALL remain owned until closed and SHALL be destroyable at app preClose. Disconnect/error/finish cleanup SHALL be idempotent and remove owned timers/listeners/subscriptions. All open responses and subscribers SHALL be released before Fastify shutdown waits for long requests; existing supervisor/store/DB teardown order and #204 external synchronous sink guard SHALL remain intact.

#### Scenario: Broken or backpressured client
- WHEN a replay write returnsfalse and no new live event arrives before drain
- THEN no further bytes are written while blocked, drain resumes after the accepted record without duplication, and the full retained replay can complete before live delivery
- WHEN a writer throws/emits error, or a live event arrives while that client is blocked
- THEN only that client closes/unsubscribes, no live event queue grows, healthy delivery/runtime continue and no unhandled rejection occurs

#### Scenario: Disconnect and app shutdown
- WHEN raw injection AbortSignal or a real client socket disconnects
- THEN its subscription count and owned keepalive timers return to zero without stopping the runtime
- WHEN app.close occurs with active streams or an end-pending slow response
- THEN close resolves after releasing responses/subscribers/timers and the existing native/store/DB order is preserved
