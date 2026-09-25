## ADDED Requirements

### Requirement: Real-child output capture waits for stream closure
Test assertions that depend on the complete stdout or stderr of a real child process, or that are made after the child's exit was observed, SHALL treat the output as complete only after the child has emitted close (its stdio streams have closed), never on the exit event or an already-set exit code alone. Such waits SHALL be bounded, and a timeout or an incomplete or unparseable capture SHALL report the exit code, signal, captured byte count and observed event order.

#### Scenario: Exit observed before pipe data
- **WHEN** a child writes its output and exits, and the parent observes the exit before consuming the pipe data
- **THEN** the capture returns the complete output

#### Scenario: Capture diagnostics
- **WHEN** a capture times out, or the child exits with empty or unparseable output
- **THEN** the reported failure includes exit code, signal, byte count and event order
