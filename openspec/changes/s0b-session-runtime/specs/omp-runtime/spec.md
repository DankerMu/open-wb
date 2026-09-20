## ADDED Requirements

### Requirement: 每会话生命周期
SessionRuntime SHALL lazily acquire one child generation on the first prompt, reuse it across completed turns, reset its injected-clock idle timer on every child frame and accepted prompt, and retire it on idle expiry or shutdown. Retirement SHALL close stdin, send SIGTERM if still alive after 5 seconds, and SIGKILL if still alive after a further 3 seconds. Tokens SHALL be issued per generation and revoked exactly once on native death or failed startup without a live child. Caller-provided persisted resumePath and later successful sessionFile SHALL be retained as the last-known-good path for --resume; failed startup SHALL preserve that path, and only startup with no known path SHALL retry cold. Interrupted active turns SHALL fail and report the original child exit once. Public shutdown SHALL be idempotent and prevent subsequent prompts.

#### Scenario: Lazy startup and normal reuse
- WHEN a runtime is constructed, then receives and completes two prompts
- THEN construction issues no token and spawns no process; both prompts run through one child and expose all ordered frames through the true terminal event

#### Scenario: Idle reset and restart
- WHEN child frames or a new prompt arrive before idle expires, then activity stops for the configured duration
- THEN each activity resets the deadline; expiry closes stdin and reclaims the child, revokes its token, and the next prompt spawns with a fresh token and the exact last successful sessionFile as --resume

#### Scenario: Persisted resume in a new runtime
- WHEN a newly constructed runtime receives a previously persisted sessionFile from its caller, including after an unsuccessful first startup
- THEN its first and retry spawns use the exact --resume path until a new successful handshake replaces it; omitted/null initial path produces no --resume argument

#### Scenario: Bounded escalation
- WHEN a retiring child exits on EOF, waits for TERM, or ignores EOF and TERM
- THEN real process observation respectively proves no unnecessary signal, TERM at 5000ms, or KILL at 8000ms; no signal occurs before its deadline, early death cancels remaining escalation, and shutdown observes actual native exit without fabricating it

#### Scenario: Crash during a turn
- WHEN a child exits before a terminal prompt outcome
- THEN already received frames remain observable, the active iterator fails, the exit callback receives the original code/signal exactly once, the token is revoked and the next prompt resumes using the successful sessionFile

#### Scenario: Startup failure and shutdown race
- WHEN startup fails before a sessionFile is accepted or shutdown races delayed startup
- THEN no false successful session path is retained, every acquired child/token is reclaimed, no prompt is sent after shutdown, and cold retry is possible only on a runtime not explicitly shut down

#### Scenario: Prompt lifecycle signals
- WHEN an ACK, nonterminal agent_end, unrelated response, matching local-only outcome or matching delayed failure arrives
- THEN ACK/nonterminal/unrelated frames do not end the turn; agent_end with isTerminal absent or true completes it, matching agentInvoked=false completes local-only work, and a same-id failure after ACK fails the turn; events before ACK remain visible

#### Scenario: Concurrency and abandoned consumption
- WHEN prompts overlap or a consumer abandons an active iterator
- THEN overlap is rejected without a second command/child and abandonment reclaims the active generation instead of making it available for an overlapping turn

#### Scenario: Native death before pipe closure
- WHEN native exit precedes buffered terminal frames or stdout is held open
- THEN token revocation does not wait for pipe closure, valid buffered frames are drained before logical completion, and held pipes are reclaimed within the 8-second drain budget with unfinished work failed using the original exit

#### Scenario: Retired generation callbacks and transport errors
- WHEN old frame/exit/timer callbacks arrive after retirement, or transport failure interrupts an active turn
- THEN old callbacks cannot affect the new child, token or turn; transport failure is sanitized, fails the current turn and reclaims its generation rather than silently yielding success
