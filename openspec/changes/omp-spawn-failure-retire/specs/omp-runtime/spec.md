## ADDED Requirements

### Requirement: Pid-less spawn failure retirement
A SessionRuntime generation whose child never obtained a pid SHALL be treated as having no live child from the moment spawn returns. Retiring such a generation (by shutdown, by the failed acquisition itself, or by cancellation; idle expiry cannot apply because the idle timer is armed only after a successful acquire), even when retirement starts before Node reports the spawn error, SHALL revoke its token exactly once and complete without waiting for any TERM/KILL grace and without awaiting a native exit, independent of whether the failed child ever reports `exitCode` or emits `'error'`. A child that obtained a pid SHALL keep the existing retirement contract even if it later emits `'error'` while still running.

#### Scenario: Shutdown races a missing-binary spawn
- **WHEN** shutdown starts inside the spawn call of a missing-binary generation, before the spawn error tick
- **THEN** shutdown settles without advancing the injected clock, no timers remain pending, no signal is sent, the token is revoked exactly once and the prompt rejects with agent_unavailable

#### Scenario: Pid-less child that never reports failure
- **WHEN** spawn returns a pid-less child that never emits `'error'` and never sets `exitCode`
- **THEN** the failed acquisition's retirement and a later shutdown both settle at clock 0 with no pending timers

#### Scenario: Live child emitting error keeps the grace contract
- **WHEN** a child with a pid emits `'error'` while still running and the generation is retired
- **THEN** stdin is closed, SIGTERM is sent at 5000 ms and SIGKILL at 8000 ms unless the child actually exits first
