# Consistency & Drift Checklist (Entropy Dimensions)

Detailed checks for the consistency/drift axis of `review` (formerly the standalone `entropy-review` skill). Use in consistency mode, or when a change set warrants drift analysis alongside correctness review.

These dimensions are the diff-granularity instantiation of the entropy suite's shared six-axes vocabulary (`control-plane-auditor` `references/methodology/six-entropy-axes.md`). Mapping:

| Dimension | Six-axes vocabulary |
|---|---|
| Naming Consistency | Semantic |
| Error Handling Consistency | Behavioral |
| Dependency Direction | Structural |
| Documentation Sync | Context |
| State Model | Semantic |
| Pattern Duplication | Structural / Behavioral |
| Pattern Contagion (agent-era) | Control (replication with no enforcement brake) |
| Agent Verifiability (agent-era) | Context / Control |

The names differ because the object differs: axes describe where a *repository* loses order; these dimensions describe what a *single change* is about to make worse. Keep using the dimension names in findings; use the axes when aggregating across changes or comparing with `repo-entropy-audit` output.

No diff-level dimension maps to the **Protocol** axis: changes to instruction files, CI, or agent protocols are control-plane concerns and should route to `control-plane-auditor` rather than an entropy review.

---

## Naming Consistency

### What to check
- Do new exported identifiers follow the naming conventions in AGENTS.md?
- Do new identifiers for existing domain concepts use the canonical glossary term?
- Is the casing style consistent with the surrounding code (camelCase, PascalCase, snake_case)?
- Are new file names consistent with the project's file naming convention?

### Detection patterns
```bash
# Find new exported identifiers in the diff
git diff --name-only | xargs grep -n "export "

# Compare against glossary terms (if glossary exists)
# Look for domain concept names that don't appear in the glossary
```

### Common false positives
- Third-party library types that follow a different convention (legitimate)
- Test files using different naming for test fixtures (usually acceptable)
- Generated code with its own naming scheme (should be excluded from review)

---

## Error Handling Consistency

### What to check
- Do new try/catch blocks follow the project's error model?
- Do new API error responses use the standard error envelope?
- Are new error codes within the defined taxonomy, or are they ad-hoc?
- Are boundary behaviors consistent? (null vs empty vs throw vs silent default)
- Are errors logged using the structured logging format?

### Detection patterns
```bash
# Find new error handling in the diff
git diff -U5 | grep -A5 "catch\|throw\|Error\|err\b"

# Find new HTTP status codes
git diff | grep -n "status\|StatusCode\|HttpStatus"

# Find new error response shapes
git diff | grep -n "message.*error\|error.*message\|code.*error"
```

### Common false positives
- Error handling in test code (test assertions, mock errors)
- Error re-throwing with added context (usually good practice)
- Framework-specific error patterns that follow framework conventions

---

## Dependency Direction

### What to check
- Do new imports respect declared layer boundaries?
- Are there new imports from `util/common/helpers` that should go through a domain module instead?
- Are there new cross-module imports that bypass the declared dependency direction?
- Is business logic being added to shared/utility packages?

### Detection patterns
```bash
# Find new imports in the diff
git diff | grep "^+.*import\|^+.*require"

# Cross-reference against dependency rules in AGENTS.md
# Check for imports that go "upward" in the dependency hierarchy
```

### Common false positives
- Type-only imports (import type) that don't create runtime coupling
- Test imports that reference implementation details (usually acceptable in test code)
- Circular imports within the same bounded context that are intentionally co-located

---

## Documentation Sync

### What to check
- If the diff changes an API signature, is the corresponding API doc updated?
- If the diff changes behavior described in AGENTS.md, is the instruction file updated?
- If the diff changes a state machine, is the state model doc updated?
- If the diff touches a path with doc freshness rules, are those rules satisfied?

### Detection patterns
```bash
# List changed source files
git diff --name-only --diff-filter=M

# For each, check if there's a corresponding doc that should be updated
# Look for freshness rules in AGENTS.md: "if X changes, update Y"
```

### Common false positives
- Internal refactoring that doesn't change external behavior (doc update not needed)
- Adding tests (usually no doc update needed)
- Formatting/style changes (no doc update needed)

---

## State Model

### What to check
- Does the diff introduce new status/state/phase values?
- Are new state values compatible with existing state definitions?
- Is the new state value added to the canonical state definition, or is it a shadow definition?
- If a new state transition is added, does it follow the documented state machine?

### Detection patterns
```bash
# Find new status/state/phase definitions
git diff | grep -n "status\|state\|phase\|Status\|State\|Phase" | grep "^+"

# Check for enum additions
git diff | grep -A3 "enum.*Status\|enum.*State\|enum.*Phase"
```

### Common false positives
- UI display states that are local to a component (not domain state)
- Test state setup (fixtures, mocks)
- Temporary processing states within a single function scope

---

## Pattern Duplication

### What to check
- Does the diff introduce logic that is semantically equivalent to existing code in another module?
- Does the diff copy a pattern that has been flagged for retirement (in quality docs, cleanup backlog, or code comments)?
- Could the new code reuse an existing shared abstraction instead of reimplementing?

### Detection patterns
```bash
# Look for structural similarity between new code and existing code
# This is harder to automate; rely on reading the diff in context

# Check for TODO/FIXME/HACK markers in the area being modified
git diff -U10 | grep "TODO\|FIXME\|HACK\|DEPRECATED\|@deprecated"
```

### Common false positives
- Intentional duplication for isolation (e.g., a module that must not depend on another)
- Similar-looking code that handles genuinely different domain concerns
- Standard patterns (logging setup, configuration loading) that are expected to repeat

---

## Pattern Contagion (Agent-Era Check)

### What to check
- Is the new code replicating a pattern that appears in many places but is known to be suboptimal?
- Is the new code modeling itself after a deprecated or flagged pattern in the repo?
- If this pattern is copied N more times by future agents, would that be acceptable?

### Detection patterns
```bash
# Check if the pattern being introduced matches known-bad patterns
# Look for @deprecated, LEGACY, HACK markers in code being used as a template
git diff -U10 | grep -B5 -A5 "import.*from\|require(" | grep "@deprecated\|DEPRECATED\|LEGACY"
```

### Key question
The core question is not "is this code duplicated?" but "if an agent sees this PR merged and treats it as the project standard, would that be acceptable?" If not, the pattern needs to either be fixed before merge or explicitly marked as not-to-be-replicated.

### Common false positives
- Code that is legitimately the current standard, even if a migration is planned for the future
- Test code that mirrors production patterns for testing purposes

---

## Agent Verifiability (Agent-Era Check)

### What to check
- Can the behavioral change introduced by this PR be verified by running tests alone?
- If not, is there a smoke test, dev server check, or observable outcome that an agent can use?
- Does the PR change behavior that is only verifiable in production (higher risk)?

### Detection patterns
- Check if changed files have corresponding test files
- Check if changed API routes have integration/contract tests
- Check if the PR changes configuration or environment-dependent behavior (harder to verify locally)

### Key question
"If an agent made this exact change in a future session, could it verify the change worked without asking a human?" If the answer is no, consider adding a verification step (test, smoke check, or explicit verification command in the plan).

### Common false positives
- Infrastructure changes that inherently require deployment to verify
- UI changes that require visual inspection (though screenshot tests can help)

---

## Constraint Context (load before analyzing)

Effectiveness depends on constraint information in the target repo's instruction files. For each affected module: read the nearest and root AGENTS.md; extract glossary, dependency rules, error model, naming conventions, doc freshness rules, state model references. When `openspec/glossary.md` exists, treat it as the canonical domain glossary (the convention maintained by `grill-me` docs mode); AGENTS.md-level constraints supplement it. If none found, note "no formal constraints available; reviewing against surrounding code patterns" and assess against surrounding code.

If constraints are missing or thin, list them at the end under "Constraint Gaps" and suggest running `control-plane-auditor` to establish them first:

```
## Constraint Gaps

- [ ] Glossary (no canonical terms defined)
- [ ] Error Model (no standard envelope documented)

→ Run `control-plane-auditor` for a full gap analysis and improvement plan.
```

## E-Severity (consistency axis grading)

Grades are **harm-based, not dimension-coded**: any dimension can yield any grade. A naming change is E0 when it forks the glossary's canonical term, but E2 when it is a one-off local inconsistency.

| Level | Name | Meaning | Gate |
|-------|------|---------|------|
| **E0** | Standard Conflict | Direct conflict or fork with an established project standard (error model, state definition, glossary term, dependency rule) | Fails the consistency verdict |
| **E1** | Divergent Pattern | Introduces a new divergent pattern with high replication risk | Fix before merge |
| **E2** | Localized Inconsistency | Local inconsistency that does not fork a standard | Fix or accept with a note |
| **E3** | Doc/Metadata Desync | Documentation or metadata out of sync with the changed behavior | Note |

**Finding format**: tag the grade, name the dimension, cite the location, give a fix direction:

```
**[E1] Naming Drift** — `apps/api/src/auth/handler.ts:42`
New identifier `fetchUserProfile` uses "User" instead of glossary term "Member".
Surrounding code uses `getMember*` pattern; likely to be copied by later code.
→ Consider: rename to `fetchMemberProfile` before merge.
```

**Consistency-only verdict** (consistency mode): ❌ Standard conflict — any E0. ⚠️ Fix before merge — no E0, one or more E1. ✅ Clean — E2/E3 reported as notes.

**Crosswalk into P-severities** (when consistency findings fold into a standard or cross review): E0 → P1 (or P0 if it breaks a selected risk-pack invariant), E1 → P2, E2 → P2, E3 → Note. Defined canonically in `risk-adaptive-cross-review`'s `references/finding-contract.md`.
