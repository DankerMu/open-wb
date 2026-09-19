## Context
Implement only Epic #111 task 1.2 / issue #113. resolve.ts remains unchanged; deployment owns group membership and root provisioning.
## Goals / Non-Goals
Change surface: core/sandbox/dirs.ts and paired test.
Must preserve: all existing directory modes and ownership, process umask, resolver behavior, HTTP/startup paths.
Must add: synchronous ensureSharedDir(absPath: string): void, creating missing directory components and applying exact 0o2770 only to directories this call created.
Governing invariant: the helper never changes permissions on pre-existing directories, while every newly created component has 2770 before successful return.
Sibling surfaces: existing ancestors, new intermediate directories, new leaf, repeated calls, filesystem failures, existing entry collisions.
Future consumers: facade #123, workspace store #125, omp directories #126; this slice does not wire them.
## Decisions
Use native filesystem calls and real filesystem tests. Track which components were created by this invocation rather than chmod every ancestor after recursive mkdir.
Apply mode explicitly after creation so caller umask does not erase required bits; do not mutate umask and do not chown.
Do not silently succeed on filesystem creation or chmod errors; no rollback guarantee is introduced by this void helper.
A racing existing directory must not be chmodded as if it was newly created; no claim of hostile symlink/rename race protection is made.
This is a trusted absolute-path creation helper, not a replacement for resolve or authorization. POSIX permissions are the target (macOS development, Linux CI).
## Required evidence
Real temp a/b/c all exactly mode&07777 == 02770 after first and second calls.
Precreate a at 0755; create b/c via helper; a remains 0755 while b/c are 02770.
No chownSync calls (explicit issue acceptance spy), unchanged process umask, and unchanged ownership of existing directory.
Existing regular-file collision throws and preserves existing file/directory state; missing descendants must not be treated as already created.
Public seam tests precede implementation (semantic RED); full server suite remains green with unchanged coverage scope.
## Risks / Trade-offs
POSIX setgid/group inheritance depends on deployment; caller integration and Linux uid isolation belong to later issues.
Concurrent hostile rename/symlink replacement and transactional cleanup are not part of this helper contract; do not claim them.
Review focus: new-versus-existing identity, correct mode timing, no global permission effects, syscall failures.
