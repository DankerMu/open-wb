# Layered Patterns: DDD, Clean Architecture, Hexagonal

**Code mirrors language. Dependencies point inward. Start simple, evolve only when complexity forces it.**

## When to use the layers — and when not to

| Use | Skip |
|-----|------|
| Complex business domain with many rules | Simple CRUD, few business rules |
| Long-lived system, team of 5+ | Prototype, MVP, solo developer |
| Multiple entry points (API, CLI, events) | Single entry point, simple API |
| Need to swap infrastructure | Fixed infrastructure, unlikely to change |

Skipping the layers is not a failure — flat is the right call until complexity earns the layers.

## Pattern boundaries

- **DDD** — model a complex business domain: ubiquitous language, bounded contexts, aggregates.
- **Hexagonal** — how the app interacts with the outside: ports, driver/driven adapters, testable core.
- **Clean Architecture** — which direction dependencies point: inward rule, use-case boundaries.
- **CQRS** — divergent read/write workloads only, never as a default.
- **Event Sourcing** — full event history for audit/temporal queries/replay — not CRUD.

## The dependency rule

Dependencies point **inward only**. Outer layers depend on inner, never reverse:

```
Infrastructure → Application → Domain
   (adapters)     (use cases)    (core)
```

The domain has **zero external dependencies** — no database, no HTTP, no framework imports. The test for correct boundaries: domain logic runs in tests with no infrastructure at all.

## Where does this code go?

```
Pure business logic, no I/O           → domain
Orchestrates domain + side effects    → application
Talks to external systems             → infrastructure
Defines HOW to interact (interface)   → port (in domain or application)
Implements a port                     → adapter (in infrastructure)
```

## Entities, value objects, aggregates

- **Entity** — has unique identity that persists; equality by ID; contains behaviour.
- **Value Object** — defined only by attributes; immutable; structural equality.
- **Aggregate** — a consistency boundary; only the root is referenced externally.
  - Must be consistent together in one transaction → same aggregate
  - Can be eventually consistent, or referenced by ID only → separate aggregates
  - More than ~10 entities → split it
- **Domain Event** — past-tense naming (`OrderPlaced`); the mechanism for cross-aggregate consistency.
- **Repository** — one per **aggregate**, never per table.
- **Domain Service** — stateless logic that doesn't fit an entity.
- **Application Service** — coordinates domain + infrastructure; the transaction boundary lives here.

## Anti-pattern checklist

| Anti-pattern | Fix |
|--------------|-----|
| Anemic domain — entities are data bags | Move behaviour into the entities |
| Repository per entity | One repository per aggregate |
| Leaking infrastructure — domain imports DB/HTTP | Domain has zero external deps |
| God aggregate — too many entities | Split by consistency boundary |
| Skipping use cases — controller → repository | Route through the application layer |
| CRUD thinking — modelling data not behaviour | Model business operations |
| Premature CQRS | Start with one read/write model, evolve |
| Cross-aggregate transactions | Domain events for eventual consistency |

## Implementation order

1. Ubiquitous language — glossary in `CONTEXT.md`; class names = glossary terms.
2. Domain model — entities, value objects, aggregates; no infrastructure imports.
3. Ports — repository interfaces, external-service interfaces.
4. Use cases — application services; the transaction boundary.
5. Adapters last — HTTP, database, messaging; swap without touching the domain.

## Directory structure (layered)

```
src/
├── domain/                    # Core business logic (NO external deps)
│   ├── {aggregate}/
│   │   ├── entity             # Aggregate root + child entities
│   │   ├── value_objects      # Immutable value types
│   │   ├── events             # Domain events
│   │   ├── repository         # Repository interface (driven port)
│   │   └── services           # Domain services
│   └── shared/errors
├── application/               # Use cases
│   ├── {use-case}/
│   │   ├── command            # Command/Query DTOs
│   │   ├── handler            # Use case implementation
│   │   └── port               # Driver port interface
│   └── shared/unit_of_work
├── infrastructure/            # Adapters
│   ├── persistence/
│   ├── messaging/
│   ├── http/
│   └── config/di
└── main                       # Bootstrap / entry point
```

## The complexity ladder (directory-structure decision rule)

- **Simple CRUD / solo dev / prototype / MVP** → flat, feature-first layout. A folder per feature, everything the feature needs inside it. No layers.
- **Complex domain, team of 5+, multiple entry points, long-lived** → the layered structure above, or hexagonal with ports at the edges.

## TypeScript note

For TypeScript repos, prefer **entry-point-file deep-module layouts**: each package's implementation hidden in subfolders, reachable only through its entry-point files (the pattern `setup-ts-deep-modules` wires up with dependency-cruiser).
