## ADDED Requirements
### Requirement: System Bash-compatible guards and pre-commit
The first-party naming guard, size guard and pre-commit SHALL work with macOS system Bash 3.2 and Bash 5.x without requiring newer-shell builtins. Empty lists SHALL succeed under nounset. Existing naming, read-only boundary, size and secret-scan policy SHALL remain unchanged.
#### Scenario: Empty and compliant inputs
- **WHEN** system Bash executes guards with empty staging/source lists or a compliant staged file, or a real Git commit invokes pre-commit with system-first PATH
- **THEN** each operation exits zero without interpreter errors and compliant commit is created
#### Scenario: Violations remain rejected
- **WHEN** a real Git commit stages a file with forbidden naming suffix or the size guard sees an oversized supported file
- **THEN** it exits nonzero with the appropriate BLOCK diagnostic, including the offending path, and no violating commit is created
#### Scenario: Self-verification detects unsupported shell use
- **WHEN** the compatibility regression is run against historical guard/hook implementations under macOS system Bash
- **THEN** its acceptance scenarios fail; current implementations pass under both Bash 3.2 and 5.x and documentation states the interpreter/toolchain prerequisites
