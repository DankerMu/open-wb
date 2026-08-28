# Deep Modules

Design **deep modules**: a lot of behaviour behind a small interface, placed at a clean seam, testable through that interface. Use this language wherever module shape is being decided — the aim is leverage for callers, locality for maintainers, testability for everyone.

## Glossary

Use these terms exactly — don't substitute "component," "service," "API," or "boundary." Consistent language is the whole point.

**Module** — anything with an interface and an implementation. Deliberately scale-agnostic: a function, class, package, or tier-spanning slice. _Avoid_: unit, component, service.

**Interface** — everything a caller must know to use the module correctly: the type signature, but also invariants, ordering constraints, error modes, required configuration, performance characteristics. _Avoid_: API, signature.

**Implementation** — what's inside a module. Reach for "adapter" instead when the seam is the topic.

**Depth** — leverage at the interface: behaviour a caller (or test) can exercise per unit of interface they must learn.

**Seam** _(Feathers)_ — a place where you can alter behaviour without editing in that place; where a module's interface lives. _Avoid_: boundary.

**Adapter** — a concrete thing that satisfies an interface at a seam. A role, not a substance.

**Leverage** — what callers get from depth: one implementation paying back across N call sites and M tests.

**Locality** — what maintainers get from depth: change, bugs, knowledge, and verification concentrate in one place.

## Deep vs shallow

```
Deep module:                     Shallow module (avoid):
┌─────────────────────┐          ┌─────────────────────────────────┐
│   Small Interface   │          │       Large Interface           │
├─────────────────────┤          ├─────────────────────────────────┤
│                     │          │  Thin Implementation            │
│  Deep Implementation│          │  (just passes through)          │
└─────────────────────┘          └─────────────────────────────────┘
```

When designing an interface, ask: can I reduce the number of methods? Can I simplify the parameters? Can I hide more complexity inside?

## Principles

- **Depth is a property of the interface, not the implementation.** A deep module can be internally composed of small, swappable parts — they just aren't part of the interface.
- **The deletion test.** Imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.** Callers and tests cross the same seam. If you want to test *past* the interface, the module is probably the wrong shape.
- **One adapter means a hypothetical seam. Two adapters means a real one.** Don't introduce a seam unless something actually varies across it.

## Designing for testability

1. **Accept dependencies, don't create them.** `processOrder(order, paymentGateway)` tests; `new StripeGateway()` inside doesn't.
2. **Return results, don't produce side effects.** `calculateDiscount(cart): Discount` tests; mutating `cart.total` doesn't.
3. **Small surface area.** Fewer methods and params = fewer tests, simpler setups.

## Dependency categories (decide how a deepened module is tested)

1. **In-process** — pure computation, in-memory state, no I/O. Always deepenable; test through the new interface directly; no adapter.
2. **Local-substitutable** — dependencies with local test stand-ins (PGLite for Postgres, in-memory filesystem). Deepenable; test with the stand-in in the suite; the seam is internal, no port at the external interface.
3. **Remote but owned** — your own services across a network. Define a **port** at the seam; the transport is injected as an **adapter** (in-memory for tests, HTTP/gRPC/queue for production).
4. **True external** — third-party services you don't control (Stripe, Twilio). Take the dependency as an injected port; tests provide a mock adapter.

## Seam discipline

- **Internal seams vs external seams.** A deep module can have internal seams (private to its implementation, used by its own tests). Don't expose them through the interface just because tests use them.
- **Replace, don't layer.** Once tests exist at the deepened module's interface, delete the old unit tests on the shallow modules — they're waste. New tests assert observable outcomes through the interface and survive internal refactors; a test that must change when the implementation changes is testing past the interface.

## Design it twice

Your first interface idea is unlikely to be the best. For a load-bearing interface:

1. **Frame the problem space** — constraints any interface must satisfy, the dependency categories involved, a rough illustrative sketch (not a proposal). Show the user; proceed immediately.
2. **Spawn 3+ sub-agents in parallel**, each designing a **radically different** interface, each with its own technical brief (paths, coupling, dependency category, what sits behind the seam) and a different constraint: minimize the interface (1–3 entry points) / maximise flexibility / optimise for the most common caller / design around ports & adapters. Each outputs: the interface, a usage example, what the implementation hides, the dependency strategy, trade-offs.
3. **Present sequentially, then compare** on **depth**, **locality**, and **seam placement**. Give your own opinionated recommendation; propose a hybrid if elements combine well.
