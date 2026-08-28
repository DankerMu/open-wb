# Agent-Harness Architecture Clauses — distilled from the DeepSeek Harness SDK

Architecture-discipline clauses for repos whose primary consumers are AI agents (or that build agent tooling). Use with `lang-constraints.md`: that file covers language stacks; this file covers the *agent-facing* architecture invariants that static lint cannot see. Opt in as a question-bank clause set; each clause is a Convention-level rule unless a mechanical check exists.

## Clauses

### Model-visible ⟺ logged
Anything that reaches a model request must be reconstructable from the session log; a new model-visible input requires a session-log event. This is the auditability invariant of agent products: if the transcript cannot reproduce what the model saw, debugging and postmortems are guesswork. Mechanical form: an event-sourced session log with a versioned schema; schema changes are explicit, never silent.

### Capability seams are complete
A capability comprises three roles: Service Definition, Service provider, Consumer. A seam is complete only when all three exist; split roles only when they evolve independently. An agent tool that calls a provider directly (skipping the service definition) is a seam violation that will fork into two sources of truth.

### Registrations are effects
Every contribution goes through the framework's effect/event registration (`ctx.effect()`, `ctx.on()`); a registry's `register()` returns the disposer. Registrations dispose with their owner. Test: dispose the contributing fiber and observe removal (HMR-safety test).

### Explicit > implicit at package boundaries
Defaulting is an explicit `resolve(request): Spec` step in the owning implementation, never a hidden `?? default` inside `run()`. Callers must be able to see which defaults applied.

### No hardcoded tunables
Deployment-varying choices (timeouts, budgets, thresholds) are validated Config fields changeable from the composition file — a `DEFAULT_*` constant or test hook is not configurability. Protocol constants, external specs, and security invariants stay fixed.

### Misconfiguration fails loud
A misconfiguration fails at load when self-contained, otherwise at the earliest resolvable point; never silently skip a missing referent. A plugin that starts with a broken config and "works anyway" teaches operators to ignore errors.

### Runtime invariant companions
Each package/module owns an invariant companion: a registration that asserts **owned relationships over authoritative event streams or mutable data** — not the presence of services, not plugin metadata, not fixed pure examples. Rules:
- Check the authoritative source: the event stream or mutable registry the relationship actually flows through.
- An empty companion is correct only when explained: "no runtime invariant: this adapter has no independent lifecycle stream" with the reason. An unexplained empty is a smell.
- A verify script enforces the companions in CI; a companion that never runs is phantom enforcement.
This is the runtime half of the "Invariant" control-plane layer — static lint guards what must not drift in text; companions guard what must not drift in behavior.

### External-tool compatibility
When agents must interoperate with existing tooling (Claude Code/Codex-style hook bridges, MCP-style tool servers, editor protocols), keep the seam namespaced and scrubbed: expose third-party tools under a namespaced prefix (`mcp__<server>__<tool>`, `hook://<name>`) so the model can tell provenance apart, and never inherit credential-bearing environment into a spawned child — scrub `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`-named variables and every host-owned variable before launching a hook or tool subprocess, just as for any untrusted output path. A compatibility seam that leaks the host environment turns an integration surface into a credential exfiltration path.

### Schema versioning discipline
Durable formats (session logs, config schemas, storage records) carry an explicit, monotonically increasing version; a reader rejects formats newer than it understands instead of guessing, and a writer never silently downgrades. Before the first tagged release, prefer the correct foundation over compatibility shims: rename or repackage freely and update every consumer in the same change, because no external consumer depends on the old names. After that release, version bumps are deliberate events: old-format rejection (or an explicitly owned migration) replaces silent tolerance, and a version field that does not monotonically increase is a defect.


### Change discipline
The change itself is part of the architecture when agents write most of it. Commit only intended paths (never `git add -A`); run the smallest test set that covers the outgoing diff before pushing; never bypass hooks or gates; never relax an existing gate in the target repository to fit your own output — relocate, condense, or write less, and propose threshold changes as their own decision. Cut over cleanly: update every caller in the same change, or declare an explicit staged-coexistence contract with an owner, a retirement condition, and a deletion trigger. A change that cannot state which existing behavior it preserves or replaces is not reviewable.

### Cross-boundary ids are branded
Opaque ids crossing process/package/wire boundaries carry a distinct type (branded string), never a bare `string`. A session id and a tool-call id are not interchangeable even though both serialize to strings.

### Waterfall listeners delegate
Middleware-style listeners must call `next()` to delegate; returning without it short-circuits the chain. A listener that forgets `next()` silently disables everything downstream.

## Mapping

- These clauses feed the "Architecture Discipline" AGENTS.md section and the readiness criteria `runtime_invariants`; the invariant-companion pattern is scaffoldable (Class A/B) when the repo has a service/plugin architecture.
- The model-visible ⟺ logged clause is the one with the highest leverage for agent products — audit it first.
