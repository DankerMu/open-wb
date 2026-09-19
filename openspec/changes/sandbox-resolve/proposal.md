## Why
Implement #112, the dependency-free path-boundary slice of Epic #111. The parent change remains the authoritative stage design.

## What Changes
- Add synchronous, side-effect-free sandbox path resolution and real-filesystem rejection tests.
- No facade, HTTP, audit, directory creation, or dependencies.

## Capabilities
### New Capabilities
- `sandbox-core`: only the resolve requirement from the parent change.
### Modified Capabilities
None.

## Impact
`server/src/core/sandbox/resolve.ts` and its paired test. Future consumer: #123 facade.

## Risk triage
Issue type: feature
Fixture level: expanded
Upstream suggested level: expanded (agree)
Blast radius: sandbox path boundary; human white-box review required before merge.
Selected risk packs: Public API / CLI / script entry; File IO / path safety / overwrite; Auth / permissions / secrets; Error handling / rollback / partial outputs.
Evidence floor: real temporary directories and symlinks, semantic RED/GREEN, server suite with unchanged coverage scope, typecheck, lint, CI.
