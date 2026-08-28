# Language-Specific Constraint Clauses

Inject the matching block into the AGENTS.md `Stack & Versions` and `Conventions` sections during Stage 3 rendering.

`{{MAX_FILE_LINES}}` and `{{MAX_COMPLEXITY}}` resolve from the chosen strictness profile (question-bank Q1.4 table; recorded in `constraints.yaml`). Do not hardcode 900/20 — those are only the L2 values. At L1 these checks are warn-level; at L2+ they block.

Five primary stacks are covered: Go, Python, Rust, TypeScript + React/Next.js, Java. Other stacks (Ruby, C#, PHP, Swift, Kotlin) — render a minimal inline block based on the same template skeleton at the bottom of this file.

---

## Go

```markdown
### Go-specific rules

- **Toolchain**: Go {{GO_VERSION}}. Pinned via `go.mod`'s `go` directive. `go.work` if monorepo.
- **Modules**: One module per app. Internal packages live under `internal/`; the Go compiler enforces visibility (use this instead of comments).
- **Linter**: `golangci-lint` ({{GOLANGCI_CONFIG}}). Enabled linters at minimum: `govet`, `staticcheck`, `errcheck`, `gocritic`, `gofumpt`, `revive`, `gosec`, `unused`, `deadcode`, `nilerr`, `wrapcheck`.
- **Formatter**: `gofumpt` (stricter superset of `gofmt`). Run on every commit.
- **Anti-drift tools**: duplicate code via `dupl -threshold 100` (fixed token heuristic, not the profile percent threshold), dead/unused code via `golangci-lint run --enable=unused`, complexity drift via `gocognit`; conventional commits via the bash `commit-msg` hook in `aux-file-templates.md`. Do not add Node-only `jscpd` or `commitlint` to Go-only repos unless the user explicitly accepts Node as repo tooling.
- **Size discipline**: source files over {{MAX_FILE_LINES}} lines and cyclomatic complexity over {{MAX_COMPLEXITY}} fail CI.
  Split oversized files by package responsibility before adding helpers; do not create `_v2` or `new` sidecars.
  Circular package imports fail compilation; layer-crossing imports are additionally blocked by `depguard`.
- **Error handling**: errors are values. Wrap with `fmt.Errorf("...: %w", err)`. Sentinel errors are package-level `var`s exported only if part of the contract. No `panic` in library code.
- **Tests**: `*_test.go` next to source. Table-driven tests preferred. `t.Parallel()` on every leaf test. Integration tests gated by `//go:build integration` build tag.
- **Goroutines and channels**: every goroutine has a documented owner and lifecycle. Channels close from the producer side only. Cancel via `context.Context`, never via a bool flag.
- **Dependency injection**: explicit constructor functions (`NewFoo(deps...) *Foo`). No global state. Wire (uber/fx) only if the user opts in.
- **Forbidden**: `init()` outside `cmd/` and test setup; `os.Exit` outside `cmd/`; package-level mutable state.

### Common pitfalls (lint-enforced)

- Shadowed variables → `golangci-lint` `govet shadow`.
- Unchecked errors → `errcheck`.
- Unwrapped errors that cross package boundaries → `wrapcheck`.
- `time.Now()` in business logic → use injected clock; enforced by custom lint or convention.
- File line count > {{MAX_FILE_LINES}} → repo file-size guard command (shell line-count check in the unified entry point / CI).
- Function line count > {{MAX_FUNCTION_LINES}} → `golangci-lint` `funlen` (lines: {{MAX_FUNCTION_LINES}}).
- Cyclomatic complexity > {{MAX_COMPLEXITY}} → `golangci-lint` `gocyclo` (min-complexity: {{MAX_COMPLEXITY}}).
- Circular imports → Go compiler enforces at package level; additionally `golangci-lint` `depguard` prevents cross-layer imports.
```

---

## Python

```markdown
### Python-specific rules

- **Toolchain**: Python {{PY_VERSION}}. `pyproject.toml` is the single source of truth (no `setup.py`, no separate `requirements.txt` unless for deploy artifacts).
- **Package manager**: {{PY_PKG_MGR}} (Poetry, uv, or pip-tools). Lockfile (`poetry.lock` / `uv.lock`) committed.
- **Linter + formatter**: `ruff` (configured in `pyproject.toml` `[tool.ruff]`). Replaces flake8, isort, pyupgrade. Format with `ruff format` (replaces Black).
- **Type checker**: `mypy --strict` ({{MYPY_CONFIG}}). Every public function is typed. `Any` is a code smell — flag in review.
- **Anti-drift tools**: duplicate code via `pylint --disable=all --enable=duplicate-code` (stack-specific heuristic, not a direct profile percent gate), dead code via `vulture`, conventional commits via `commitizen`. Do not add Node-only `jscpd` or `commitlint` to Python-only repos unless the user explicitly accepts Node as repo tooling.
- **Size discipline**: source files over {{MAX_FILE_LINES}} lines and cyclomatic complexity over {{MAX_COMPLEXITY}} fail CI.
  Split oversized modules by application boundary, domain service, or adapter; do not park overflow in `helpers.py`.
  Circular and cross-layer imports are blocked by `import-linter` contracts.
- **Tests**: `pytest`. Test files `test_*.py` co-located with source or in `tests/`. Parametrize over fixtures. `pytest-xdist` for parallel execution. `pytest --cov-fail-under={{COVERAGE}}` in CI.
- **Async**: prefer `async` consistently within an app (no mixing `asyncio` with sync `requests`); use `httpx` instead of `requests` for async-friendly code.
- **Imports**: absolute imports only. `from app.module import X`, never `from .module import X` at package roots.
- **Dataclasses / Pydantic**: use `pydantic.BaseModel` for boundaries (HTTP, DB, config); use `@dataclass(frozen=True, slots=True)` for internal value objects.
- **Forbidden**: `from X import *`; bare `except:`; mutable default arguments; `print()` in non-CLI code (use `logger`); `os.getenv` outside config module.

### Common pitfalls (lint-enforced)

- Mutable default arguments → `ruff B006`.
- Unbound or shadowed names → `ruff` + `mypy`.
- Untyped public API → `mypy --strict disallow-untyped-defs`.
- Bare `except` → `ruff E722`.
- File line count > {{MAX_FILE_LINES}} → `ruff` `PLR0913` + custom script or `pylint` `too-many-lines`.
- Cyclomatic complexity > {{MAX_COMPLEXITY}} → `ruff` `C901` (max-complexity: {{MAX_COMPLEXITY}}).
- Circular imports → `import-linter` contract (already configured).
- Cross-layer imports → `import-linter` layering contract.
```

---

## Rust

```markdown
### Rust-specific rules

- **Toolchain**: Rust {{RUST_VERSION}} (`rust-toolchain.toml` pins the channel). Edition {{EDITION}} (e.g., 2024).
- **Clippy**: `cargo clippy -- -D warnings -W clippy::pedantic -W clippy::nursery` in CI. Allow specific pedantic lints in `Cargo.toml`'s `[lints.clippy]` only with justifying comment.
- **Formatter**: `cargo fmt --check` in CI; commit only formatted code.
- **Anti-drift tools**: dead dependencies via `cargo-machete` and `cargo +nightly udeps`; no broadly accepted lightweight Rust duplicate-code detector exists. AGENTS.md must state whether duplicate-code review is manual or delegated to an existing platform such as SonarQube/CodeQL.
- **Size discipline**: source files over {{MAX_FILE_LINES}} lines and cognitive complexity over {{MAX_COMPLEXITY}} fail CI.
  Split oversized modules along crate/module boundaries and keep public APIs narrow.
  Circular module imports are prevented by the module system and audited with `cargo-modules` in CI.
- **Error handling**: `Result<T, E>` everywhere. Use `thiserror` for library errors, `anyhow` for binary error reporting at top-level only. Never `unwrap()` or `expect()` in production code paths — only in tests and `main` for setup failures.
- **Ownership and borrowing**: prefer borrowing (`&T`) over cloning. `clone()` in hot paths is a review red flag — justify or refactor.
- **Concurrency**: `tokio` for async runtime (if applicable). `Arc<Mutex<T>>` only when truly shared — prefer message passing via `mpsc`.
- **Modules**: visibility is `pub(crate)` by default, escalate only as needed. No `pub` items without doc comments (enforced by clippy `missing_docs_in_private_items` where applicable).
- **Tests**: unit tests in `#[cfg(test)] mod tests` block. Integration tests in `tests/` at crate root. `cargo-nextest` for faster runs; serial tests use nextest test-groups.
- **Unsafe**: every `unsafe` block has a comment explaining the invariant it upholds. CI flags new `unsafe` introductions.
- **Forbidden**: `unwrap`/`expect` in non-test non-main code, `println!`/`eprintln!` outside `main` (use `tracing`), unbounded channels in production, `lazy_static!` (use `OnceLock` / `LazyLock`).

### Common pitfalls (lint-enforced)

- `unwrap` in production → `clippy::unwrap_used`.
- Inefficient cloning → `clippy::clone_on_copy`, `clippy::redundant_clone`.
- Unused dependencies → `cargo-udeps`.
- Slow build times → `cargo-bloat` review on major dep changes.
- File line count > {{MAX_FILE_LINES}} → `rustfmt`-based check or `tokei` in CI; clippy `too_many_lines` on functions.
- Cyclomatic complexity > {{MAX_COMPLEXITY}} → `clippy::cognitive_complexity`.
- Circular module imports → Rust module system prevents at compile time; `cargo-modules` for CI audit.
```

---

## TypeScript + React / Next.js

```markdown
### TypeScript-specific rules

- **Toolchain**: TypeScript {{TS_VERSION}}, Node {{NODE_VERSION}} (specified in `package.json` `engines.node`).
- **Package manager**: {{PKG_MGR}} (pnpm recommended for monorepos, npm for single apps). Lockfile committed; `packageManager` field in `package.json` pinned.
- **`tsconfig.json`**: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`. No `// @ts-ignore` without a paired `// TODO(<ticket>):` comment. `// @ts-expect-error` only with explanation. **Stage 4 must write `tsconfig.json` from `aux-file-templates.md` § "TS toolchain configs"** — it is part of the mandatory write set for any TypeScript stack, not optional.
- **Linter**: ESLint with `@typescript-eslint`, `eslint-plugin-import`, `eslint-plugin-react` (if React), `eslint-plugin-import/no-cycle`, `eslint-plugin-import/no-restricted-paths`, custom `@typescript-eslint/naming-convention`. Strict mode: warnings are errors in CI. **Stage 4 must write a concrete ESLint config** from `aux-file-templates.md` § "Lint configs (per stack)" (`eslint.config.mjs` for ESLint 9+, `.eslintrc.json` fallback for ESLint 8). Naming-convention regex must cover both snake_case (`_v[0-9]+`) and PascalCase (`V[0-9]+`, `New`, `Old`, `Legacy`) forms — see `aux-file-templates.md` § "Lint configs (per stack)" `forbiddenVersionSuffix`.
- **Formatter**: Prettier with concrete `.prettierrc.json` from `aux-file-templates.md` § "TS toolchain configs" — mandatory write set. `lint-staged` runs Prettier + ESLint on changed files in pre-commit. Do not rely on Prettier defaults silently.
- **Anti-drift tools**: duplicate code via `jscpd`, dead exports/dependencies via `knip`, conventional commits via `commitlint`; configs live in `aux-file-templates.md` § "Anti-drift configs" and § "Commit linting".
- **Size discipline**: source files over {{MAX_FILE_LINES}} effective lines and cyclomatic complexity over {{MAX_COMPLEXITY}} fail ESLint.
  Split by feature, route, component responsibility, or server/client boundary before raising limits.
  Circular imports fail through `import/no-cycle`; cross-layer imports fail through `import/no-restricted-paths`.
- **Tests**: Vitest (preferred for new projects) or Jest. Use `*.test.ts`/`*.test.tsx` adjacent to source. Test coverage gate: {{COVERAGE}}%.
- **Imports**: no barrel files (`index.ts` re-exporting everything) — they break tree-shaking and confuse agents. Direct imports only. Enforced by `import/no-barrel` or custom rule.
- **Types over interfaces** for unions/intersections; **interfaces over types** for extensible object shapes. Be consistent within a module.
- **Forbidden**: `any` (use `unknown` and narrow); `as` casts without justification comment; `@ts-ignore`; default exports for components (named exports help refactoring tools).

{{IF_REACT_OR_NEXTJS}}
### React / Next.js additional rules

- **Components**: Function components only. Class components are a refactor target.
- **State**: `useState` for local; `useReducer` for complex local; React Query / SWR / TanStack Query for server state. Avoid global state libraries unless the data is truly global; lift state instead.
- **Effects**: every `useEffect` either has a dependency array justified by the body, or a comment explaining the empty array. `react-hooks/exhaustive-deps` is `error` in lint, not `warn`.
- **Memoization**: do not pre-emptively wrap in `useMemo`/`useCallback`. Measure first. The default ESLint rule against unnecessary memo helps.
- **Server vs client (Next.js)**: prefer Server Components by default. Client components only when interactivity is required. The `"use client"` directive is positioned at the top of files only, never per-export.
- **Data fetching (Next.js)**: server-side via Server Components or Route Handlers; client-side via React Query. No `fetch` in `useEffect` for anything non-trivial.
- **Forbidden**: `<a href="...">` for internal links (use `<Link>`); inline `style={{...}}` for non-dynamic styles; mixing CSS-in-JS systems.
{{END_IF}}

### Common pitfalls (lint-enforced)

- Implicit `any` → tsconfig `noImplicitAny`.
- Untyped `catch` clauses → eslint + tsconfig `useUnknownInCatchVariables`.
- Circular imports → `import/no-cycle`.
- Unused imports → `unused-imports/no-unused-imports`.
- `useEffect` missing deps → `react-hooks/exhaustive-deps`.
- File line count > {{MAX_FILE_LINES}} → `eslint` `max-lines` (max: {{MAX_FILE_LINES}}, skipBlankLines: true, skipComments: true).
- Cyclomatic complexity > {{MAX_COMPLEXITY}} → `eslint` `complexity` (max: {{MAX_COMPLEXITY}}).
- Circular imports → `eslint-plugin-import` `import/no-cycle` (maxDepth: 1).
```

---

## Java

```markdown
### Java-specific rules

- **Toolchain**: Java {{JAVA_VERSION}} (LTS). Build: {{MAVEN_OR_GRADLE}} ({{GRADLE_KTS_OR_GROOVY}}).
- **Linter / static analysis**: `Checkstyle` + `SpotBugs` + `PMD` configured at build level. `errorprone` integrated into the compiler.
- **Formatter**: `google-java-format` or `spotless`. Pre-commit hook runs formatter.
- **Anti-drift tools**: duplicate code via PMD CPD (stack-specific detector, not a direct profile percent gate), dead/unused dependencies via Maven `dependency:analyze` or Gradle dependency-analysis, static issues via PMD/SpotBugs. Conventional commits should use the git-native bash `commit-msg` hook unless the repo already has Java-native release tooling.
- **Size discipline**: source files over {{MAX_FILE_LINES}} lines and cyclomatic complexity over {{MAX_COMPLEXITY}} fail Checkstyle or PMD.
  Split oversized classes by domain responsibility, port/adapter boundary, or use case.
  Circular dependencies are blocked by PMD or ArchUnit tests in CI.
- **Type strictness**: `@NonNull` / `@Nullable` annotations + a nullability checker (`NullAway`, `Checker Framework`). Treat warnings as errors in CI.
- **Tests**: JUnit 5. Parallel execution enabled. `Testcontainers` for integration tests against real DBs.
- **Dependency management**: lock dependency versions in `dependencyManagement` block; renovate/dependabot for updates; license audit in CI (`mvn license:check` or equivalent).
- **Concurrency**: prefer `java.util.concurrent` primitives over raw threads. `CompletableFuture` for async; Project Loom virtual threads where available and reviewed.
- **Forbidden**: `System.out.println` outside `main` (use SLF4J); `e.printStackTrace()` (wrap and rethrow or log structured); catching `Exception` or `Throwable` (catch specific); raw types (always parameterize generics).

### Common pitfalls (lint-enforced)

- Resource leaks → `SpotBugs OS_OPEN_STREAM`, `try-with-resources` mandatory.
- Null dereference → `NullAway`.
- Equals/hashCode contracts → `errorprone EqualsHashCode`.
- Mutable static fields → `errorprone MutableConstantField`.
- File line count > {{MAX_FILE_LINES}} → `checkstyle` `FileLength` (max: {{MAX_FILE_LINES}}).
- Cyclomatic complexity > {{MAX_COMPLEXITY}} → `checkstyle` `CyclomaticComplexity` (max: {{MAX_COMPLEXITY}}) or `PMD` `CyclomaticComplexity`.
- Circular imports → `PMD` / `ArchUnit` test.
```

---

## Minimal template for other stacks

If the user's stack is not in the list above (Ruby, C#, PHP, Swift, Kotlin, Elixir, etc.), render the following minimal block with stack-appropriate substitutions:

```markdown
### {{STACK_NAME}}-specific rules

- **Toolchain**: {{STACK_NAME}} {{VERSION}}. Pinned in `{{PIN_FILE}}`.
- **Package manager**: {{PKG_MGR}}, lockfile (`{{LOCKFILE}}`) committed.
- **Linter**: `{{LINTER}}` ({{LINT_CONFIG}}). Treat warnings as errors in CI.
- **Formatter**: `{{FORMATTER}}`. Run in pre-commit.
- **Type strictness**: {{TYPE_STRICTNESS_NOTE}}.
- **Tests**: `{{TEST_RUNNER}}`. Convention: `{{TEST_NAMING}}`.
- **Forbidden**: {{COMMON_ANTI_PATTERNS}}.

If you do not know the canonical anti-patterns for this stack, ask the user once: "What are the top 3 things AI-generated {{STACK_NAME}} code commonly gets wrong in your experience?" Capture verbatim into the AGENTS.md.
```

---

## Cross-stack reinforcement

The following clauses apply to every stack and should appear in the AGENTS.md Stack section regardless of language:

```markdown
### Universal stack rules

- Lockfile is the single source of truth for resolved versions. Do not bypass it.
- New dependencies require a justification line in the PR description: what it does and why an existing tool can't do it.
- Major-version upgrades (semver major) require human review even if dependency-update automation is configured.
- A package introduced but unused in the same PR is a CI failure (unused-dependencies detection).
- License audit: dependencies must use one of {{ALLOWED_LICENSES}} (default: MIT, Apache-2.0, BSD-3-Clause, ISC). New license types require human approval.
- **Tunables dichotomy.** A deployment-varying tunable (limit, endpoint, batch size, feature toggle) is a validated config field changeable per deployment — a `DEFAULT_*` constant is not configurability. Protocol constants, external-spec values, and security invariants are the opposite: fixed in code, never config. Defaults resolve at one explicit owning point, not scattered `?? default` fallbacks at call sites.
- **Misconfiguration fails loud.** Invalid or missing config never degrades silently. Self-contained config aborts **at load**; late-bound references (a file/target/key only resolvable later) fail **at the earliest resolvable point** — never later, never quietly: an env toggle set to an unexpected value throws instead of acting as a silent no-op; a CLI given an unknown mode/flag exits non-zero; a reference to a missing file/target/key is an error, never a silent skip. Silent fallback on bad config is how a disabled safety net reads as green.
```
