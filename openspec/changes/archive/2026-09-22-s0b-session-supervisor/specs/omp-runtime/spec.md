## ADDED Requirements
### Requirement: Prompt dispatch receipt
SessionRuntime.prompt(text) SHALL retain its existing single AsyncIterable interface and additionally expose dispatched, a Promise resolving to the exact requestId and validated sessionFile after the prompt write succeeds following handshake. It SHALL NOT infer receipt from ACK, first event or turn completion. Existing consumers that only iterate SHALL preserve frame order, terminal/error delivery, cancellation and native-resource ownership without an unhandled rejection from the added Promise.
Pre-dispatch acquisition, write, cancellation or shutdown failure SHALL reject the receipt and terminate the iterable faithfully; a resolved receipt SHALL never be retroactively rejected by later turn failure. Buffered frames arriving before receipt SHALL remain available in order. The extracted stream SHALL be one canonical implementation and retain the existing bounded native retirement semantics.
prompt() SHALL preserve its existing synchronous closed/busy throws; a receipt exists only when an iterable has been returned. This addition SHALL NOT change existing runtime error sanitization.
#### Scenario: Exact request correlation with early frames
- WHEN a child sends lifecycle frames before its prompt ACK, and send completion is deliberately held
- THEN the iterable preserves those frames, dispatched remains pending until successful write completion, and its requestId equals the actual outbound prompt id rather than any observed response id
#### Scenario: Acquisition and write rejection
- WHEN spawn, handshake, stdin write or pre-dispatch cancellation/shutdown fails
- THEN dispatched rejects, no accepted receipt is fabricated, old iterator consumers observe their existing failure/cancellation behavior and no child/token is leaked
#### Scenario: Successful dispatch is not terminal completion
- WHEN the prompt is written successfully but the child remains in a nonterminal turn
- THEN dispatched resolves without waiting for agent_end, while the iterator remains active and later failure is observable there
