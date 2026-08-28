# Surveying a Codebase (Brownfield)

How to audit an existing codebase for architecture friction — and how to report it.

## Scope before you scan

Deepening a module pays off by making future changes to it easier, so put extra weight on the parts of the codebase that have recently changed. Decide _where_ to look before you look:

- If the user named a direction — a module, a subsystem, a pain point — take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read the project's domain glossary (`CONTEXT.md`) and any ADRs in the area first.

## Explore organically

Don't follow rigid heuristics — walk the code and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "concentrates" answer is the signal you want.

## The five lenses

Work the audit through these lenses, then merge and prioritize the findings:

1. **Depth / shallowness** — deletion test on every suspect; modules whose interface is nearly as complex as their implementation.
2. **Directory structure vs the complexity ladder** — what the structure currently is, what it should be given the system's actual complexity (see `ddd-layers.md`).
3. **Dependency direction and seams** — inward-rule violations, missing seams, missing adapters, single-adapter hypothetical seams.
4. **DDD anti-patterns** — anemic domain, god aggregates, leaking infrastructure, repository-per-entity, skipped use-case layers, CRUD thinking, premature CQRS (checklist in `ddd-layers.md`).
5. **Duplication and dead code** — the same concept implemented twice in different shapes, redundant abstractions, code nothing calls.

## Findings format

Every finding carries exactly three fields, written in the project's domain language from `CONTEXT.md`:

- **What** — the module or area, named by its domain concept ("the Order intake module"), not an invented class name
- **Why** — the friction, explained in terms of locality and leverage, or the pattern violation
- **Effort** — one of exactly: low, medium, high. A finding that recommends keeping the status quo still gets a label (the effort of acting on it); never use "none", "n/a", or a cross-reference in this field.

Before writing the document, re-check every finding: if any lacks one of the three fields or uses an out-of-set effort value, fix it in the document. The Recommendations section may repeat the labels; findings must carry their own.

Prioritize: the recommendations the user can actually cash in on next are the ones in code that is still changing.
