# Decision Record Operations — distilled from the DeepSeek Harness agent-notes system

Operational lifecycle for Q6.8 decision records, distilled from a production agent-maintained monorepo running ~1300 structured notes across six kinds. The `decision-record-lifecycle` repo-skill template (`repo-skill-templates.md` Template 3) carries the write-time contract; this file carries the **operations**: zones, classification, freeze, garbage collection, and machine checks.

## Zone model

```
.agents/notes/            (or decisions/, notes/ — name to taste)
├── README.md             # lifecycle + kinds + how to write one
├── proposed/{kind}/      # drafts awaiting a decision
├── implemented/{kind}/   # accepted decisions, cited by later work
├── rejected/{kind}/      # explicitly declined — kept while they prevent a tempting fallacy
└── archived/{kind}/      # frozen — never edited
```

Kinds: `architecture/`, `process/`, `testing/`, `bug-fix/`, `feature/`, `simplification/`. A record is classified by what it decides, not by its size. The `rejected/` zone holds declined proposals whose decline itself carries steering value (why not, what was weighed); a rejected note that no longer prevents a tempting mistake is the first GC candidate (rule 4). The DeepSeek Harness reference implementation ships all four zones (`{proposed,implemented,archived,rejected}`).

## Operational rules

1. **The note-required rule**: a non-trivial change includes its decision record in the same PR/change; only mechanical or local edits are exempt. This is what keeps the archive alive — post-hoc documentation dies.
2. **Supersession at write time** — the write-time supersession check is owned by the `decision-record-lifecycle` skill template (`repo-skill-templates.md` Template 3): search active records, fold fully superseded records into the new one, cross-link partially superseded ones; a record is never edited into a different decision.
3. **Archive freeze**: archived records are frozen. Editing an archived record re-classifies the edit as a new proposed note; the frozen original stays. Treating archives as current authority is a category error — the archive preserves history, not truth.
4. **GC by future decision value, not age or quota**: periodically audit the archive. Keep any record whose alternatives, negative guarantees, ownership boundaries, security rules, or reintroduction conditions can still steer future work. Delete rejected notes only when they no longer prevent a tempting fallacy — a rejected note that still blocks a likely mistake is cheap insurance. Classify implemented notes by future decision value; a record nobody will consult again earns deletion or a one-line summary in a coalescing index. Word count and age are discovery aids, never criteria.
5. **Manifest and machine check**: when the notes tree grows beyond a handful of entries, add a manifest (or a verify script) that fails on: duplicate ids, an edited archived record, a kind outside the allowed set, and a record whose frontmatter lacks required fields. Edited-archived detection requires a committed **frozen manifest** (archived path → content hash, written at archive time and reviewed like any change); mtime heuristics are not detection — a checkout or touch defeats them. A notes system without a machine check drifts the same way lint without CI drifts.
6. **Bilingual pairs**: when the repo ships bilingual documentation, each note ships as an i18n pair (`.md` + `.zh.md` or the repo's language pair) generated from one source of truth — never two independently drifting texts.
7. **One pointer, one home**: AGENTS.md carries one pointer line per installed notes rule, inside the section that owns the moment. The procedure lives in the record system, not copied into AGENTS.md.

## Anti-patterns

- A standing command in a note (belongs in the dev entry point).
- A mechanically checkable rule as a note (belongs in a gate).
- Deleting records toward a target count.
- Editing an archived record in place.
- A note system installed without the note-required rule — the trigger moment is the rule itself.
