# Design

## Context
The accepted #120 argv passes TMPDIR solely via sudo's environment. Native nonroot runner→sudo loses it; runner direct and root→sudo retain it. ld.so secure-execution documentation names TMPDIR as stripped before the executable sees it. Evidence: issue #131 comment 5795271507.
Governing invariant: only allowlisted input reaches omp; a supplied noncredential TMPDIR survives native uid transition exactly, while all credentials remain absent from argv.
Sibling surfaces: spawnOmp → sudo option parser/SETENV → executable; cold/resume and every runtime generation; direct mode; unit argv consumers, active parent specifications, ADR and later CI.

## Goals / Non-Goals
Correct only TMPDIR transmission when ompUser is set. No new env key, launcher, sudoers rule, root runner, source fallback, filesystem policy or CI configuration. #131 remains a separate single-test deliverable; #132/#134 release gates remain open.
Keep sudo env identical to existing allowlist and preserve optional LANG/TMPDIR semantics, native clock, async boundary, args/cwd/stdio/shell and lifecycle cleanup.

## Decisions
- Insert one `TMPDIR=<exact value>` element before sudo's `--` iff allowlisted TMPDIR is defined; empty is present. Never shell-expand or split the value.
- Use the already captured allowlist value, not a second environment read. Credentials (session token/upstream keys/canary) never receive assignment arguments.
- Retain preserve-env list for compatibility; direct mode unchanged. `--` remains before OMP_BIN, not before assignment: native experiment proved assignment after separator is interpreted incorrectly and fails authorization.
- Reject blanket /usr/bin/env launcher, PAM injection, root runner, env_keep workaround and deleting assertions: each bypasses or conceals the failed boundary.
- Extend existing capture tests for absent/empty/space-colon/metacharacter values and cold/resume, preserving token secrecy. Real acceptance uses parked #131 test outside repository in a readonly snapshot.

## Risks / Trade-offs
Nonsecret TMPDIR becomes visible in cmdline → documented narrow exception, never secrets. Native sudo command matching must stay exact → same sudoers fixture and actual nonroot probe.
A mock-only argv test cannot prove loader behavior → Ubuntu24.04 Node24.13.1 nonroot real sudo acceptance, original source RED/repaired GREEN and cleanup census.
Current container is arm64 not GitHub runner → no claim of #132 job or #134 closure.

## Migration Plan
Review fixture; implement and update existing tests/docs atomically; verify no source behavior beyond TMPDIR. Merge via normal CI/review; selectively archive corrected uid requirement; restore #131 candidate onto new master and requalify its full mutant portfolio.
Rollback by revert restores the diagnosed failure; it is not an acceptable deployment fallback. No stored-data migration.
