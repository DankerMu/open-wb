# Documentation Discipline (conditional module — Q6.11)

The documentation half of knowledge management, distilled from the DeepSeek Harness SDK's doc system (bilingual docs, scripted doc gates, mandatory known-limitations sections, generated catalogs). Default **off** — eng-init's scope principle is "never documentation by default"; this module installs only when Q6.11 opts in, because doc discipline without a repo that wants it is dead weight.

## What the module installs

1. **Docs-change-with-code rule** — README/JSDoc updated in the same change as the behavior they describe: config keys, defaults, error codes, wire fields, CLI flags. A doc that describes behavior that no longer exists is a trap for the next agent.
2. **Scripted doc gate** — a doc-validation script wired into CI that fails on drift: stale references, missing required sections, budget overflows. The gate must be able to fail on a plausible violation (a gate that cannot fail is decoration). Word budgets and required sections are validated mechanically, not by review.
3. **Known Limitations discipline** — a mandatory "Known Limitations and Deferred Work" section on durable consumer surfaces (package READMEs, public interfaces), with a justified allowlist for the rare exception. Durable consumer gaps are named in the section; ordinary cleanup stays in TODOs. A surface that hides its gaps teaches agents to rediscover them.
4. **Generated catalogs regenerate, never hand-patch** — a generated artifact (API catalog, config catalog, type graph) is a projection: change its authority, regenerate deterministically, diff the output, verify invalidation of stale outputs. Patching the derived output as the source of truth breaks the next regeneration; claiming a hand-edit is reproducible without proof is fabrication.
5. **One home per fact** — current-state prose lives in exactly one place; cross-references link instead of copying. Two drifting copies of the same fact is the documentation equivalent of a merge conflict nobody resolved.
6. **Bilingual pairs (optional, repo-dependent)** — when the repo ships bilingual docs, each doc is an i18n pair generated from one source; translation gates are scripted.

## Installation contract

- The write set is: the doc-gate script (or the repo's existing doc tool wired into CI), the AGENTS.md clause, and the Known-Limitations allowlist mechanism — nothing else. Docs themselves are never fabricated by eng-init.
- **No-CI fallback**: when the repo has no CI, wire the doc gate into the selected dev entry point (`package.json` check script or the equivalent) and record the CI wiring as a readiness gap — never invent a CI file to satisfy the module, and never leave the gate unwired.
- The trigger moment must exist: a repo with no docs, no public surfaces, and no generated artifacts gets a decline with the empty-shell reason (installing a doc gate with nothing to gate trains agents to ignore the layer).
- Feeds criterion `documentation_gates`.

## Anti-patterns

- Fabricating docs to make the gate green.
- A doc gate that warns but never fails CI.
- Hand-editing a generated catalog.
- Copying the same fact into two homes.
