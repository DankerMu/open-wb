# DDD and TDD Clauses

Inject these into the AGENTS.md `Architecture Discipline` section only if the user opted in during Stage 2.

- DDD clauses load when Q3.1 = `DDD bounded contexts`, with depth controlled by Q3.2 (aware vs strict).
- TDD clauses load when Q4.1 = `required` (and partially when `preferred`).
- Both can co-exist; render in the order shown below.

---

## DDD clauses

### Common to "aware" and "strict"

```markdown
### Domain-Driven Design

This codebase uses Domain-Driven Design to keep business logic and infrastructure separate. The terms below have specific meanings — do not invent synonyms in code or PRs.

#### Ubiquitous language

The canonical vocabulary for this domain lives in `{{CONTEXT_MD_PATH}}` (or in each bounded-context directory's `CONTEXT.md` for multi-context repos). When the user uses a term that conflicts with the glossary, surface the conflict. Do not silently introduce a new synonym.

When a domain term is resolved during a conversation, update `CONTEXT.md` inline — do not batch glossary updates.

#### Layering

| Layer | Path | May depend on | Forbidden to import |
|-------|------|----------------|---------------------|
| Domain | `{{DOMAIN_PATH}}` | nothing (pure code) | framework, infra, application |
| Application | `{{APP_PATH}}` | domain | infra, presentation |
| Infrastructure | `{{INFRA_PATH}}` | domain (via ports), application | presentation |
| Presentation | `{{PRES_PATH}}` | application | domain (only via DTOs), infra |

Boundary enforcement: `{{BOUNDARY_TOOL}}` ({{BOUNDARY_CONFIG_PATH}}).

#### Aggregates

- An aggregate has exactly one root entity. All external references go through the root, never directly to internal entities.
- Aggregates are consistency boundaries: a single transaction touches one aggregate. Coordination across aggregates uses domain events, not joined writes.
- Aggregate state mutations happen inside the aggregate's methods, never via setters from outside. If a method does not naturally belong on the aggregate, reconsider before adding a service to do the same job from outside.

#### Repositories

- One repository interface per aggregate root, defined in the domain layer.
- Repository implementations live in `{{INFRA_PATH}}/persistence/`. The domain layer never imports them — application services inject them via constructor.
- Repository methods are named in domain terms (`findByEmail`, `cancelOrder`), not data terms (`selectFromOrdersWhere`).

#### Domain services

- Reach for a domain service only when behaviour does not fit on an entity or value object. If you can put it on the aggregate root cleanly, do that instead.
- Domain services are stateless and live in the domain layer. They have no dependencies on infrastructure.

#### Value objects

- Immutable. Equality by value, not by identity.
- Implemented via `record` (Java 17+), `dataclass(frozen=True)` (Python), `final class` with `__init__` validation (TS), `Eq + PartialEq` derived structs (Rust), unexported struct with constructor returning value (Go).
```

### Additional clauses when "strict"

```markdown
#### Bounded contexts

Each bounded context is a self-contained slice of the domain with its own ubiquitous language. Contexts may not directly import each other's domain types.

| Context | Path | Owns | Anti-corruption layer to |
|---------|------|------|--------------------------|
| {{CTX_1}} | `{{CTX_PATH_1}}` | {{CTX_RESPONSIBILITIES_1}} | {{ACL_TARGET_1}} |
| {{CTX_2}} | `{{CTX_PATH_2}}` | {{CTX_RESPONSIBILITIES_2}} | {{ACL_TARGET_2}} |

#### Anti-corruption layer

When context A consumes data from context B, it translates B's types into A's vocabulary at the boundary. This translation lives in `{{ACL_PATH_PATTERN}}` (e.g., `<context>/acl/<other_context>.<ext>`). Do not let foreign types leak deeper than this layer.

#### Domain events

- Aggregates emit domain events from their mutation methods. Events are recorded inside the aggregate, then dispatched after the aggregate's transaction commits (transactional outbox pattern recommended for cross-service delivery).
- Event names are past-tense verbs (`OrderPlaced`, `PaymentRefunded`). No `WillX` or `XIntent`.
- Event payloads are stable contracts — additive changes only. Removing or renaming a field is a breaking change requiring a versioned event type.

#### Decision records

Significant DDD decisions (context boundaries, when to split an aggregate, why a translation exists) are captured as ADRs in `docs/adr/`. ADRs are immutable once merged; supersede with a new ADR rather than editing.
```

---

## TDD clauses

### Common to "preferred" and "required"

```markdown
### Test-Driven Development

The test is the specification. Write the test before the implementation; if the test cannot be written, the requirement is not yet clear enough to implement.

#### Cadence

1. **Red** — write the smallest failing test that captures the next bit of behaviour. Run it. Confirm it fails for the right reason.
2. **Green** — implement the minimum code that makes the test pass. Resist generalizing prematurely.
3. **Refactor** — with tests green, clean up names, structure, duplication. Run tests again.
4. **Commit** — at green-and-clean points. Commit messages reflect what changed in behaviour, not what files changed.

The cadence is the discipline. Skipping red-first because "the change is small" is exactly when discipline matters most — small changes accumulate undetected.

#### Test naming and structure

- Test names are sentences describing behaviour: `it_rejects_orders_with_zero_quantity`, `returns_error_when_customer_id_missing`.
- Three blocks per test: arrange / act / assert. Separate with blank lines.
- One concept per test. If you need "and" in the test name, split it.
- Test files mirror source files: `src/foo.<ext>` → `src/foo.test.<ext>` (or `tests/test_foo.<ext>` per stack convention).

#### What gets tested

- All public functions and methods that have non-trivial behaviour.
- All branches in conditional logic; mutation testing tools welcome but not required.
- Error paths, not just happy paths. A test that only proves "no exception thrown" is incomplete.
- Boundary conditions (empty input, max input, null/None, zero, negative, off-by-one ranges).

#### What does NOT need a test

- Pure pass-through wiring (constructors that store fields).
- Generated code (DB migrations from ORM, OpenAPI stubs).
- Trivial getters/setters.
- Test scaffolding itself (no tests-of-tests).

#### Test isolation

- Each test runs independently — no shared mutable state between tests. Use fresh fixtures.
- Tests run in parallel by default. If a test cannot run in parallel, mark it explicitly (`#[serial]` / `pytest.mark.serial` / etc.) and explain why in a comment.
- Database tests use transactions that roll back, or use `testcontainers` for a fresh DB instance per test class.
- No reliance on test ordering. If test A passes only because test B ran first, refactor.

#### Flakiness

A flaky test is a bug, not a nuisance. When a test fails intermittently:

1. Quarantine it (skip with explicit `flaky` marker linking to an issue).
2. Open an issue with the failure logs.
3. Fix or delete within {{FLAKY_FIX_BUDGET_DAYS}} days. Never let quarantined tests rot.
```

### Additional clauses when "required" (TDD strict)

```markdown
#### Strict TDD enforcement

- **No production code without a failing test first.** PRs that add a function without a corresponding test addition in the same PR are CI failures.
- **Coverage gate**: `{{COVERAGE_PERCENT}}%` minimum, enforced by CI (`{{COVERAGE_CONFIG_PATH}}`). Below the threshold, CI fails; above, the gate is silent.
- **Mutation testing** (recommended): `{{MUTATION_TOOL}}` (e.g., `stryker`, `mutmut`, `cargo-mutants`) run weekly or before release. Surviving mutants are reviewed.
- **Integration tests are first-class**, not optional. Every external boundary (HTTP handler, queue consumer, scheduled job) has at least one integration test against a real or `testcontainers` backing service.

#### Forbidden in strict TDD mode

- Disabling tests to make CI pass.
- `it.skip` / `@pytest.mark.skip` / `#[ignore]` without a linked issue and a deadline.
- Tests that only assert "no exception thrown".
- Mocking the system-under-test (mock its dependencies; never the thing you're testing).
```
