## ADDED Requirements

### Requirement: Per-turn supervisor claim release
SessionSupervisor SHALL release each turn's claim when that turn's pump finishes, even if a newer turn on the same slot has already registered its own pump; only clearing the slot's current-pump registration SHALL depend on pump identity. Releasing an older turn SHALL NOT release or alter a newer turn's claim, and correctness SHALL NOT depend on the relative scheduling of the old pump's exit and the new turn's dispatch acknowledgement.

#### Scenario: Old pump exits after a newer pump took the slot
- **WHEN** turn A's pump exits while the slot's current pump and claimed turn are already turn B's
- **THEN** A's claim is released, B's claim and the slot's current-pump registration stay B's

#### Scenario: Sink re-admits the next turn on the same slot
- **WHEN** an event sink, on turn A's turn.end, synchronously accepts and dispatches turn B for the same session
- **THEN** B is admitted and completes, and a later prompt on the session is admitted normally

### Requirement: Trusted metadata writes on missing sessions
`bumpStreamEpoch` and `setSessionFile` are trusted-supervisor-only writes whose callers SHALL own session existence; a row disappearing under a live supervisor slot is an invariant violation, not a client-facing condition. For a missing session both SHALL throw the generic receipt Error (not a typed HttpError), write nothing, and leave caller-owned transaction semantics unchanged. They SHALL NOT contain unreachable typed-error branches.

#### Scenario: Metadata write for an absent session
- **WHEN** bumpStreamEpoch or setSessionFile is called with a session id that has no row
- **THEN** it throws a non-HttpError receipt Error and no row changes
