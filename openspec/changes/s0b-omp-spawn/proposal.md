## Why
Issue #85 supplies the production spawn boundary used by the later RPC layer, without mixing protocol or lifecycle work into this slice.
## What Changes
Add server/src/sessions/omp/process.ts with spawnOmp(opts, spawnImpl) and paired process-contract tests. Exact argv, explicit environment and pre-spawn directory creation only.
## Capabilities
### New Capabilities
None.
### Modified Capabilities
- `omp-runtime`: add the spawn-contract requirement (existing binary-supply requirement unchanged).
## Impact
Future consumers #95 frame/handshake and #96 runtime; no application assembly or protocol parsing yet.
## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree; production child process, filesystem and credential boundary)
Blast radius: accidental environment inheritance exposes app-server credentials to omp tools.
Selected risk packs: CLI/process entry, config, file IO, schema/argv/env names, auth/secrets, ordering, resource, errors, compatibility, documentation.
Evidence floor: test-first injected capture plus real child observation, full server coverage, lint/typecheck/anti-drift and CI; mandatory human white-box review before merge per AGENTS Critical Paths.
Oracle: parent s0b-minimal-chat-loop spawn requirement/design D2, CONTEXT invariant4, ADR0001/0008/0010. Pinned upstream rpc.md at33cc6b9 is reachable through resource/oh-my-pi or the fixed GitHub URL; dead issue reference tracked #141.
