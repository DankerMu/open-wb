# Engineering Pillars

Six pillars distilled from real high-velocity engineering practices (notably the OpenAI Codex repository's infrastructure). Each pillar shifts a recurring problem from "human discipline" to "mechanized enforcement". Inclusion of each pillar is a Stage 2 question (Dimension 5); selected pillars influence Stage 4 auxiliary-file generation.

> "Teams don't move fast by skipping steps. They move fast because every step that can be automated, codified, or gated has been."

## Pillar overview

| # | Pillar | Produces | Why |
|---|--------|----------|-----|
| 1 | Repo Memory & Rules | `AGENTS.md` + `CONTEXT.md` | Turns recurring review debates and terminology drift into defaults |
| 2 | Dev Entry Point | `justfile` / `Makefile` | "Run standard checks" means the same thing for everyone |
| 3 | Custom Lints | Lint config + custom scripts | If a review comment appears 3+ times, automate it |
| 4 | Contract Testing | Schema fixtures + snapshots | Protocol/UI changes leave reviewable, testable evidence |
| 5 | Risk-Layered CI | `.github/workflows/*.yml` | Small changes don't pay full-repo verification cost |
| 6 | Release Pipeline | Release workflow + version validation | Risk distributed across many small releases, not big-bang |

Pillar 1 is always included — that is the point of this skill. Pillars 2–6 default by the strictness profile chosen at Q1.4 (see the table at the bottom of this file); Stage 2 answers can override, with downgrades confirmed explicitly.

---

## Pillar 1 — Repo Memory & Rules

**Output**: The `AGENTS.md` this skill is generating, plus `CONTEXT.md` for domain language. Optional module-level `AGENTS.md` files are used for monorepos / DDD bounded contexts.

**Why**: Without authoritative project memory, every agent invents its own conventions and terminology, every PR review re-debates the same questions, and new contributors (human or AI) bootstrap from whatever code they grep first.

**Quality bar (0–5)**:
- 0 — no AGENTS.md.
- 1 — AGENTS.md exists but vague ("write clean code").
- 2 — covers basics (commands, conventions) but no enforcement pointers.
- 3 — project-specific rules with enforcement pointers, but rules outpace the actual machine checks.
- 4 — every rule has an enforcement mechanism, all wired and passing in CI.
- 5 — rules evolve via documented process; module-level rules where useful; agents update AGENTS.md as part of feature work when conventions shift.

**Hierarchical layering**: for monorepos, the root AGENTS.md states universal rules; each app or bounded context has a module-level AGENTS.md (same filename) that extends or overrides. Module AGENTS.md files inherit from the root unless they explicitly override.

---

## Pillar 2 — Dev Entry Point

**Output**: `justfile` (preferred) or `Makefile`. A single file that defines `setup`, `dev`, `test`, `check`, `lint`, `fmt`, `build`, `release`.

**Why**: Without a unified entry point, agents learn workflows by reading scattered scripts; if `npm run dev` works on Tuesday but the team has since renamed it to `npm run start`, the agent fails or — worse — invents an ad-hoc workflow.

**Recommended layout** (justfile):

```just
# Top-level convenience commands. Every workflow goes here.

default: check

setup:
    {{INSTALL_CMD}}

dev:
    {{DEV_CMD}}

check: fmt lint typecheck test

fmt:
    {{FMT_CMD}}

lint:
    {{LINT_CMD}}

typecheck:
    {{TYPECHECK_CMD}}

test: test-unit test-integration

test-unit:
    {{UNIT_TEST_CMD}}

test-integration:
    {{INTEGRATION_TEST_CMD}}

build:
    {{BUILD_CMD}}

clean:
    {{CLEAN_CMD}}
```

**When to skip**: never. Even prototypes benefit; the cost is one file.

**Quality bar**: covers fmt + lint + test + build + setup. `just check` runs the same pipeline CI runs.

---

## Pillar 3 — Custom Lints

**Output**: Stack-default lint config plus project-specific custom lints. **Always includes anti-drift trio**: duplicate-code detection, dead-code detection, naming-pattern guard.

**Why**: Default lints catch syntax errors. Anti-drift lints catch the failure mode this skill exists to prevent — parallel implementations, dead code accumulation, version-suffix naming.

**Anti-drift trio (mandatory unless user explicitly opts out in Q5.2)**:

1. **Duplicate-code detection**: stack-specific tool from `aux-file-templates.md` § "Anti-drift configs" (`jscpd` for JS/TS, `dupl` for Go, Pylint duplicate-code for Python, PMD CPD for Java; Rust has no strong lightweight default and must document that trade-off). Runs in pre-commit + CI when fast enough.
2. **Dead-code detection**: stack-specific tool from `aux-file-templates.md` § "Anti-drift configs" (`knip`, `vulture`, `golangci-lint unused`, `cargo-machete`/`cargo-udeps`, Maven/Gradle dependency analysis). Runs in CI; pre-commit too if fast enough.
3. **Naming-pattern guard**: the bash script in `aux-file-templates.md` § "Naming guard". Pre-commit hook. Rejects forbidden suffixes (`_v1`, `_v2`, `_new`, etc.) and scratchpad directories.

**Custom lints rule of three**: if a review comment shows up three times, write a lint rule for it. Don't anticipate hypothetical problems; pave the cowpaths that already exist.

**When to skip**: only the optional ones (project-specific custom rules). The anti-drift trio is essentially mandatory for any repo touched by AI coding agents.

---

## Pillar 4 — Contract Testing

**Output**: Schema files (OpenAPI / GraphQL schema / Protobuf) + snapshot tests that fail on unintended changes.

**Why**: When the public interface drifts silently, downstream consumers break. Snapshot tests turn schema changes into visible diffs in PRs — agents and humans both see the change.

**Pattern**:

```
schemas/
├── openapi.yaml           # generated or hand-authored
└── snapshots/             # committed snapshots
    └── openapi.yaml.snapshot

tests/contract/
└── test_openapi_snapshot.<ext>   # regenerates and diffs
```

**When to skip**: CLI tool with no external interface; pure backend library with no API surface; very early prototype where the contract is in flux daily.

**Deterministic test setup** (critical for contract testing):
- Frozen time: inject a clock; CI sets `TEST_NOW=2026-01-01T00:00:00Z`.
- Deterministic IDs: seed any UUID/random generator.
- Canonicalized output: redact dynamic content (timestamps, version strings, file paths) before snapshotting.

**Reviewability is a harness requirement** (review attention is the scarce resource):
- Minimal churn by design: pin a shared header/schema exactly once and tokenize it everywhere else, so one logical change produces one reviewable diff line instead of churning the whole snapshot corpus.
- Update commands minimize diffs: reuse unchanged leaves, keep the new value on ambiguity — an update whose diff cannot be reviewed is a gate nobody reads.
- Fixture guards: the harness validates its own inputs — reject orphan fixture directories, missing files, duplicate pins, and unscrubbed dynamic content instead of trusting the fixture tree.
- The redaction/canonicalization layer is a fixed set of pure rules; growing it to absorb a real behavior difference hides the bug (see the refactor anti-cheat rules).

### Pillar 4a — Non-API contracts (frontend, library, CLI)

For projects without HTTP API surfaces, contracts protect the public interface border:

| Project type | Contract mechanism | How to test |
|-------------|-------------------|-------------|
| Frontend app | Shared component prop types committed to `types/` | TypeScript `tsc --noEmit` verifies type compatibility; snapshot test on exported component signatures |
| Library / SDK | Public API surface (exports) | Per-stack tool (see below); CI gate on unintended signature changes |
| CLI tool | CLI argument schema + `--help` output | Snapshot test on `--help` output; schema validation on argument definitions |

**Per-stack public-API tools:**

| Stack | Tool | Command |
|-------|------|---------|
| TypeScript | `@microsoft/api-extractor` or `tsc --declaration --emitDeclarationOnly` | `api-extractor run` |
| Python | `mypy` stubtest or `interrogate` (docstring coverage) or `pytest` parametrized on `__all__` | `stubtest <pkg>` |
| Go | `go doc` output snapshot or `gorelease` for breaking-change detection | `gorelease` |
| Rust | `cargo-semver-checks` or `cargo-public-api` | `cargo semver-checks` |
| Java | `japicmp` (binary compatibility) or `revapi` Maven plugin | `mvn revapi:check` |

**What Pillar 4a produces:**

- A committed file (`types/public-api.md` or `api/<pkg>.api.md`) listing the public surface
- A CI step that regenerates and diffs — any unintended change fails CI
- For libraries: semver-aware (breaking changes block merge to patch/minor branches)

### When to use Pillar 4 vs 4a

- Pillar 4: the project exposes an HTTP/REST/gRPC/GraphQL interface. Use OpenAPI/Protobuf/GQL schema snapshots.
- Pillar 4a: the project is a library, CLI, or frontend app consumed by other code (not over the network). Use public-API surface snapshots.
- Both: a full-stack project with both an API and a shared library. Use both.

---

## Pillar 5 — Risk-Layered CI

**Output**: `.github/workflows/ci.yml` (and optional sibling workflows) with stages that fail fast on cheap checks and gate expensive checks on path-relevant changes.

**Why**: Running the full suite on every PR is slow and disincentivizes small commits. Splitting CI into layers means cheap checks fail in 30 seconds, expensive checks run only when relevant paths changed.

**Recommended structure**:

```
Layer 1 (always, ~30s): fmt + lint + typecheck. Fast feedback.
Layer 2 (always, ~2min): unit tests.
Layer 3 (path-filtered, ~5min): integration tests, contract tests.
Layer 4 (main-only, ~10min): e2e, release artifact build.
```

**Fork-friendly**: gate secrets-dependent steps behind `if: github.repository == 'org/repo'`. Forks should be able to run the full local pipeline without privileged credentials.

**Monorepo scale**: when CI outgrows a handful of jobs, keep the gate inventory in one tested runner script and let YAML only provision runners (`references/agent-harness-templates.md` § Gate runner in code).

**Test groups for parallelism**:
- Use `cargo-nextest` test-groups (Rust), `pytest-xdist` (Python), Jest/Vitest parallel (TS), `go test -parallel` (Go) to maximize parallelism.
- Tests that must run serially (DB schema generation, shared file state) declared explicitly.

**When to skip**: prototype with no CI is acceptable if lifecycle is "weeks". For everything else, even "minimal CI" beats no CI.

---

## Pillar 6 — Release Pipeline

**Output**: Release workflow (tag-triggered or `release-please`/`changesets`), version validation, multi-platform builds where relevant, signing/notarization for distributed binaries.

**Why**: Manual releases concentrate risk into rare big-bang events. Automated, small, frequent releases distribute risk and surface integration issues early.

**Patterns**:

- **Libraries / SDKs**: `semantic-release` or `changesets` driven by conventional commits.
- **Services**: tag-based with `release-please` for changelog, plus CI-triggered deploys on tag.
- **Distributed binaries** (CLI tools): multi-platform matrix build, code-sign + notarize on macOS, attach assets to GitHub release.
- **Release preflight**: before publishing, the pipeline asserts the tag equals the manifest version, the artifact inventory matches expectations exactly (names and count), and the runtime dependency closure resolves. "What you verified is what you ship" is an assertion, not an assumption.

**Alpha rhythm** (for complex products): use `release/v1.2.5-prep` branches to gather fixes, test updates, and lockfile syncs before tagging. Keeps `main` stable while hardening happens in parallel.

**Dual-track versioning** (advanced): main product versions stabilize quickly; vendored/internal components cycle through many alpha iterations. Each track optimized for its stability requirements.

**When to skip**: prototypes, internal-only tools with no consumers.

---

## Cross-cutting practices

These weave through every pillar and should be recommended whenever relevant.

### Conventional commits

Format: `type(scope): subject`. Types: `feat`, `fix`, `chore`, `docs`, `ci`, `test`, `refactor`, `build`, `perf`. Scopes match module/crate/package names.

Conventional commits enable automated changelog generation (Pillar 6) and give `git log` semantic structure that both humans and agents can read back. They also make the difference between "refactor: replace v1 with v2" and "feat: add v2" explicit — distinguishing a one-time replacement from a parallel addition.

Enforced by the stack-appropriate commit checker in `aux-file-templates.md` § "Commit linting" (`commitlint` for JS/TS, `commitizen` for Python, or the git-native bash hook for Go/Rust/Java).

### Hierarchical AGENTS.md

For monorepos and DDD codebases:
- Root `AGENTS.md` — universal project memory/rules (code canonicality, stack, conventions, validation, agent operating rules).
- Root `CONTEXT.md` — project identity, domain language, bounded contexts, invariants, and terminology questions.
- Module-level `AGENTS.md` (same filename, never `CLAUDE.md`) — module-specific concerns. State-machine modules require documentation of state transitions. UI modules carry style guides. API modules carry protocol conventions.

A module's AGENTS.md inherits the root by default; only call out overrides.

### Legacy cleanup rhythm

When phasing out an old pattern: adopt → deprecate (with deadline) → remove. Track deprecation deadlines in AGENTS.md with a table:

| Item | Adopted | Deprecation announced | Removal deadline |
|------|---------|----------------------|------------------|
| Old auth middleware | 2025-01 | 2025-09 | 2025-12 |

Typical window from "first fix" to "complete removal" is 2–3 weeks for in-team patterns, 2–3 months for public APIs.

### Surgical removal over gradual decay

The Codex pattern is `fix → fix again → remove completely`, not `fix → fix again → comment out → forget`. Never leave deprecated code rotting; pre-commit hook should reject commented-out code blocks.

### Mandatory presence or mandatory justified absence

Design every "every X must have Y" guardrail to accept exactly two states: a real Y, or an explicit, signed reason for its absence (an allowlist entry with a reason, a marked `None — <reason>` cell). Reject the third state — silent absence — and the fourth — boilerplate Y produced to silence the guard. This shape kills both rot directions at once: perfunctory shells and silent skips. eng-init already applies it (PR runtime evidence allows "None — review-only change" only with a stated reason; Skippable criteria require an explicit non-applicability note); apply the same shape to any new guardrail rather than inventing a check nobody needs or letting the empty case pass unexplained.

### Coordinated release prep

Use release branches (`release/v1.2.5-prep`) to gather fixes, test-coverage updates, and lockfile syncs before tagging. Keeps `main` clean while release hardening happens in parallel.

---

## How to use this file during Stage 2

When grilling Dimension 5 (Engineering Pillars), present pillars 2–6 in turn with defaults derived from the **strictness profile chosen at Q1.4** (lifecycle only sets the recommended profile; the profile sets the pillar defaults):

| Profile | P1 | P2 | P3 | P4 | P5 | P6 |
|---------|-----|-----|-----|-----|-----|-----|
| L1 prototype | required | recommended | required (trio, warn-level) | skip | minimal | skip |
| L2 standard | required | required | required (block) | optional | risk-layered | manual tags |
| L3 strict | required | required | required (block) | required | risk-layered + diff guard | automated |
| L4 maximal | required | required | required (block) | required + semver gate | risk-layered + diff guard | semantic-release / changesets |

The user can override any default, but overrides below the profile column are downgrades: confirm explicitly and record in the strictness ledger. Capture the final selection into the decision ledger.
