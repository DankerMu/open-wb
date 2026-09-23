## Context
Authority: issue #126; parent S1a design D3/D6 and private-state requirement; ADR0010. User confirmed prerequisites complete and waived per-issue human review; final Epic acceptance remains human.
Governing invariant: SQLite state is owner-only before SQLite can create WAL/SHM; newly app-created shared tree levels use 2770 without changing existing directory modes or process umask.

## Goals / Non-Goals
Goals: DB main/WAL/SHM mode0600 before open, shared directories2770, existing startup shutdown/failure semantics.
Non-goals: sudo policy (preserve #120), real Linux uid/PAM/proc proof (#131/#132), CI edits, chown/ACL, retroactive chmod of existing shared directories, new path-validation policy, arbitrary filesystem concurrency/TOCTOU guarantees.

## Decisions
1. In start(), after existing DB-parent mkdir and before openDb, prepare private files using wx0600 create+close or chmod existing main. Only EEXIST is the existing-main branch. Existing sidecars must be chmod0600; ignore only genuine absence, propagate all other errors. Sidecar preparation is not conditional on whether main was newly created.
2. Keep this startup-only behavior private to server.ts; do not change exported openDb or all its test consumers. :memory: skips file preparation entirely. Do not chmod DB parent0700: shared var traversal is the documented D3 exception.
3. Switch both spawnOmp four paths and writeManagedModelsYml agent creation to ensureSharedDir. Earlier model publication otherwise creates agent0755, which the helper intentionally preserves later. No duplicated directory policy.
4. Preserve generic startup failure, sticky failure on signals, resource ownership and release, actual bound URL/models-before-success record, existing model bytes, exact argv/env and unsafe-PATH-before-mkdir guard.
5. Trusted deployment parents remain preprovisioned with the shared group; existing modes remain untouched. Application-created missing roots/intermediates inherit the canonical helper contract. No global umask mutation, even for restrictive caller masks.

## Seams and evidence
Actual compiled production entry + real temporary DB: cold and pre-existing0644 main/WAL/SHM become0600; actual SQLite-open boundary observes already-private files, preventing a misleading after-open chmod implementation.
Observe files while live: graceful SQLite shutdown may remove sidecars. Preserve database content across restart; seed a valid database, not fabricated SQLite bytes.
Deterministic chmod failure at main and sidecar: controlled native-fs fault injection may be used, but do not mock startup/SUT. Assert generic exit1, no success/listener/models/child leak; pre-existing data is retained, not deleted as cleanup.
Readonly parent directory alone does not reliably make owner chmod fail. State this deviation; inject a real fs boundary error or use a controlled invalid target and demonstrate intended failure, never claim parent mode alone tests chmod denial.
Spawn boundary with native temp FS: cwd, state/sessions/owner, home, agent and missing intermediate roots2770 before spawn; include prior managed-model creation path. Existing directory modes preserved, umask unchanged, mkdir/chmod failure prevents child spawn.
Main independent actual service smoke: startup modes and authenticated prompt creating directories, then SIGTERM releases port/DB. No host sudo.
Oracle qualification: semantic baseline RED; isolated scratch wrong-order/missing-sidecar/missing-earlier-agent mutants when normal RED does not discriminate each high-risk defect. No production mutations.

## Risks / Trade-offs
Owner mode creation is filtered by caller umask; exact0600 before SQLite must hold without changing global umask (use descriptor mode repair if necessary). No group-readable window allowed.
No automatic removal of pre-existing DB/files on startup failure; resource cleanup is handles/ports/children, not deletion of user data.
Rollback: revert feature through PR; private modes remain safe. Already-promoted #120 spec must not be replaced by old parent text.
Review focus: ordering, sidecar absence/error distinction, both directory producers, proof sensitivity and preserved startup lifecycle.
