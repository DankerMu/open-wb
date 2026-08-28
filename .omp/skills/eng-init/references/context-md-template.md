# CONTEXT.md Template

Use this template when Stage 3/4 creates or repairs `CONTEXT.md`. Keep it concise: this file is the domain-language anchor, not a general README.

## File header

```markdown
# CONTEXT.md

> Domain language and business invariants for this repository.
> `AGENTS.md` is the operating contract; this file defines the vocabulary and domain boundaries that agents must use when applying it.
```

## Project identity

```markdown
## Project Identity

{{ONE_PARAGRAPH_DESCRIPTION_VERBATIM_FROM_USER}}

- **Primary users / consumers**: {{CONSUMERS}}
- **Business goal**: {{BUSINESS_GOAL}}
- **Lifecycle**: {{LIFECYCLE}}
```

## Domain language

```markdown
## Domain Language

| Term | Meaning | Not the same as | Source / owner |
|------|---------|-----------------|----------------|
| {{TERM_1}} | {{MEANING_1}} | {{NON_EQUIVALENT_1}} | {{SOURCE_1}} |
| {{TERM_2}} | {{MEANING_2}} | {{NON_EQUIVALENT_2}} | {{SOURCE_2}} |
```

Rules:

- Capture the user's wording verbatim when they define a term.
- If two names appear to mean the same thing, list them under "Open terminology questions" instead of choosing silently.
- Prefer domain terms over technical synonyms in business logic.

## Bounded contexts

Use this section for DDD systems, monorepos with multiple domains, or any repo where the same term can mean different things in different areas.

```markdown
## Bounded Contexts

| Context | Owns | Key terms | Forbidden logic | Integration boundary |
|---------|------|-----------|-----------------|----------------------|
| {{CTX_1}} | {{RESPONSIBILITY_1}} | {{TERMS_1}} | {{FORBIDDEN_1}} | {{BOUNDARY_1}} |
| {{CTX_2}} | {{RESPONSIBILITY_2}} | {{TERMS_2}} | {{FORBIDDEN_2}} | {{BOUNDARY_2}} |
```

## Core invariants

```markdown
## Core Invariants

- {{INVARIANT_1}}
- {{INVARIANT_2}}
- {{INVARIANT_3}}
```

Good invariants are testable or reviewable. Examples:

- Paid orders are never physically deleted.
- Permission changes must be auditable.
- Refunds must preserve the original payment record.

## Public interfaces and contracts

```markdown
## Public Interfaces and Contracts

| Interface | Contract source | Backward compatibility rule | Test seam |
|-----------|-----------------|-----------------------------|-----------|
| {{INTERFACE_1}} | {{SCHEMA_OR_DOC_1}} | {{COMPAT_RULE_1}} | {{TEST_1}} |
```

## Forbidden logic and irreversible operations

```markdown
## Forbidden Logic & Irreversible Operations

Captured verbatim from grilling (Q6.6 out-of-bounds operations and architecture answers); agents must check this section before writing code that deletes data, mutates schemas, or crosses a listed boundary.

| Rule | Scope | Why |
|------|-------|-----|
| {{FORBIDDEN_RULE_1}} | {{SCOPE_1}} | {{REASON_1}} |
| {{FORBIDDEN_RULE_2}} | {{SCOPE_2}} | {{REASON_2}} |
```

## Open terminology questions

```markdown
## Open Terminology Questions

| Question | Why it matters | Candidate terms | Owner |
|----------|----------------|-----------------|-------|
| {{QUESTION_1}} | {{IMPACT_1}} | {{CANDIDATES_1}} | {{OWNER_1}} |
```

## Rendering rules

- Do not invent domain facts. If unsure, write an open question.
- Keep implementation rules out of `CONTEXT.md`; they belong in `AGENTS.md`.
- Keep setup commands out of `CONTEXT.md`; they belong in `AGENTS.md` and the command entry point.
- Link from `AGENTS.md` to this file anywhere terminology, bounded contexts, or invariants affect implementation.
