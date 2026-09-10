## Why
Issue #42: macOS UTF-8 Bash treats unbraced variable adjacency as part of the variable name; oversized files lose actionable diagnostics and later violations.
## What Changes
- Brace the line-count expansion; upgrade existing self-test to require per-file diagnostics, not merely nonzero status.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `verification-harness`: add locale-independent size-guard diagnostic requirement.
## Impact
Only scripts/size-guard.sh and scripts/test-guardrails.sh; no dependencies, thresholds or CI changes.
