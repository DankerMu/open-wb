## Context
Make already owns omp-fetch and smoke-live. Existing oracle checks eight surfaces plus exact HTTP/UI rows and four protected targets. ADR0010 states same-uid environment filtering alone cannot stop `/proc/<app pid>/environ` or configuration-file reads; OMP_USER isolation deployment/CI is a separate closure gate.

## Goals / Non-Goals
- Complete three-way mirrors with no command behavior change.
- Record downgrade as an active S0b same-uid window, not permission to weaken future Linux isolation; remove only when ADR0010 uid-isolation CI/deployment proof closes it. macOS same-uid development remains documented in ADR.
- Non-goals: new tests of live public models, UID implementation, modifying workflow or thresholds, resolving #141 links.

## Decisions
- Governing invariant: the four command literals agree in Make, AGENTS matrix and exact constraints tuples; no evidence can be implied by a docs row alone.
- Retain exact current smoke/ui-walk matrix/enforcement rows and recipes, including latest four-file smoke if present; add omp-fetch and smoke-live rows only.
- omp-fetch evidence explicitly verified official binary18.0.10/version+SHA, required_at prerequisite; smoke-live evidence manual real-upstream exit0/nonempty done, required_at manual, enforcement review-only. No claim manual live upstream was run here.
- constraints remains source of truth; extend existing surfaces expected/wanted and AGENTS/header checks atomically. Exactly10 surfaces with required command/evidence/required_at, duplicate/missing/renamed entries fail.
- Use existing mapping/markdown grammar; no naive whole-file substring acceptance of a downgrade hidden in comment or unrelated section. Verify named active strictness_profile.downgrades entry and closure text; preserve unrelated entries and old quoted-key/owner positive controls.
- Same-uid downgrade records stated-env-only protection, /proc/config residual vector, chosen S0b scope and ADR0010 S1a exit condition. Do not claim just setting OMP_USER proves deployment isolation.
- Siblings: four Make target duplicate forms, docs matrix/enforcement/directory, constraints verification owner/surfaces and strictness owner/downgrades, source comments/fences, existing CI parser/action matrix.
- Nested Python oracle is decoded, modified as source, reserialized once via repr+shlex.quote; parent checks parsed payload before full execution. Writer must not run validation.

## Evidence
- Test-only oracle handoff first; parent oldbaselineGREEN then updatedoracle oldmirrorsRED for real missing rows/tuples, not malformedPython.
- Candidate allmirrorsGREEN. Disposable mutations independently alter/remove new command/evidence/required_at/level/header/directory and active downgrade; comments/decoys must not satisfy it. Four existing spacedduplicate targets remain RED.
- RestoreGREEN and deterministic external identity receipt; full make test-guardrails plus shell/scope/strictspec. CI exacthead separate gate.

## Migration Plan
Atomic source PR then separate scoped canonical archive; rollback reverts entire mirror+oracle change. Preserve concurrent upstream canonical requirements.
