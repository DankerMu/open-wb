## Why
Issue #87 provides a deterministic real subprocess oracle for later omp RPC, supervisor and startup integration tests.
## What Changes
Add only server/test/support/fake-omp.mjs and server/test/fake-omp.test.ts, with no npm dependencies or production changes.
## Capabilities
### New Capabilities
- `omp-test-harness`: pinned RPC frames, explicit fault scenarios and real local model-proxy calls.
### Modified Capabilities
None.
## Impact
Consumers: #95 frame/handshake tests, #100 supervisor integration, #102 credential-log integration. No production runtime implementation.
## Risk triage
Issue type: test
Fixture level: expanded
Upstream suggested level: expanded (agree; process protocol, file config and bearer HTTP)
Blast radius: a fake protocol mismatch creates false confidence in later runtime tests.
Selected risk packs: CLI; config; file IO; schema; auth/secrets; concurrency/ordering; resource/large input; compatibility; errors; release compatibility; documentation.
Evidence floor: test-first real Node subprocess Vitest contracts, local HTTP bearer capture, deterministic chunk-byte reconstruction, server suite plus type/lint.
Oracle: https://github.com/can1357/oh-my-pi/blob/33cc6b9a043a74e00a157e72ca909272796d8461/docs/rpc.md (ADR-0001 pin), also available locally via the ignored symlink resource/oh-my-pi/docs/rpc.md. Issue's docs/architecture/rpc.md path is absent; dead references are tracked by #141. Exact pinned document and rpc-types.ts/agent types/providers docs were fetched into /tmp/open-wb-issue87-evidence for review, not substituted from latest.
