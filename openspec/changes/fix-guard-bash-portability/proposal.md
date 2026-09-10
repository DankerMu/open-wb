## Why
Issue #44: guards and pre-commit require an undeclared Bash 4 builtin and reject even compliant submissions under macOS system Bash 3.2.
## What Changes
- Replace three list-loading sites with Bash 3.2-compatible reads and safe empty-array handling.
- Extend guard self-verification with actual system-shell empty/nonempty and real Git-hook acceptance/rejection scenarios.
- Document supported Bash and existing toolchain prerequisites without changing dependencies or Make recipes.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: add Bash-compatible local guard and hook execution.
## Impact
scripts/size-guard.sh, scripts/naming-guard.sh, .githooks/pre-commit, scripts/test-guardrails.sh, constraints.yaml interpreter note. No product or CI changes.
