## Context
Issue type bugfix; profile openspec/project-profile.md Generic. Fixture expanded (script entry / backward compatibility), repair medium. Upstream suggested fixture/minimal slice absent; preserve the three-entrypoint slice in #44. Root cause and Bash 3.2 empty-array trap already established by issue evidence.
## Goals / Non-Goals
Must preserve: rejection rules/800 limit, Git ACR filter, supported extensions, stage-only hook semantics, full explicit argv, empty lists exit zero, gitleaks-present block/absent warning, #42 locale diagnostics. No Make SHELL, CI/runner, dependency, wc whitespace or unrelated harness changes.
## Decisions
Use initialized arrays populated by `while IFS= read -r` in process substitution (not pipeline subshell); keep consistent delimiter semantics across producer and consumer. Prefer NUL-delimited Git/find lists to preserve literal filenames. Check empty count before array expansion under nounset, retaining existing early exits. No new shared shell abstraction.
Seams under test: #44 names direct no-arg guards and actual git commit with hooksPath; existing self-test owns fixtures and cleanup. Use isolated temporary Git repository and real candidate guard/hook scripts, no mock of guard or Git; exercise empty list, compliant file, and named-suffix rejection. Child PATH resolves bash to /bin/bash, even when parent is modern Bash; Linux /bin/bash is 5.x, macOS evidence explicitly covers 3.2.
## Risk packs
- Public API / CLI / script entry: selected; guard, Make and real git hook probes.
- Config / project setup: selected; document interpreter baseline and required toolchain PATH.
- File IO / path safety / overwrite: not selected; no change to boundary rules, file writes or trust policy; literal filename list preservation and test-owned cleanup still checked at CLI seam.
- Schema / columns / units / field names: not selected; no data schema.
- Auth / permissions / secrets: not selected; gitleaks policy unchanged, no credentials.
- Concurrency / shared state / ordering: not selected; serial lists, isolated test repo.
- Resource limits / large input / discovery: not selected; scan roots and limit unchanged.
- Legacy compatibility / examples: selected; Bash 3.2/5.x empty and populated arrays.
- Error handling / rollback / partial outputs: selected; accepted vs policy rejection diagnostics, no interpreter errors.
- Release / packaging / dependency compatibility: selected; no new shell dependency, existing Node/uv requirements retained.
- Documentation / migration notes: selected; constraints interpreter note and this spec.
- All project domain packs: not selected; no app/runtime/session/DB/network/browser/cross-service changes.
## Risks / Trade-offs
Issue literal PATH=/usr/bin:/bin omits this host's Node/npx/uv. This is a verification-command prerequisite discrepancy, not a changed product scope: run exact minimal PATH for dependency-free guard/hook scenarios; for anti-drift/test-guardrails/check append installed Node and uv directories AFTER system directories so bash remains /bin/bash. Record exact PATH and initial missing-tool result; do not alter Make or install executables into OS directories. No invisible bypass or skip.
Rollback: revert atomic three-entrypoint repair. Temporary test repositories clean only their own mktemp root. Empty source trees and empty staging are distinct and both required.
