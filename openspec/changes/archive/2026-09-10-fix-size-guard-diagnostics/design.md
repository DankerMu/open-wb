## Context
Issue type: bugfix. Project profile: openspec/project-profile.md (Generic). Fixture level: expanded; script CLI trigger. Repair intensity: medium. Upstream suggested level/minimal slice: absent; issue defines two-file isolated repair.
## Goals / Non-Goals
Preserve 800-line threshold, supported extensions, fail-closed exit, full scan, and wc whitespace. Restore a BLOCK line containing count and path for every offending file.
Non-goals: #44 Bash 3.2 no-argument mapfile compatibility; locale forcing, CI changes, generic syntax guard, application behavior.
## Decisions
Use `${lines}` instead of changing locale or punctuation. Extend existing self-test at script CLI seam declared by #42. Assert observable BLOCK/count/path and nonzero status for two oversized files, reject interpreter errors, retain valid boundary acceptance. Avoid exact wording/whitespace pinning.
## Risk packs
- Public API / CLI / script entry: selected; direct argv and Make callers.
- Config / project setup: not selected; no setup changes.
- File IO / path safety / overwrite: not selected; unchanged read-only file enumeration, test-owned temporary fixtures only.
- Schema / columns / units / field names: not selected; no format changes.
- Auth / permissions / secrets: not selected; no security changes.
- Concurrency / shared state / ordering: not selected; serial existing scan.
- Resource limits / large input / discovery: not selected; threshold/discovery unchanged, boundary regression retained.
- Legacy compatibility / examples: selected; macOS Bash 3.2 and 5.x, Linux Bash 5.x.
- Error handling / rollback / partial outputs: selected; each violation reported without aborting scan.
- Release / packaging / dependency compatibility: not selected; no dependencies.
- Documentation / migration notes: selected; spec records invariant, no migration.
- All project domain packs: not selected; no tenant/auth/process/SQLite/HTTP/offline/browser/cross-service change.
## Risks / Trade-offs
Linux does not reproduce the macOS defect: qualify the changed oracle against original source on macOS UTF-8. #44 prevents full no-argument checks with system Bash; use Homebrew Bash for full checks while direct explicit-file probes cover both interpreters. No claim that #44 is fixed.
Rollback: revert this isolated PR; no persisted data.
