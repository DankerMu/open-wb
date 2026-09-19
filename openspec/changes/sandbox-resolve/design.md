## Context
Issue #112 implements parent design D2 only. Existing static-file traversal in app.ts serves a different contract and is not replaced.

## Goals / Non-Goals
Change surface: one core resolver and paired tests.
Must preserve: HTTP static serving, migrations, existing routes and error envelopes; no feature imports.
Must add: synchronous `resolve(root, relPath, op)` returning `{ok:true, absPath}` or `{ok:false, reason}`.
Governing invariant: rejected paths have no filesystem side effects; successful paths stay inside canonical root and traverse no symlink components below that root.
Sibling surfaces: lexical input checks, canonical-root boundary, raw component traversal, mkdir basename checks; future #123 facade consumes rejection reasons.
Non-goals: facade/audit, mkdir execution, concurrent filesystem mutation protection, HTTP integration, root provisioning.

## Decisions
Use native filesystem metadata only; never read target contents or create entries.
Canonicalize the trusted deployment root; check each user-supplied component before normalization can erase a symlink followed by `.` or an empty segment.
Reject traversal components and invalid mkdir terminal names before path normalization.
Missing descendants are allowed by the parent requirement; unexpected metadata failures must not yield success.
Reasons are nonempty diagnostic strings, not a new public error-code taxonomy.
Seams under test: exported resolver with real temporary directories, real symlinks, and recursive before/after entry snapshots.

## Required evidence
Eight parent escape vectors return rejection with a reason and an unchanged tree.
Empty path, `a`, `a/b/c.md` return exact canonical paths for ordinary or missing descendants.
Mkdir rejects `a/.`, `a/..`, `a/b\c`, `a/`; accepts `out`, `a/out` without creation.
Symlinks to inside root are also rejected; normalization must not hide symlink traversal.

## Risks / Trade-offs
Metadata checks do not prevent TOCTOU between resolution and later IO; this slice must not claim race-free IO confinement.
macOS temporary directory aliases require canonical-root expected values, not rejection of trusted ancestor aliases.
Review focus: component order, symlink no-follow semantics, missing-path handling, side-effect oracle sensitivity.
Human white-box review is a merge gate under repository Critical Paths.
