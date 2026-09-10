## ADDED Requirements
### Requirement: Pathname-independent ServiceInfo leakage oracle
The ServiceInfo error-leakage test matrix SHALL use the same stable unique secret sentinel in all four invalid-response/transport fixtures and in both message and raw stack exclusion assertions, without depending on ordinary checkout path fragments.
#### Scenario: Checkout path parity and leak discrimination
- **WHEN** the four existing ServiceInfo invalid-response/transport cases run from macOS checkout paths with and without /private
- **THEN** all four pass with unchanged fallback/status assertions, while deliberately leaking the fixture sentinel into message or stack makes the corresponding exclusion assertion fail
