# HARNESS.md

# Agent Harness Lessons for eng-init

This note distills public AI/agent-operated open-source project patterns into reusable constraints for `eng-init`. It is a local research artifact for improving this skill's generated repo harnesses.

## Sources reviewed

- GitButler Grit / True Grit
  - Blog: https://blog.gitbutler.com/true-grit
  - Contract: https://github.com/gitbutlerapp/grit/blob/main/AGENTS.md
- Bun
  - Rust migration PR: https://github.com/oven-sh/bun/pull/30412
  - Contract: https://github.com/oven-sh/bun/blob/main/CLAUDE.md
  - Agent commands: https://github.com/oven-sh/bun/tree/main/.claude/commands
- VoidZero / Oxc Angular Compiler
  - Blog: https://voidzero.dev/posts/oxc-angular-compiler
- React Compiler Rust port
  - PR: https://github.com/facebook/react/pull/36173
- Anthropic Claude's C Compiler
  - Blog: https://www.anthropic.com/engineering/building-c-compiler
  - Repo: https://github.com/anthropics/claudes-c-compiler
- OpenAI Codex
  - Contract: https://github.com/openai/codex/blob/main/AGENTS.md
- OpenAI Agents Python
  - Contract: https://github.com/openai/openai-agents-python/blob/main/AGENTS.md

## Related skills found on skills.sh / GitHub

I also searched Skills Directory and GitHub code search for similar repository-harness skills. Closest matches:

| Skill | Source | Scope | Useful lesson | Gap vs `eng-init` |
|---|---|---|---|---|
| `create-agentsmd` | https://skills.sh/github/awesome-copilot/create-agentsmd / https://github.com/github/awesome-copilot | General AGENTS.md generation | Clear public-format explanation; insists on exact setup/test/build commands and command verification | Template-only; no strictness profile, no mechanical guardrails, no runtime harness, no baseline/ratchet |
| `wiki-agents-md` | https://skills.sh/microsoft/agent-skills/wiki-agents-md | AGENTS.md generation | Strong guard: never overwrite existing AGENTS.md; supports nested AGENTS.md precedence | Conservative generator; not a repo-hardening workflow |
| `agents-md` | https://skills.sh/getsentry/skills/agents-md / https://github.com/getsentry/skills | Concise AGENTS.md maintenance | Excellent progressive-disclosure discipline: target <60 lines, never >100; reference docs instead of copying; verify paths/commands | Intentionally lightweight; no guardrail creation or readiness scoring |
| `agents-md-generator` | https://skills.sh/buyoung/skills/agents-md-generator | AGENTS.md generator/updater | Preserves custom sections while refreshing standard sections; monorepo hierarchy support | Mostly documentation generation; little enforcement |
| `agent-md-refactor` | https://skills.sh/softaworks/agent-toolkit/agent-md-refactor | Refactor bloated agent instruction files | Progressive disclosure for long AGENTS/CLAUDE/COPILOT files | Refactoring existing docs, not bootstrapping guardrails |
| `agent-governance` | https://skills.sh/github/awesome-copilot/agent-governance | Agent system policy and audit patterns | Declarative allow/deny policies, tool-level governance, audit trails, trust scoring | Applies to agent applications, but patterns can inform repo-local agent permissions |
| `codex-readiness-unit-test` | https://skills.sh/openai/skills/codex-readiness-unit-test | Readiness evaluation for AGENTS/PLANS docs | Deterministic evidence collection, JSON scoring, timestamped local reports, optional execute mode | Focused on evaluation rather than scaffold generation |
| `workflow-patterns` | https://skills.sh/wshobson/agents/workflow-patterns | TDD / plan / checkpoint workflow | Phase checkpoints and verification protocol | Workflow guidance, not project harness generation |
| `agentic-workflow-guide` | https://skills.sh/aktsmm/agent-skills/agentic-workflow-guide | Choosing prompt/instruction/skill/agent/hook primitive | “Primitive first”: use hooks for deterministic enforcement, agents only when needed | Meta-guidance, not repo artifact generation |

Net: there are many AGENTS.md generators and agent-governance skills, but I did not find a public skill that combines `eng-init`'s full scope: project memory + CONTEXT.md + strictness profiles + command entry point + mechanical guardrails + runtime verification + readiness scoring + baseline/ratchet. The closest external improvement pressure is **brevity/progressive disclosure** from Sentry and Softaworks, plus **deterministic scoring artifacts** from OpenAI's readiness unit test.

## Core finding

Successful AI-operated repositories do not rely on a clever prompt. They build a harness around agents:

```text
Agent Harness
├─ durable project contract: AGENTS.md / CLAUDE.md / commands / task files
├─ source-of-truth references: upstream implementation, docs, tests, specs
├─ narrow work loop: claim task → reproduce → inspect reference → edit → verify → record
├─ anti-cheat rules: no test weakening, no fallback, no shelling out to old implementation
├─ mechanical verification: runnable tests, compare harnesses, smoke/E2E, IR/state diffs
├─ coordination protocol: tickets, locks, stage-only-own-files, logs, status updates
├─ evidence protocol: fresh outputs, pass counts, screenshots/logs when runtime-visible
└─ human gates: public API, schemas, security, migrations, irreversible operations
```

For large refactors, the most important constraint is not "run tests"; it is **bind every agent action to a reference oracle and a small, claimed work unit**.

## Patterns to absorb

### 1. One Rule

Grit's best idea is a single mission sentence:

> Fix the implementation to make upstream tests pass. Do not modify tests.

Generated AGENTS.md should include an equivalent project-specific top rule for large refactors:

- Porting: "Match the reference implementation's observable behavior; do not weaken compare tests."
- Rewrite: "Replace the old implementation cleanly; do not run both paths in production."
- Compatibility: "Preserve the public contract unless the migration spec explicitly changes it."

### 2. Source of Truth table

Agents drift when the reference is implicit. Large-refactor harnesses should render a table like:

| Surface | Canonical source | How to compare |
|---|---|---|
| Behavior | `legacy/` or upstream repo | golden output / conformance suite |
| API contract | OpenAPI / GraphQL / public types | contract tests |
| CLI behavior | old binary / manpage | snapshot + exit-code tests |
| Compiler/runtime internals | old pass output / IR dump | pass-by-pass diff |
| Domain terms | `CONTEXT.md` | naming review + forbidden aliases |

This table belongs in AGENTS.md for ordinary repos and in a separate migration spec for major refactors.

### 3. Anti-cheat rules must be concrete

Weak: "Do not cheat."

Useful:

- Do not edit tests except to add a regression that fails on the old/broken behavior.
- Do not skip, mark todo, quarantine, or loosen assertions to get green.
- Do not shell out to the old implementation, Git/GCC/system Bun/etc. unless the spec explicitly says it is the reference oracle for comparison only.
- Do not add compatibility shims, parallel `_new` paths, or silent fallback to old code.
- Do not claim a test is meaningful unless it fails against the old implementation or a known-bad baseline.
- Do not accept final-output-only parity for compilers/transformers when an intermediate-state oracle exists.
- Do not use generated docs or comments as proof; only executable checks count.

### 4. Work unit ownership

Parallel agents need ownership, not just a TODO list. Patterns:

- Grit: claim a TicGit ticket before work.
- Anthropic C compiler: write `current_tasks/<task>.txt` lock files.
- Bun commands: HTML markers make issue comments idempotent.

Reusable work-unit schema:

```markdown
# <task-id>

Goal: <one observable behavior to make true>
Reference: <file/doc/test/upstream source>
Reproduce: <command that currently fails>
Allowed files: <paths or subsystem>
Forbidden moves: <test weakening/fallback/etc>
Done when: <command + expected evidence>
Owner: <agent/person>
Started: <date>
Notes: <failed attempts / root-cause links>
```

Generated harnesses should offer this at L3+ when the user selects a large refactor or public OSS team mode.

### 5. Discover / Fixer split

Oxc Angular's useful pattern:

- Discover agent: compares reference implementation, identifies root cause, returns exact files and evidence.
- Fixer agent: edits only with that context, adds regression, runs the agreed verifier.
- Reviewer agent/model: compares fix against reference and flags untested divergence.

This avoids one agent both inventing the diagnosis and bending the fix to its guess.

### 6. Two-phase large-refactor strategy

Large rewrites fail when agents chase full green too early.

Phase A — structure:

- establish architecture boundaries;
- build compare harness;
- identify source-of-truth artifacts;
- port vertical skeletons;
- allow known failing cases to be tracked, not hidden.

Phase B — convergence:

- one failure/ticket per work unit;
- pass-count dashboard or status TOML;
- regression test before fix;
- reference compare after fix;
- reviewer pass for untested divergence.

`eng-init` should not generate only steady-state rules; it should generate a refactor-mode contract when the repo is mid-port/migration.

### 7. Intermediate-state verification

React Compiler's Rust port shows the key large-compiler lesson: final output parity is insufficient.

Prefer strongest available oracle:

1. public behavior / final output;
2. errors and diagnostics;
3. intermediate representation after each pass;
4. control-flow decisions;
5. generated artifacts and metadata;
6. real project conformance.

For compilers, transformers, query engines, sync engines, importers, and migrations, AGENTS.md should require intermediate-state or contract-level checks when feasible.

### 8. Test output designed for agents

Anthropic C compiler harness lesson:

- Print compact summaries, not thousands of lines.
- Write detailed logs to predictable paths.
- Put `ERROR` and the reason on the same line for machine search.
- Precompute pass counts and aggregate stats.
- Provide deterministic fast samples for iteration and full suites for sealing.
- Avoid time-blind long commands as the default inner loop.

This maps directly to `just check-fast`, `just check`, and status files.

### 9. Runtime evidence is first-class

Bun, Grit, and eng-init already agree: compile/typecheck is not enough.

Generated Verification Matrix should prefer commands that hit real surfaces:

- API: hurl/curl smoke against a running dev server.
- UI: Playwright or agent-browser route walk with console-error checks.
- CLI: known input/output with exit code.
- DB: migration up/down/seed.
- Background jobs: trigger and observe resulting state.

Every row must resolve to a real target; no phantom verification.

### 10. Open-source operations agents need idempotence

Bun `.claude/commands` show good issue/PR automation rules:

- allowed-tools whitelist;
- repo-scoped search;
- check existing bot marker first;
- do nothing on no evidence;
- fixed comment format;
- HTML marker for idempotence;
- parallel search strategies followed by a false-positive filter.

`eng-init` can add optional OSS operations templates for duplicate issue detection, related issue lookup, and PR overlap triage.

## What this means for eng-init

### Current strengths

The current skill already covers several lessons:

- AGENTS.md as durable project memory.
- CONTEXT.md as domain-language anchor.
- Strictness profiles L1-L4.
- No phantom enforcement.
- Verification Matrix with real command targets.
- Runtime harness templates for dev server, smoke, UI, DB, guardrail self-test.
- Baseline/ratchet for legacy violations.
- Conditional `.claude/settings.json` instead of default `CLAUDE.md`.
- Regression evals that enforce profile gating, runtime evidence, and guardrail self-tests.

### Main gaps

1. **No explicit large-refactor mode.**
   Current modes are greenfield/bootstrap/incremental/audit/repair. A repo doing a rewrite, port, or large migration needs a distinct contract.

2. **Source-of-truth oracle is under-modeled.**
   CONTEXT.md captures terms, but AGENTS.md does not consistently name behavioral reference implementations, upstream tests, old binaries, old modules, or spec docs.

3. **Anti-cheat rules are generic.**
   Current anti-patterns block drift, phantom enforcement, and fake verification, but not refactor-specific cheating: fallback to old implementation, weakening compare tests, shelling out to reference tools, dual-path shims, or final-output-only parity.

4. **Parallel coordination is not first-class.**
   The skill mentions agent operating rules but does not generate task-claim files/tickets/status dashboards for multi-agent large refactors.

5. **Discover/fixer/reviewer roles are not rendered.**
   Current templates guide a single agent. Multi-agent separation of diagnosis, fix, and reference review should be available at L3+ / public OSS / large-refactor mode.

6. **Intermediate-state compare harnesses are not prompted.**
   Runtime smoke is strong, but compilers/transformers/migrations/sync engines need IR/state/control-flow diff guidance.

7. **OSS operations automation is out of template scope.**
   Issue dedupe/PR overlap/comment idempotence patterns from Bun are useful for public OSS readiness.

### Additional lessons from similar skills

- **Brevity budget should be explicit.** Sentry's `agents-md` is stricter than `eng-init` on size: target <60 lines, never >100. `eng-init` currently allows ~250 lines. Keep the 250-line ceiling for L3/L4 harnesses, but add a generated `## External References` table and move cold details into referenced files where possible.
- **Preserve user-owned sections.** `agents-md-generator` explicitly preserves custom sections while refreshing standard ones. `eng-init` incremental/repair mode should mark generated sections or maintain a section registry so it can update its own blocks without trampling hand-written project rules.
- **Never-overwrite default matters.** Microsoft's `wiki-agents-md` has a hard guard against overwriting existing AGENTS.md. `eng-init` currently backs up then repairs; keep that, but make the preview distinguish generated changes from preserved user text.
- **Readiness output should be machine-readable.** OpenAI's `codex-readiness-unit-test` writes timestamped evidence and JSON scoring. `eng-init` audit-only currently writes Markdown; add optional `docs/agent-readiness-report.json` or `.agent-readiness/latest.json` so future agents can consume the score deterministically.
- **Governance policies can be concrete files.** `agent-governance` uses declarative allow/deny policies plus audit logs. For repos using Claude Code/Codex/Cursor, `eng-init` can map agent permissions into `.claude/settings.json`, CODEOWNERS, PR template checkboxes, and eventually `agent-policy.yaml`.

## Proposed optimization plan

### P0 — Add `large-refactor` / `migration` path

Add a mode or submode in `SKILL.md`:

- Trigger when the user says rewrite, port, migrate, replace framework, Rust/Zig/Go migration, compiler port, major refactor, modularization, clean cutover.
- Stage 2 must ask for:
  - reference implementation/source of truth;
  - public contract surfaces;
  - allowed compatibility policy;
  - anti-cheat forbidden moves;
  - compare harness type;
  - work-unit ownership mechanism;
  - human gates.
- Stage 3 must render a Refactor Contract section.

### P0 — Add AGENTS.md `Source of Truth & Refactor Contract` section

Template section:

```markdown
## Source of Truth & Refactor Contract

| Surface | Canonical source | Verification |
|---|---|---|
| <surface> | `<path/doc/upstream>` | `just <target>` |

Rules:
- Preserve behavior from the canonical source unless this contract says otherwise.
- Do not edit or weaken compare tests to pass.
- Do not shell out to the legacy implementation except in oracle/compare commands.
- Do not keep old and new implementations live as parallel production paths.
- Every changed behavior needs a regression or compare case.
```

### P0 — Extend question bank

Add a new Dimension or sub-dimension:

- Q9.1 Large refactor detected: yes/no/confirm.
- Q9.2 Reference oracle: legacy code, upstream repo, spec, old binary, golden fixtures, none.
- Q9.3 Cutover policy: clean cutover, compatibility bridge, staged dual-run, human-approved exception.
- Q9.4 Compare depth: final output, API contract, intermediate state, real-project conformance.
- Q9.5 Work ownership: issue tickets, task files, GitHub labels, external tracker.
- Q9.6 Forbidden moves: pick from concrete anti-cheat checklist.
- Q9.7 Human gates: public API/schema/security/migrations/irreversible data paths.

### P1 — Add work-unit templates

In `references/agent-harness-templates.md`, add:

- `agent_tasks/README.md` template.
- `agent_tasks/task-template.md`.
- optional `agent_status.yaml` / `refactor-status.toml`.
- just targets:
  - `just tasks-list`
  - `just tasks-claim TASK=<id>` if practical;
  - or documentation-only if no CLI is available.

Do not overbuild task tooling by default; render only when large-refactor mode or public OSS + multi-agent tools are selected.

### P1 — Add discover/fixer/reviewer protocol

AGENTS.md section:

```markdown
### Large-refactor agent roles

- Discover: reproduce failure, compare against source of truth, write root-cause note. No edits except notes/tests when requested.
- Fixer: edit implementation only after a discover note or a failing test identifies scope.
- Reviewer: compare implementation against source of truth and reject untested divergence.
```

This should be gated by profile L3+ or explicit multi-agent mode.

### P1 — Add intermediate oracle guidance

Add to Verification Matrix generation:

- If compiler/transformer/parser/codegen detected: ask whether IR/pass dumps exist or should be added.
- If data migration/sync/importer detected: ask for before/after state snapshots.
- If CLI replacement detected: ask for exit-code/stdout/stderr golden fixtures.
- If public API: ask for schema contract tests.

### P2 — Add OSS operations templates

Optional templates for `.claude/commands` or generic `agent-ops/`:

- duplicate issue detection;
- related issue lookup;
- PR overlap detection;
- release-note draft;
- stale task audit.

Constraints:

- read-only tools only by default;
- repo-scoped queries;
- idempotence marker;
- fixed comment format;
- no comment without evidence;
- false-positive filter step.

### P2 — Add eval cases

Add regression cases before changing SKILL.md behavior:

1. `case-13 — large-refactor-reference-contract`
   - Fixture: TS repo with `legacy/` and `src/` rewrite.
   - Assert: Q9 reference oracle asked, AGENTS.md contains Source of Truth table, no compatibility shim allowed by default.

2. `case-14 — compiler-port-intermediate-oracle`
   - Fixture: compiler/transformer repo with tests and IR snapshots.
   - Assert: Verification Matrix includes pass/intermediate compare target, not only final output.

3. `case-15 — multi-agent-task-ownership`
   - Fixture: public OSS repo, user selects large team + multi-agent.
   - Assert: task ownership protocol or task template written; AGENTS.md forbids unclaimed parallel work.

4. `case-16 — oss-ops-idempotent-command`
   - Fixture: GitHub OSS repo with issue templates.
   - Assert: optional ops command includes repo scope, marker check, no-comment-on-no-evidence rule.

## Recommended next edit order

1. Update `evals/cases.md` with failing cases for large-refactor contract and intermediate oracle.
2. Update `references/question-bank.md` with refactor questions.
3. Update `references/agents-md-sections.md` with Source of Truth & Refactor Contract and role protocol.
4. Update `references/agent-harness-templates.md` with task/work-unit templates.
5. Update `SKILL.md` Stage 1-3 to route large-refactor/migration work into those templates.
6. Run the relevant eval cases and adjust until old cases still pass.

## Current skill strengthening analysis

### Where to strengthen without bloating the core

The current `SKILL.md` has a clean six-stage flow and a strong invariant: no writes before Stage 4, profile before thresholds, no phantom enforcement. Keep that spine. The best extension point is **not** a broad rewrite of the skill; it is a refactor/migration overlay that activates only when Stage 0 or the user detects large rewrite work.

Recommended shape:

```text
Stage 0 scan
  └─ detect refactor signals
       ├─ legacy/new parallel dirs
       ├─ migration language pairs
       ├─ compiler/parser/transformer/sync/importer surfaces
       ├─ old AGENTS/CLAUDE drift
       └─ public API/schema/CLI compatibility surfaces

Stage 1 mode
  └─ existing modes + overlay: refactor_mode = none | port | rewrite | migration | compatibility-preserving refactor

Stage 2 grill
  └─ ask Q9 refactor questions only when overlay is active

Stage 3 spec
  └─ add Refactor Contract, source-of-truth table, anti-cheat list, work-unit plan

Stage 4 write
  └─ render extra sections/templates only when refactor overlay is active

Stage 5 validate
  └─ run normal validators + compare/oracle target + guardrail self-test
```

This avoids turning every normal `eng-init` run into a migration interview.

### File-by-file change plan

#### 1. `evals/cases.md` first

Add failing regression cases before touching behavior:

- `case-13 — large-refactor-reference-contract`
  - Forces `SKILL.md` to detect rewrite/port language and require source-of-truth answers.
  - Prevents vague "run tests" plans.
- `case-14 — compiler-port-intermediate-oracle`
  - Forces Verification Matrix to prefer IR/pass/state comparison when the domain has intermediate semantics.
- `case-15 — multi-agent-task-ownership`
  - Forces a task ownership protocol for public OSS / large team / multi-agent mode.
- `case-16 — audit-json-readiness`
  - Absorbs OpenAI readiness-unit-test lesson: audit-only output should include machine-readable JSON, not only Markdown.
- `case-17 — preserve-user-owned-agents-sections`
  - Absorbs external AGENTS.md skill lesson: incremental repair must not overwrite custom human sections.

Why first: these changes affect routing, templates, and size budgets. The evals stop a "good idea" from weakening existing L1-L4 behavior.

#### 2. `SKILL.md`

Minimal changes:

- Extend Stage 0 scan bullets with refactor signals:
  - legacy/reference directories (`legacy/`, `old/`, `reference/`, `fixtures/golden/`);
  - language-pair hints (`.zig` sibling to `.rs`, TS compiler with Rust port, v1/v2 dirs);
  - compare harnesses (`golden`, `snapshot`, `conformance`, `compat`, `ir`, `dump`);
  - public contract artifacts (`openapi`, `schema.graphql`, protobuf, CLI docs).
- Extend Stage 1 with **mode overlay**, not a sixth primary mode:
  - primary mode remains greenfield/bootstrap/incremental/audit-only/repair;
  - overlay records `large_refactor: true` and `refactor_kind`.
- Extend Stage 2 mapping:
  - Q9 answers map to AGENTS.md Source of Truth section, Verification Matrix compare rows, work-unit templates, and constraints.yaml `refactor_contract`.
- Extend Stage 3 spec list with:
  - `Refactor contract — source of truth, compare depth, anti-cheat rules, ownership protocol, human gates`.
- Extend Stage 4 write list conditionally:
  - `agent_tasks/task-template.md`;
  - `refactor-status.toml` only if user selected multi-agent/task-file tracking;
  - optional `.agent-readiness/latest.json` in audit-only.
- Extend anti-patterns:
  - no shelling out to legacy/reference implementation except oracle commands;
  - no dual production path unless explicitly approved;
  - no final-output-only parity when intermediate oracle exists;
  - no weakening compare tests.

Do not add long case studies to `SKILL.md`; keep them in `HARNESS.md` or references.

#### 3. `references/question-bank.md`

Add **Dimension 9 — Refactor / Migration Contract** after Dimension 8. It should be skipped unless Stage 0 or user intent activates it. Core questions:

- Q9.1 Refactor kind: port / rewrite / framework migration / compatibility refactor / not a refactor.
- Q9.2 Source of truth: legacy code, upstream repo, old binary, formal spec, golden fixtures, none yet.
- Q9.3 Public surfaces that must remain compatible: API, CLI, schema, DB, UI routes, file formats, exported types.
- Q9.4 Compare depth: final output, diagnostics/errors, intermediate state, real-project conformance.
- Q9.5 Cutover policy: clean cutover, staged dual-run, compatibility bridge, human-approved exception.
- Q9.6 Forbidden moves: concrete anti-cheat checklist.
- Q9.7 Work ownership: issue tracker, task files, labels, no parallel agents.
- Q9.8 Human gates: public API/schema/security/migrations/data deletion/concurrency.

Budget rule: Q9.2 and Q9.6 are mandatory when refactor overlay is active. Others resolve via profile defaults if budget is tight.

#### 4. `references/agents-md-sections.md`

Add a conditional section immediately after Project Identity or Verification Matrix:

```markdown
## Source of Truth & Refactor Contract

| Surface | Canonical source | Verification |
|---|---|---|
| {{SURFACE}} | `{{REFERENCE_PATH_OR_URL}}` | `{{COMPARE_COMMAND}}` |

Rules:
- Preserve behavior from the canonical source unless this contract says otherwise.
- Do not weaken compare tests or snapshots to pass.
- Do not shell out to the legacy implementation except from oracle/compare commands.
- Do not keep old and new implementations live as parallel production paths unless the cutover policy says so.
- Every intentional behavior change needs a regression or compare case.
```

Add this to Rendering rules:

- Drop section when no refactor overlay.
- If overlay is active but no source of truth exists, render a readiness gap instead of inventing one.
- Any command in this table must also appear in Verification Matrix and resolve to a real target.

Also add progressive-disclosure pressure:

- Root AGENTS.md target stays ≲250 lines for L3/L4.
- Prefer an `## External References` table for cold details.
- Generated sections should be marked enough for incremental repair to distinguish generated vs user-owned content without noisy HTML markers.

#### 5. `references/agent-harness-templates.md`

Add optional templates:

- `agent_tasks/README.md`
- `agent_tasks/task-template.md`
- `refactor-status.toml`
- compare harness target snippets:
  - `compare` for CLI/API/golden outputs;
  - `compare-ir` for compiler/transformer/pass dumps;
  - `compare-schema` for API/schema snapshots.

Guardrail: never emit a compare target with placeholder commands. If the reference command is unknown, write the task template and readiness gap only.

#### 6. `references/constraints-yaml-template.md`

Add optional top-level:

```yaml
refactor_contract:
  active: true
  kind: port
  source_of_truth:
    - surface: behavior
      reference: legacy/
      verification: just compare
  cutover_policy: clean-cutover
  forbidden_moves:
    - weaken-compare-tests
    - shell-out-to-legacy
    - dual-production-path
  work_ownership: agent_tasks
```

This makes the refactor contract machine-readable for hooks, future audits, and repair mode.

#### 7. `references/agent-readiness-criteria.md`

Add readiness checks:

- `source_of_truth_declared` — required for active refactor overlay.
- `compare_oracle_exists` — at least one real compare command or explicitly recorded gap.
- `anti_cheat_rules_concrete` — no generic "don't cheat" only.
- `task_ownership_protocol` — required when public OSS / large team / multi-agent selected.
- `readiness_json_written` — optional but recommended for audit-only.

### Risk analysis

Main risk: adding "large refactor" logic bloats every normal initialization run. Mitigation: overlay activation + skip-by-default Q9.

Second risk: generated AGENTS.md exceeds its size budget. Mitigation: put detailed task/compare protocols in `agent_tasks/README.md`, `refactor-status.toml`, or `constraints.yaml`; root AGENTS.md only links and states hard rules.

Third risk: compare/oracle commands become phantom verification. Mitigation: reuse existing no-phantom enforcement rule: every compare command must be in `justfile` or omitted with an honest readiness gap.

Fourth risk: preserving user-owned AGENTS.md sections conflicts with clean generated structure. Mitigation: define generated section names and update only those in incremental/repair mode; leave unknown sections intact unless explicitly asked.

### Recommended implementation order

1. Add eval cases 13–17.
2. Add Q9 to question bank.
3. Add AGENTS.md Source of Truth section and rendering rules.
4. Add constraints/refactor contract schema.
5. Add optional task templates and compare snippets.
6. Update SKILL.md routing/stages.
7. Run targeted self-validation against cases 1, 3, 6, 8, 11, 13–17.

This order keeps the existing skill stable while adding a focused large-refactor harness.

## Additional finding — AGENTS.md repair for broken mid-size projects

The current skill's biggest practical weakness is not missing templates; it is that AGENTS.md repair can become a large documentation rewrite. For a mid/large repo that is already broken, agents need a **small hard operating contract**, not a comprehensive manual.

Better target for repaired AGENTS.md:

```text
Hard AGENTS kernel
├─ One rule / source of truth
├─ Exact commands: setup, check, smoke, verify changed surface
├─ Verification matrix: every row has a real target
├─ Forbidden moves: no test weakening, no fallback, no v2 paths, no ad-hoc commands
├─ Work ownership: one task/failure/module per agent
├─ Human gates: auth, data deletion, migrations, API/schema, concurrency
└─ Enforcement index: machine check or review-only, never vague
```

For a "千疮百孔" repo, `eng-init` should not start by asking agents to refactor code. It should create the runway:

1. Freeze legacy violation baseline so strict gates do not fail every commit.
2. Repair one command entry point (`just check`, `just smoke`, `just test-guardrails`).
3. Rewrite AGENTS.md into the hard kernel; preserve hand-written sections separately.
4. Add the cheapest real runtime verifier (CLI/API smoke/UI route/DB migration check).
5. Declare source-of-truth and anti-cheat rules for the refactor.
6. Split work into claimed units with `Reference`, `Reproduce`, `Allowed files`, `Done when`.

Only after that should multiple agents start module cleanup or large refactor work. This is the "fast and steady" path: tiny work units, hard oracle, no phantom verification, no prose-only constraints.
