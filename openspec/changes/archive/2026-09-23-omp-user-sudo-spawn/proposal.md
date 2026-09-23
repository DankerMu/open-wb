## Why
#120 adds optional dedicated-user spawn now that canonical #101/#102 configuration and production assembly exist. It must not leak token values into argv or change unset behavior.
## What Changes
- Parse OMP_USER in canonical agent-config consumed by resolveServerConfig; propagate through server assembly, supervisor, SessionRuntime, OmpProcess and SpawnOmpOpts.
- Present: PATH executable sudo with exact noninteractive preserve-env prefix before existing omp binary/args. Absent: existing spawn unchanged.
- Prove invalid configuration before effects, exact dual capture, production forwarding and immediate-exit agent_unavailable without direct fallback.
## Capabilities
### New Capabilities
- omp-uid-isolation: optional user configuration and sudo-prefix contract only.
### Modified Capabilities
None; direct spawn remains absent-user behavior. Parent combined omp-runtime delta is reconciled at final Epic archive without overwriting stronger promoted requirements.
## Impact
Necessary source chain: agent-config.ts, server.ts, sessions/supervisor.ts, sessions/omp/runtime.ts and process.ts, plus focused existing config/spawn/runtime/entry/assembly tests. Old two-file sketch is insufficient after #101/#102: omitted forwarding would leave production using direct spawn. No new production files, schema, dependencies or CI changes.
## Scope / risk
Expanded Critical Path, user waived per-issue human review but final Epic acceptance remains. Directory helper/2770/DB0600 belongs to #126: do not copy that sentence from the parent's combined requirement into this slice. Real sudo/uid/proc proof belongs to #131/#132; no host sudo/account changes. Parent S0b/S1a stay active.
