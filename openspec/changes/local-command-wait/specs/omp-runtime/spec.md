## MODIFIED Requirements

### Requirement: 每会话生命周期
SessionRuntime SHALL lazily acquire one child generation on the first prompt, reuse it across completed turns, reset its injected-clock idle timer on every child frame and accepted prompt, and retire it on idle expiry or shutdown. The runtime SHALL track pending approvals of the current generation as a set keyed by approval id: `markPending(approvalId)` adds the id, `clearPending(approvalId)` removes it, marking an id already present or clearing an id not present SHALL be a no-op, and several ids MAY be pending at once. While the set is non-empty the idle timer SHALL be suspended; when the last pending id is cleared the timer SHALL be re-armed with the full idle duration from that moment. The set SHALL be discarded with its generation. Retirement SHALL close stdin, send SIGTERM if still alive after 5 seconds, and SIGKILL if still alive after a further 3 seconds. Tokens SHALL be issued per generation and revoked exactly once on native death or failed startup without a live child. Caller-provided persisted resumePath and later successful sessionFile SHALL be retained as the last-known-good path for --resume; failed startup SHALL preserve that path, and only startup with no known path SHALL retry cold. Interrupted active turns SHALL fail and report the original child exit once. Every native exit of a generation that obtained a live child — idle expiry, explicit shutdown/retirement (including supervisor-driven eviction), crash during or between turns — SHALL invoke the caller-provided `onExit` callback exactly once with the original code/signal, whether or not a turn was active; the callback SHALL run after the generation's token is revoked and SHALL NOT be invoked for a generation that never obtained a pid. Public shutdown SHALL be idempotent and prevent subsequent prompts.
Local-only completion (`server/src/sessions/omp/local-command.ts`, a pure decision over the dispatched text and the frames seen since dispatch, wired into the runtime's frame handler): a matching `agentInvoked:false` outcome (`response{command:"prompt",success:true,data:{agentInvoked:false}}` or `prompt_result{agentInvoked:false}` with the turn's request id) completes the turn immediately when the dispatched prompt text does not start with `/` (the pre-existing behaviour; after chat-sessions「Slash 命令白名单与命令目录」 only whitelisted commands reach the runtime with a leading `/`) or when at least one `command_output` frame has been seen since that prompt was written; when the text starts with `/` and none has been seen, the turn enters `awaiting-output` and completes at the first `command_output` frame or, failing that, when the injected clock has advanced `LOCAL_COMMAND_GRACE_MS` = 120000 ms since the outcome, whichever comes first. A matching `agentInvoked:true` outcome never completes a turn (the turn ends by agent_end as usual). Frames arriving during `awaiting-output` are pushed to the turn stream and reset the idle timer as usual; a terminal agent_end or a matching failure during the wait ends the turn by the ordinary rules; the grace timer SHALL be cancelled when the turn ends or the generation retires and SHALL never end a later turn. The rule keys on the leading `/` of the dispatched text only; it knows no command names. A `command_output` that arrives after the grace expired is handled like any frame of whatever turn is then active (dropped when none is): the host does not filter it, so a compaction slower than 120 s may append its completion text to the next turn's body — an accepted, documented residual.

#### Scenario: Lazy startup and normal reuse
- **WHEN** a runtime is constructed, then receives and completes two prompts
- **THEN** construction issues no token and spawns no process; both prompts run through one child and expose all ordered frames through the true terminal event

#### Scenario: Idle reset and restart
- **WHEN** child frames or a new prompt arrive before idle expires, then activity stops for the configured duration
- **THEN** each activity resets the deadline; expiry closes stdin and reclaims the child, revokes its token, and the next prompt spawns with a fresh token and the exact last successful sessionFile as --resume

#### Scenario: Pending approval suspends idle expiry
- **WHEN** an approval request is marked pending and the injected clock advances past the idle duration, then the approval is cleared
- **THEN** no retirement occurs while pending; after clearing, the child is retired only once the full idle duration elapses again without activity

#### Scenario: Several pending approvals suspend idle until the last is cleared
- **WHEN** approvals `a1` and `a2` are marked pending, `clearPending(a1)` is called twice, the injected clock advances past the idle duration, and then `clearPending(a2)` is called
- **THEN** no retirement occurs while `a2` is still pending (the repeated clear of `a1` does not re-arm the timer); after clearing `a2` the child is retired only once the full idle duration elapses again without activity

#### Scenario: Every exit reaches onExit once
- **WHEN** a generation exits through idle expiry, through shutdown, through an externally requested retirement between turns, or through a crash
- **THEN** `onExit` is invoked exactly once per generation with the actual code/signal in each case, after its token is revoked; a generation that never obtained a pid produces no `onExit` call

#### Scenario: Persisted resume in a new runtime
- **WHEN** a newly constructed runtime receives a previously persisted sessionFile from its caller, including after an unsuccessful first startup
- **THEN** its first and retry spawns use the exact --resume path until a new successful handshake replaces it; omitted/null initial path produces no --resume argument

#### Scenario: Bounded escalation
- **WHEN** a retiring child exits on EOF, waits for TERM, or ignores EOF and TERM
- **THEN** real process observation respectively proves no unnecessary signal, TERM at 5000ms, or KILL at 8000ms; no signal occurs before its deadline, early death cancels remaining escalation, and shutdown observes actual native exit without fabricating it

#### Scenario: Crash during a turn
- **WHEN** a child exits before a terminal prompt outcome
- **THEN** already received frames remain observable, the active iterator fails, the exit callback receives the original code/signal exactly once, the token is revoked and the next prompt resumes using the successful sessionFile

#### Scenario: Startup failure and shutdown race
- **WHEN** startup fails before a sessionFile is accepted or shutdown races delayed startup
- **THEN** no false successful session path is retained, every acquired child/token is reclaimed, no prompt is sent after shutdown, and cold retry is possible only on a runtime not explicitly shut down

#### Scenario: Prompt lifecycle signals
- **WHEN** an ACK, nonterminal agent_end, unrelated response, matching local-only outcome (for a prompt not starting with `/`, or one preceded by a `command_output`), or matching delayed failure arrives
- **THEN** ACK/nonterminal/unrelated frames do not end the turn; agent_end with isTerminal absent or true completes it, a matching agentInvoked=false completes local-only work immediately for a prompt whose text does not start with `/` and for one that follows at least one `command_output`, and a same-id failure after ACK fails the turn; events before ACK remain visible

#### Scenario: Local-only outcome waits for late command output
- **WHEN** the real fake (`slash`) answers `/todo` (output before the receipt) and, on another turn, `/compact` (receipt before the output), a prompt `hello` is answered by a bare `agentInvoked:false` receipt and a prompt `/x` by a `command_output` then an `agentInvoked:true` receipt then agent frames (both with hand-written frames on the wired fake child, as in the existing local-only tests; the `slash` fixture runs `hello` as a normal turn), and the real fake (`slash --compact-silent`) answers `/compact` with a receipt and no output
- **THEN** the `/todo` turn ends at the receipt with its `command_output` already in the stream; `hello` ends at the receipt as before; the `/compact` turn does not end at the receipt and ends exactly when `command_output{text:"Compaction complete."}` arrives, that frame being the last one exposed by the iterator; the `/x` turn ends only at its terminal agent_end; the silent turn ends when the injected clock advances 120000 ms after the receipt, no later, with no fabricated frame; a subsequent prompt on each runtime reuses the same child, and a cancelled grace timer (turn already ended or generation retired) never ends a later turn

#### Scenario: Concurrency and abandoned consumption
- **WHEN** prompts overlap or a consumer abandons an active iterator
- **THEN** overlap is rejected without a second command/child and abandonment reclaims the active generation instead of making it available for an overlapping turn

#### Scenario: Native death before pipe closure
- **WHEN** native exit precedes buffered terminal frames or stdout is held open
- **THEN** token revocation does not wait for pipe closure, valid buffered frames are drained before logical completion, and held pipes are reclaimed within the 8-second drain budget with unfinished work failed using the original exit

#### Scenario: Retired generation callbacks and transport errors
- **WHEN** old frame/exit/timer callbacks arrive after retirement, or transport failure interrupts an active turn
- **THEN** old callbacks cannot affect the new child, token or turn; transport failure is sanitized, fails the current turn and reclaims its generation rather than silently yielding success
