# ADR and CONTEXT.md Discipline

Record decisions the moment they crystallise — never batch them at the end. A decision that isn't written down will be re-litigated by the next session.

## CONTEXT.md — a glossary and nothing else

`CONTEXT.md` is the project's glossary. It is **devoid of implementation details** — never a spec, a scratch pad, or a home for implementation decisions.

- Create it lazily — only when the first term is resolved.
- Single root file for most repos. If a `CONTEXT-MAP.md` exists at the root, the repo has multiple contexts; the map lists each context's `CONTEXT.md` and how the contexts relate. Infer which context the current topic relates to; ask if unclear.

### Glossary rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_:`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only project-specific terms.** General programming concepts (timeouts, error types, utility patterns) don't belong, even if the project uses them heavily.
- Group terms under subheadings when natural clusters emerge.

### Upkeep discipline (inline, as you work)

- **Challenge against the glossary** — "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"
- **Sharpen fuzzy language** — propose a precise canonical term for vague or overloaded words ("you're saying 'account' — do you mean the Customer or the User?").
- **Stress-test with scenarios** — invent edge-case scenarios that force precision about the boundaries between concepts.
- **Cross-reference with code** — check that stated behavior matches the code; surface contradictions.
- **Update `CONTEXT.md` right there** as each term resolves. Never batch these up.

## ADRs — when and how

ADRs live in `docs/adr/`, sequentially numbered: `0001-slug.md`, `0002-slug.md`… Scan for the highest existing number and increment by one. Create the directory lazily.

### Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. An ADR can be a single paragraph — the value is recording _that_ a decision was made and _why_, not filling out sections.

Optional sections, only when they add genuine value: **Status** frontmatter (`proposed | accepted | deprecated | superseded by ADR-NNNN`), **Considered Options** (rejected alternatives worth remembering), **Consequences** (non-obvious downstream effects).

### When to record

All three must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — genuine alternatives existed and you picked one for specific reasons

If any of the three is missing, skip the ADR — an easy-to-reverse decision will just get changed later anyway, an unsurprising one has nobody to inform, and a no-choice decision records nothing beyond the obvious.

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target — not every library, just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** Anything a reasonable reader would assume the opposite of — these stop the next engineer from "fixing" something deliberate.
- **Constraints not visible in the code.** Compliance restrictions, latency contracts with partner APIs.
- **Non-obvious rejected alternatives.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.
