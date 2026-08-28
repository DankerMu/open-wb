# Defensive Patterns Seeds — distilled from the DeepSeek Harness SDK

Class-level bug rules that actually shipped (or nearly shipped) in a production agent harness, stated as rules that prevent the whole class. These are **seeds**, not installable content: eng-init's incident pipeline promotes a repo's own danger patterns only after ≥2 converging incidents (`incident-pipeline-templates.md`). Use this file as the reference catalog for what a mature defensive-patterns doc looks like, and as inspiration when writing a repo's first patterns.

## The seed catalog

1. **Report orthogonal outcomes independently.** A process can time out AND exit 0 (it trapped the signal). Surface each independent fact (`timedOut`, `signal`, `exitCode`) on its own; never nest one flag's report inside another's branch, or a caller reads a cut-short run as clean success.
2. **Honor public contracts on BOTH sides.** When an implementation receives several representations of one outcome, normalize them before returning through the public API. Consumers must never guess whether a caught exception came from the provider, a wrapper, logging, or their own assembly.
3. **Async state is not synchronous state.** No per-message completion, no causal attribution across race boundaries: several queued follow-ups may share one running interval; cancellation can discard unstarted items. An automation caller that truly owns a run defines its interval explicitly — and handles the "nothing to wait for" branch.
4. **Dispose must reach quiescence, not just request it.** A teardown that issues kills/aborts but returns before the work stops leaves orphans. Make cleanup async, await children's exit (kill → await `done`), and close listener registries BEFORE killing so late completions stay silent.
5. **Contain callback exceptions in the dispatcher.** A user-supplied listener that throws must not reject the promise it runs inside or starve listeners after it. Wrap the dispatch loop; one bad subscriber never breaks core lifecycle.
6. **Never hand untrusted output the ambient environment or predictable paths.** Spawned commands get a scrubbed env (drop `*KEY*`/`*SECRET*`/`*TOKEN*`/`*PASSWORD*`) so harness credentials cannot leak into output, env, or spill files. Temp/spill files use a private (0700) dir, random names, and exclusive owner-only opens (`'wx'`, `0o600`) — predictable world-readable paths invite symlink races and disclosure.

## How to use seeds

- When a repo's first incident lands and its postmortem converges toward a class, check the seed catalog for the matching rule: adapt it to the repo's language and mechanism, then land it in the repo's own danger-patterns doc with the incident link.
- Never copy seeds verbatim into a repo as if they were its own earned patterns — an unearned pattern list is a best-practices list nobody reads.
- The three-layer landing contract still applies to every seed adapted: prose rule + policy implication + mechanical guardrail (or explicit `not applicable` with reason).
