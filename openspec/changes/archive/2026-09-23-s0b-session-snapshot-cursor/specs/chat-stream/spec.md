## MODIFIED Requirements

### Requirement: Pure epoch event ring and replay decisions
The sessions stream module SHALL provide a per-session per-epoch RingBuffer with push(event) returning `<streamEpoch>:<seq>` and since(lastEventId|null,{turnRunning}) returning `{mode:'replay'|'gap'|'fresh',events}`. It SHALL reuse canonical numeric-step ChatEvent payloads, returning retained records with id/type/data. The caller supplies the trusted epoch; each new instance SHALL start sequence1 and retain exactly the latest1000 records in ascending sequence order. Separate instances SHALL not share data. It SHALL perform no IO, persistence, runtime allocation or SSE transport; generation ownership and disposal belong to SessionSupervisor. A read-only sequence getter SHALL expose the last assigned sequence, initially0, without advancing it or materializing replay records.

IDs SHALL parse only canonical ASCII nonnegative safe-integer epoch/sequence components separated by one colon, with no sign, whitespace, exponent, fraction or leading zero except0. Null alone means no cursor. Malformed or different-epoch cursors SHALL return gap with no replay records. A same-epoch cursor with seq at least minimum retained seq minus1 SHALL return replay with all and only retained records after that cursor, in order; older cursors SHALL return gap with no records. An empty new ring SHALL use minimum sequence1 for this decision; a valid cursor at or beyond the current tail SHALL return replay with an empty list. The buffer SHALL not synthesize replay.gap records or advance sequence during reads.

Without a cursor, turnRunning=false SHALL return fresh with no records. With turnRunning=true it SHALL replay from the most recent active retained turn.start inclusive; if that start has been evicted, no start has arrived, or the last started turn has ended, it SHALL return gap with no records. A present cursor SHALL take precedence over refresh logic. Retained records SHALL snapshot caller payloads without mutating/freezing caller objects; mutation of an input or returned array SHALL not change later replay. Reads SHALL preserve retained IDs and payload bytes without renumbering.

#### Scenario: Reconnect successors and accepted lower boundary
- WHEN an epoch1 ring receives1001 events and retains sequences2..1001
- THEN cursor1:1 replays2..1001 exactly once, cursor1:0 reports gap, and after event1002 cursor1:1 reports gap
- WHEN a cursor equals the tail or is syntactically valid and ahead of it
- THEN replay contains no records and does not change the next pushed ID

#### Scenario: Refresh only the active retained turn
- WHEN a no-cursor running connection arrives after turn.start and ordered step/text events
- THEN replay starts at that active turn.start and includes its retained successors
- WHEN that start was evicted, has not arrived, or belongs to a completed earlier turn
- THEN the running refresh reports gap rather than replaying stale or partial content
- WHEN a no-cursor nonrunning connection arrives
- THEN it is fresh with no historical replay

#### Scenario: Epoch, grammar and instance isolation
- WHEN an old-epoch or malformed cursor is supplied, including an empty string
- THEN gap contains no events; a new generation's first push still has sequence1
- WHEN two instances receive interleaved events and replay calls
- THEN their IDs, active-turn markers and retained payloads remain independent and repeated reads do not consume records

#### Scenario: Immutable retained records
- WHEN a caller changes an event after push or edits an array returned by since
- THEN future replay still returns the original ID and primitive payload values in their original order without modifying caller-owned objects

## ADDED Requirements

### Requirement: Generation-owned recording and snapshot fences
SessionSupervisor SHALL own one RingBuffer per acquired runtime generation, created after the persisted epoch increment. Each canonical event SHALL enter that exact generation ring synchronously after successful persistence/buffering and before optional external observation, even with no observer configured. The ring alone assigns sequence; snapshot reads SHALL not advance it. External sink returns SHALL still reach the synchronous-sink guard unchanged. A pump SHALL retain its generation identity rather than relabeling old events with a mutable replacement epoch.

The synchronous streamCursor(sessionId) port SHALL return the persisted epoch and that generation ring sequence while publication remains possible; otherwise seq SHALL be null, sealing the epoch. Native/token revocation SHALL NOT seal or dispose a generation until pending dispatch resolution and all its publication pumps have settled. Idle exits without pending publication SHALL release the ring. Failed acquisition, full retirement and process restart SHALL have sealed boundaries; a healthy idle-between-turns runtime SHALL retain its numeric sequence. Cleanup SHALL be identity-bound so an old pump cannot delete a replacement ring/slot; retirement SHALL NOT await its own pump. Existing native/pump/store/DB shutdown ordering SHALL remain.

#### Scenario: Sequence across reads and turns
- WHEN a live generation publishes a turn, arbitrary snapshot reads, then another turn
- THEN every data event consumes exactly one monotonic sequence across both turns, snapshots consume none, and the same IDs remain replayable under the unchanged min−1 rule
- WHEN no external observer is configured
- THEN recording and snapshot boundaries still advance identically

#### Scenario: Native exit before publication drain
- WHEN native exit revokes the token while stdout still has residual deltas and a terminal failure to drain
- THEN cursor stays numeric until those events are persisted/buffered and recorded in order; only final publication release seals the epoch and disposes its ring
- WHEN stale finalization from that generation runs after a replacement generation is installed
- THEN the new ring and its sequence remain intact

#### Scenario: Closed and replacement generations
- WHEN there is no runtime, an idle generation exits, an acquisition fails before data publication, or the application restarts from persisted history
- THEN snapshot epoch comes from the persisted session and seq is null once no publication remains; no magic numeric watermark or invented next epoch is used
- WHEN the next generation acquires
- THEN epoch increases once and its first data event is sequence1; previous-epoch queued events cannot duplicate the snapshot
