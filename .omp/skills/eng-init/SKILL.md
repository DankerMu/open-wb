---
name: eng-init
disable-model-invocation: true
metadata:
  version: "3.5.8"
description: Agent Engineering Readiness Control Plane — establishes, audits, repairs, and maintains the repo-local agent control plane for safe AI-agent work. Use whenever the user wants to bootstrap a new project, harden a repo for AI-agent work, set up AGENTS.md, create CONTEXT.md, establish unified dev commands, add tests/lint/CI/pre-commit guardrails, audit agent readiness, repair failing readiness signals, install a refactor harness, or prevent AI-coding drift (_v1/_v2 files, scratchpad bloat, dead code). Also governs verification tiers (snapshot replay, built-artifact smokes, per-file coverage), decision-record/agent-notes operational lifecycles (proposed/implemented/rejected/archived, archive freeze), documentation discipline (doc gates, Known Limitations, generated catalogs), and agent-harness architecture clauses (model-visible ⟺ logged, runtime invariant companions). Trigger phrases include "initialize project", "set up AGENTS.md", "bootstrap this repo", "engineering setup", "agent-ready repo", "audit agent readiness", "fix readiness", "repair lint/tests/guardrails", "refactor harness", "create CONTEXT.md", "工程初始化", "项目初始化", "仓库约束", "AI 就绪检查", "文档纪律", "决策记录", "agent notes", "验证分层", "stop the v2 file problem". Produces the hot-path AGENTS.md interface, CONTEXT.md, command entrypoints, validation baseline, readiness report/repair evidence, and mechanical guardrails.
---

# eng-init — Agent Engineering Readiness Control Plane

## Purpose

AI is a multiplier: it compounds the structure already present in the repository. This skill establishes and maintains the **repo-local agent control plane** that lets AI agents work safely: memory, invariants, protocols, permissions, observable validation, drift cleanup, and governance boundaries.

`AGENTS.md` is the hot-path interface/artifact of that control plane, not the entire goal. Global Claude rules should stay generic; project truth belongs in the repo and is exposed through `AGENTS.md`, `CONTEXT.md`, selected commands, validators, and real guardrails.

## Control-plane layer model

| Layer | Purpose | Typical artifacts |
|---|---|---|
| Memory | Where repo facts and operating context live | `AGENTS.md`, `CONTEXT.md`, module rules |
| Invariant | What must not drift | lint/type/schema/dead-code/architecture guards |
| Protocol | How work flows | command entrypoint, PR/task protocol, verification matrix |
| Permission | What is high-risk, forbidden, or gated | generated-path rules, secret rules, migration gates |
| Sensorium | How correctness is observed | tests, smoke, E2E, health checks, logs |
| Evaluation / GC | How drift is found, baselined, ratcheted, and retired | guardrail self-test, baseline/ratchet, dead-code checks |
| Governance | What autonomy is allowed | escalation rules, review gates, ownership |

## Mode Router

Route by user intent and observed repo state:

| Pipeline | Use when | Primary outcome |
|---|---|---|
| **Audit** | User asks for diagnosis, readiness score, "AI-ready?" review, or no-write assessment | Deterministic readiness report using `references/agent-readiness-criteria.md` plus the machine-readable `references/readiness-registry.yaml`: application discovery before scoring, stable denominators, previous-report delta when present, configured-but-not-blocking partial credit, seven-layer control-plane overlay, and repair-usable prioritized findings |
| **Initialize** | Fresh, bootstrap, or incremental hardening request | The six-stage flow below installs/repairs the minimal durable control plane: `AGENTS.md` hot-path interface, `CONTEXT.md`, command surface, validators, guardrails, baseline/ratchet, and optional harness artifacts |
| **Repair** | User asks to fix readiness, lint/tests/guardrails, stale AGENTS.md, phantom enforcement, or a report signal | Signal-driven repair loop: locate existing report if present, semantically match the requested signal to `readiness-registry.yaml` / known recipes, make a substantive fix only when locally fixable, run the validator, and rescore/report the changed signal |
| **Refactor Harness** | Large port/rewrite/framework migration/compatibility refactor is active or requested | Apply the large-refactor overlay: source-of-truth contract, compare/oracle verification, anti-cheat rules, work-unit ownership, and human gates before broad edits |

### Audit pipeline summary

Read `references/agent-readiness-criteria.md` for the deterministic report contract and control-plane overlay; use `references/readiness-registry.yaml` as the machine-readable contract for covered criteria and run `scripts/check_readiness_registry.py references/readiness-registry.yaml` after registry edits. Audit discovers applications before scoring, keeps criterion denominators stable across apps, compares to the previous report when one exists, treats configured-but-not-blocking tools as partial credit rather than pass, and emits findings in a form the Repair pipeline can consume. Write a report only when explicitly requested.

### Repair pipeline summary

Repair is report/signal driven, not score gaming:

- **Existing report + requested signal**: semantically match user wording to the report criterion; repair that signal first unless the report shows it already passes.
- **Existing report + no signal**: choose the highest-impact locally fixable failing signal; if several are tied, ask one category-selection question.
- **All passing**: do not write files; report no repair needed and optionally recommend an audit freshness check.
- **No report + requested signal**: perform a targeted scan for that signal and repair only if the failure is locally observable and fixable.
- **No report + no signal**: run Audit first, or ask one category-selection question before any write.

- Repair mode is not an Initialize grill. Do not ask Q1.4 or unrelated Initialize questions for a targeted repair unless the repair must escalate into Initialize; use the report, requested signal, and local scan evidence as the scope.

Every repair must require semantic signal matching, a substantive fix, a validator that exercises the signal, and rescore evidence for the changed signal before claiming improvement. Prefer registry criterion IDs from `references/readiness-registry.yaml`; fall back to `references/agent-readiness-criteria.md` for criteria not yet machine-covered and record the registry coverage gap. Fixability classes are: skill-owned, stack-owned but safe, repo/product-specific, and external/governance. Do not fake external/governance completion; report exact manual/API prerequisites instead.

## Core artifact model

**Core, always considered:**

- `AGENTS.md` — hot-path control-plane interface and operating contract for human and AI contributors: commands, boundaries, validation, review rules, agent permissions, and enforcement index.
- `CONTEXT.md` — project identity, domain language, bounded contexts, invariants, forbidden logic, and open terminology questions.
- Selected dev entry point (`justfile`, `Makefile`, or `package.json` scripts) — one command surface for setup, dev, check, lint, typecheck, test, build, runtime smoke, and refactor/oracle verification.
- `tests/` baseline — the minimal behavior, contract, smoke, or scaffold tests needed to prove the project can be verified.
- Mechanical guardrails — lint/typecheck config, `.github/workflows/ci.yml`, pre-commit hooks, naming guard, `.editorconfig`, `.gitignore`, `constraints.yaml` when thresholds or regexes need machine-readable reuse, and the runtime verification harness (smoke tests, UI walk, guardrail self-test) per the chosen profile.

**Conditional:** module-level `AGENTS.md` files for monorepos or bounded contexts when local rules differ from root rules; repo-local skills (`references/repo-skill-templates.md`) when Q6.10 opts in — procedural workflows too long for AGENTS.md and too behavioral for a gate; the postmortem contract skeleton (`references/incident-pipeline-templates.md`) when Q6.9 opts in; the decision-record operational lifecycle (`references/decision-record-operations.md`) when Q6.8 opts in full — zones, kinds, archive freeze, note-required rule, manifest/verify script; the documentation-discipline module (`references/documentation-discipline.md`) when Q6.11 opts in — doc gate in CI, docs-change-with-code, Known Limitations, generated-catalog regeneration. The agent-harness architecture clause set (`references/agent-harness-architecture.md`) when Q6.12 opts in — model-visible ⟺ logged, runtime invariant companions, and the other agent-facing invariants.

**Never by default:** `CLAUDE.md`, global Claude config, README, PRD, spec, ADR, unrelated documentation, production application code, or broad refactors. When the honest route to a green oracle is a product-code fix (a real behavior difference behind a failing compare, not a harness problem), eng-init names the fix and hands it off as a claimed work unit; it edits production code itself only on the user's explicit request.

## Initialize pipeline — six-stage flow

```text
Stage 0: Scan           → automated, zero questions
Stage 1: Mode decide    → greenfield / bootstrap / incremental / audit-only / repair
Stage 2: Grill          → one question at a time, driven by detected gaps
Stage 3: Spec+Preview   → implementation spec + artifact preview, no writes
Stage 4: Write+Repair   → atomic writes after explicit confirmation
Stage 5: Validate+Report → run validators, guardrail self-test, report evidence
```

Run sequentially for Initialize work. Do not write files before Stage 4. Stage 3 is the spec gate.

## Stage 0 — Scan

Gather repo facts silently:

- Git state and repository root.
- Existing project truth files: `AGENTS.md`, `CONTEXT.md`, module-level `AGENTS.md` files, and any legacy/conflicting rule files.
- Stack markers: `package.json`, lockfiles, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, framework configs.
- **Tool availability**: for each detected stack, check that core tools are on PATH: Node → `node`, `pnpm`/`npm`/`yarn`; Python → `python3`, `uv`/`poetry`; Go → `go`, `golangci-lint`; Rust → `cargo`, `rustc`; Java → `java`, `gradlew`/`mvn`. Missing tools are not blockers — record them as "missing prerequisites" for the Stage 3 spec. Do not silently write commands that reference an unavailable tool.
- Existing command surface: `justfile`, `Makefile`, package scripts, task runners.
- Verification surface: unit/integration/e2e tests, typecheck, lint, formatter, build, coverage. **Probe, do not execute.** Discovery reads manifests, configs, and test-file layout, and confirms runnability with listing-style flags only (`go test -list '.*' ./...`, `pytest --collect-only -q`, `vitest --run --reporter=dot --passWithNoTests --testNamePattern=$^`, `--listTests`). Never run a full test suite, build, or e2e pass during Stage 0: on a real repository one hanging or slow package stalls the entire init before a single file is written, and discovery does not need the result — `unit_tests_runnable` asks whether the suite *runs*, not whether it passes. Full execution belongs to Stage 5 validation, where it is bounded by a timeout and its exit code is reported.
- Mechanical guardrails: pre-commit hooks, naming guards, duplicate/dead-code tools, CI workflows, secret scanning, `.editorconfig`, `.gitignore`.
- **Schema version**: if `constraints.yaml` exists, extract its `strictness_profile.schema_version`. If missing or older than this skill's version (3.5.8), flag the version gap — the incremental-mode schema migration protocol applies. A missing `constraints.yaml` is not a gap; it means the repo was never initialized with eng-init.
- Architecture signals: directory map, apps/packages, bounded-context hints, public interfaces, migrations, API schemas.

Classify the repo:

| Classification | Description |
|---|---|
| Empty | No source files |
| Greenfield-with-intent | README/PRD/notes exist but little or no source |
| Existing, no project memory | Source exists but no root `AGENTS.md` or no `CONTEXT.md` |
| Existing with project memory | Needs incremental hardening or repair |
| Multi-app monorepo | Multiple apps/packages or bounded contexts detected |

Refactor overlay signals (do not change the primary mode by themselves): reference/legacy paths (`legacy/`, `old/`, `reference/`, `fixtures/golden/`, `conformance/`, `compat/`), compare artifacts (`ir/`, `dump/`, snapshots), sibling files in different languages that appear to be ports, parallel old/new implementation paths, public contract artifacts (OpenAPI, GraphQL schema, protobuf, CLI docs), or migration/task status files. Record `large_refactor.active` and the inferred kind for Stage 1 confirmation.

Degraded-project signals: stale or bloated instruction files, no reliable single `check` command, command docs disagree with runnable scripts, many legacy lint/test failures, duplicated modules, `_v2`/`_new` paths, flaky tests, missing smoke seam, or multiple agents expected to refactor without ownership. Record a rehabilitation overlay. In this overlay, stabilize the engineering harness before recommending broad code cleanup.

Large-refactor is an overlay, not a sixth primary mode. Keep one of the modes above, then add `large_refactor: none | port | rewrite | framework-migration | compatibility-refactor` when Stage 0 or the user indicates a major refactor. The overlay activates question-bank Dimension 9 and conditional refactor templates.

## Stage 1 — Mode decision

| Mode | When | Behavior |
|---|---|---|
| `greenfield` | Empty or greenfield-with-intent repo | Full grill, fresh artifact set |
| `bootstrap` | Existing source, missing `AGENTS.md` or `CONTEXT.md` | Full grill, write project memory and minimal guardrails |
| `incremental` | Existing project memory present, or a targeted hardening request scoped to an existing surface (record the routing reason) | Audit first, grill only gaps, render patch preview |
| `audit-only` | User wants diagnosis only | Read `references/agent-readiness-criteria.md`, including the control-plane layer overlay and AGENTS.md constraint-dimension audit; report gaps; write report only if explicitly requested |
| `repair` | Broken/inconsistent engineering surface | Fix stale commands, phantom enforcement, missing configs, or conflicting rule files |

State the proposed mode plainly. User can override with one word.

**Precedence when rows overlap**: a targeted hardening request on a repo with no project memory matches both `bootstrap` and `incremental`. Route to `incremental` — honor the requested scope rather than escalating into a full grill — and record the missing `AGENTS.md`/`CONTEXT.md` as a readiness gap in the report instead of silently widening the write set. Escalate to `bootstrap` only when the user accepts it.

## Stage 2 — Grill

Read `references/question-bank.md` for question text and branching. Map answers to artifacts this way:

- Project identity, commands, validation, architecture boundaries, agent behavior, and enforcement index → `AGENTS.md`.
- Strictness profile (L1–L4) → `constraints.yaml` `strictness_profile`, AGENTS.md `Project Identity`, and every threshold/severity placeholder in the write set.
- Domain terms, bounded contexts, invariants, and terminology conflicts → `CONTEXT.md`.
- Thresholds and regexes consumed by hooks/CI → `constraints.yaml`.
- Commands and guardrails → selected dev entry point (`justfile`, `Makefile`, or `package.json` scripts), tests, lint/typecheck, pre-commit, CI.
- Large-refactor Q9 answers → AGENTS.md `## Source of Truth & Refactor Contract`, Verification Matrix compare rows, `constraints.yaml` `refactor_contract`, and optional `agent_tasks/` templates. Rehabilitation overlay state → `constraints.yaml` `rehabilitation`.

Rules:

- One question at a time. Wait for the answer before the next question.
- Use the `AskUserQuestion` tool for every grill question when the harness provides it: 2–4 concrete options, recommended option first labeled "(Recommended)". Plain-text questions are the fallback, not the default.
- **Strictness profile gate**: the constraint strictness profile (question-bank Q1.4, L1–L4) must be asked explicitly in every grilling run — never skipped, never silently defaulted, exempt from the question budget. Ask Q1.4 before presenting any concrete threshold numbers or rendering any profile-derived values; the Q1.4 options may contain the profile table, but no earlier transcript text may state a threshold as chosen. All later defaults resolve against the chosen profile.
- **No silent downgrades**: any decision weaker than the chosen profile's default (skip a required guardrail, lower a threshold, warn where the profile says block) requires explicit user confirmation and a ledger entry.
- **Legacy violation gate**: in bootstrap/incremental mode, when Stage 0 found violations against the chosen profile's gates, the legacy-violation disposition (Q1.4b) must be answered before any block-level gate enters the write set.
- Skip questions the scan already answered; confirm inferred decisions in one line.
- Ask in this order: identity/domain language (including the strictness profile), stack/commands, architecture boundaries, test discipline, mechanical guardrails, runtime verification and critical paths, large-refactor Q9 questions when the overlay is active, observability, agent/tool compatibility.
- Capture user wording verbatim for project identity, domain terms, invariants, forbidden logic, source-of-truth references, and irreversible-risk boundaries.
- Budget: max 20 asked questions per run (Q1.4 exempt; Q1.4b exempt when triggered; Q9.2 and Q9.6 exempt when the large-refactor overlay is active). The bank is ~3x larger than the budget by design — most questions resolve via Stage 0 scan inference plus profile defaults. Follow the per-mode core question sets in references/question-bank.md § Budget & prioritization; ask core questions first, spend remaining budget on detected gaps.
- If the user stops early, ask the strictness profile question if still unanswered, then render the partial spec and mark open questions explicitly by dimension name/number (for example: Dimensions 3–7 still open) rather than silently defaulting them.

## Stage 3 — Spec & Preview

Produce a concise implementation spec in chat before writing files.

The spec must include:

1. **Mode and reason** — why this is greenfield/bootstrap/incremental/audit-only/repair.
2. **Detected stack and commands** — install/dev/check/lint/typecheck/test/build candidates.
3. **Strictness report** — chosen profile (L1–L4), rule counts per enforcement level (`block` / `warn` / `review-only` / `gate`), every downgrade from the profile default with the user's reason, and the baseline disposition when Stage 0 found violations: frozen counts + a ratchet table (same columns as AGENTS.md: Gate / Baseline / Next milestone target / Owner), fix-now, or downgrade. If the report shows mostly `warn`/`review-only` on an L3–L4 profile, say so plainly — that is a weak setup wearing a strict label. List every temporary rule in the write set (baseline freeze, rehabilitation gate, staged compatibility) with its removal trigger; a trigger-less temporary rule is fixed before write or recorded as a readiness gap.
4. **Project memory plan** — `AGENTS.md` sections and `CONTEXT.md` sections to create or repair.
5. **Mechanical guardrails** — exact files to add/update, what each enforces, and at which level (warn vs block).
6. **Verification plan** — which Verification Matrix surfaces/commands will exist, and the explicit list of runtime artifacts in the write set: `smoke/*.hurl`, Playwright baseline, compare/oracle targets when refactor mode is active, `scripts/test-guardrails.sh`, `.claude/settings.json` when applicable, `.tool-versions`. For compilers/parsers/transformers/codegen/query engines/sync engines/importers, say when final-output comparison is insufficient and whether IR/pass dumps, diagnostics, state snapshots, or equivalent intermediate oracles exist or must be added. When required coverage cannot be expressed by the existing verification harness, the harness extension joins the write set — missing harness support is part of the implementation, not a deferred follow-up. If the user declines the harness extension, record both the uncovered surface as a readiness gap and the declined decision in the strictness ledger — never record the surface as covered.
7. **Rehabilitation plan** — when degraded-project signals are present, sequence work as: freeze legacy baseline, establish one command entry point, rewrite AGENTS.md to a concise hard kernel, add the cheapest runtime verifier, then split refactor work into one-failure-or-one-module claimed units. Include the machine state that will be written to `constraints.yaml` `rehabilitation` (`active`, `phase`, `baseline_frozen`, `command_entrypoint`, `runtime_verifier`, `broad_refactor_allowed`, `work_unit_protocol`). Agents must not start broad cleanup until the verifier and baseline exist.
8. **Refactor contract** — when the large-refactor overlay is active, list source of truth, compare depth, forbidden moves, cutover policy, work-ownership mechanism, and human gates. If no oracle or compare command exists, list it as a readiness gap instead of rendering phantom verification.
9. **Validation contract** — the exact commands that must pass after writing, listed as commands, not intentions. This list always includes the rendered-artifact check `python3 <skill-path>/scripts/check_rendered_harness.py <target-repo> --require-section "Verification Matrix" --require-enforcement-index --require-ci-aggregator --forbid-root-backups` (plus the overlay flags that apply). **Add `--require-section "Code Canonicality"` only when eng-init owns the whole file** — greenfield and bootstrap, or a repair the user scoped to AGENTS.md itself. Omit it when repairing a targeted signal on an AGENTS.md eng-init did not write: the section-order check already rejects a demoted Code Canonicality, and demanding a section the skill does not own would turn a one-signal repair into an unrequested rewrite of someone else's file. Every command here is reported in Stage 5 with its exit code; a command promised in this contract and not run is an unmet contract, not an optional step.
10. **Non-goals** — files and behavior explicitly out of scope, including `CLAUDE.md` unless the user separately asks.
11. **Readiness gaps** — what remains review-only or manually enforced.
12. **Conditional-module decisions** — one line per opt-in module the scan made eligible (decision records Q6.8, incident pipeline Q6.9, repo-local skills Q6.10, documentation discipline Q6.11, agent-harness architecture clauses Q6.12, DDD/TDD clauses, module-level `AGENTS.md`), in the form `<module>: installed | declined | not applicable — <reason>`. A conditional module never enters or leaves the write set silently: the question, the answer, and the reason are all visible in the spec, including when the answer was inferred from the request or from an earlier recorded decision rather than asked live. Declines carry the reason that makes them correct — most often the empty-shell rule (installing an artifact whose trigger moment does not exist in this repo trains agents to ignore the layer). This holds in every mode: in repair mode, and whenever the harness offers no interactive question tool, render the question and the answer you are proceeding with instead of skipping the exchange. An installed module with no recorded decision line is the same defect as an unenforced rule — it looks chosen and was not.

Read these templates as needed:

- `references/context-md-template.md`
- `references/agents-md-sections.md`
- `references/agent-readiness-criteria.md`
- `references/aux-file-templates.md`
- `references/agent-harness-templates.md`
- `references/gate-quality-contract.md`
- `references/repo-skill-templates.md` and `references/incident-pipeline-templates.md` only if opted in (Q6.10 / Q6.9)
- `references/constraints-yaml-template.md`
- stack clauses from `references/lang-constraints.md`
- DDD/TDD clauses from `references/ddd-tdd-clauses.md` only if opted in

Show the artifact list with one-line purpose per file. Do not write until the user confirms the preview or the original user request explicitly authorized implementation after the spec.

## Stage 4 — Write & repair

Only write within the target repository. **eng-init never creates file backups.** Git plus the Stage 3 preview is the rollback path; a `.bak` beside a tracked file is a second version-control system inside a repository that already has one — the same anti-pattern as `_v2`, and it rots unread. If the repository is not under git, say so and stop before overwriting anything rather than inventing a backup.

Existing backups follow two different rules, and telling them apart matters:

- **An eng-init backup** (a `.bak` of an artifact eng-init owns, or anything under `.eng-init/backups/`) is debt: confirm the content is recoverable from git, then propose deleting it. Never create a replacement.
- **Anything else living there is not eng-init's to remove.** Backup directories collect unrelated artifacts — database restore points, dumps, pre-migration snapshots — that are frequently the only copy in existence. Verify recoverability before proposing any deletion, name the exact file and its size, and treat "it is in a backup directory" as no evidence at all that it is disposable. When in doubt, leave it and say why.

Write or repair the selected artifacts:

1. `AGENTS.md` from captured project identity, commands, validation rules, architecture boundaries, gray-box review policy, agent rules, and enforcement index.
2. `CONTEXT.md` from captured domain language, bounded contexts, invariants, forbidden logic, and open terminology questions.
3. Selected dev entry point (`justfile`, `Makefile`, or `package.json` scripts) so all standard workflows route through one command surface.
4. Minimal test/contract/smoke baseline when the stack has enough information to make it meaningful; otherwise record the missing test seam in `AGENTS.md` and the readiness report.
5. Lint/typecheck/formatter configs and CI/pre-commit guardrails selected during grilling.
6. `constraints.yaml` when hooks or CI need shared thresholds, forbidden patterns, a generated-section registry, or a machine-readable refactor/rehabilitation contract.
7. Optional large-refactor coordination files (`agent_tasks/task-template.md`, `agent_tasks/README.md`, `refactor-status.toml`) only when Q9.7 selected local task ownership.
8. Module-level `AGENTS.md` files only when monorepo/bounded-context rules materially differ from root rules.

### No phantom enforcement check

For every tool or rule named in `AGENTS.md`:

- Its config file must exist already or be in the write set.
- A `justfile`/`Makefile` target or package script must invoke it.
- Every path in the `## Enforcement Index` must resolve to an existing file, a file being written, or a documented external setting.
- Every command in the `## Verification Matrix` must resolve to the selected dev entry point (`justfile`, `Makefile`, or package script) and the target/script must exist or be in the write set.
- Every Verification Matrix command is also mirrored in `constraints.yaml` `verification` — the machine-readable mirror harnesses execute from. An unmirrored command is a phantom-enforcement failure in this checklist; the eval helper `scripts/check_rendered_harness.py` cross-checks the mirror only when a `verification` block is present, so this step, not that script, owns the requirement.
- `.claude/settings.json` is written only when Claude Code was named at Q1.5 — it is enforcement config (hooks), not `CLAUDE.md`.
- If any check fails: add the missing file, replace the tool, or delete the rule. Never write unenforced rules as if they are enforced.

**Run the deterministic checker on your own output.** Before reporting Stage 4 complete, run:

```bash
python3 <skill-path>/scripts/check_rendered_harness.py <target-repo> \
  --require-section "Verification Matrix" --require-enforcement-index --forbid-root-backups
```

Add `--require-section "Code Canonicality"` when eng-init owns the whole AGENTS.md (greenfield, bootstrap, or an AGENTS.md-scoped repair), `--require-refactor-contract --require-compare` when the refactor overlay is active, `--require-generated-section-registry` in repair mode, and `--require-rehabilitation-state` when that overlay is active. Every failure it prints is fixed before Stage 5, and its exit code is reported with the Stage 5 evidence. This catches what prose review reliably misses: unresolved `{{PLACEHOLDER}}` tokens left in a written file, Verification Matrix commands with no target, Enforcement Index paths that do not exist, and constraints/matrix mirror drift. Shipping a skill that owns a checker and never runs it on its own artifacts is phantom enforcement — the exact failure this skill exists to prevent.

- Every command in AGENTS.md `## Source of Truth & Refactor Contract` must also resolve to a Verification Matrix row and a real target, or be recorded as a readiness gap.

## Stage 5 — Validate & report

Run **every command named in the Stage 3 validation contract**, in this order, and report each one's exit code:

1. `python3 <skill-path>/scripts/check_rendered_harness.py <target-repo> …` — the rendered-artifact check. **Run this first and fix every failure before continuing.** It is the only mechanical check on your own output: unresolved `{{PLACEHOLDER}}` tokens, Verification Matrix commands with no target, Enforcement Index paths that do not exist, constraints/matrix mirror drift, and the rendered AGENTS.md line budget. Reading it is not running it, and a non-zero exit is a Stage 4 defect to repair, never a note to pass along.
2. The selected validation command (`just check`, `make check`, `npm run check`, etc.) when available.

- Exit 0 → report pass.
- Non-zero → report failure, first actionable error, and whether the failure is caused by the new scaffold or pre-existing project state.
- Exit 127 / missing tool → report install command or prerequisite; do not claim success.

When `scripts/test-guardrails.sh` is in the write set (L2+), run the selected guardrail self-test command (`just test-guardrails`, `make test-guardrails`, or the configured package script) and report per-guard PASS/FAIL. A guard that fails to reject its violation is a phantom-enforcement failure — the transcript must show the failing guard output before repair, then the fix. After the fix, re-run the exact same guardrail self-test command and include the passing command, exit code, and per-guard output in the final validation evidence.

When the large-refactor overlay is active, run every real compare/oracle command named in the Verification Matrix or Source of Truth contract (`just compare`, `make compare`, `npm run compare`, `compare-ir`, conformance/snapshot commands, etc.) before reporting success. If a compare command is not available, report it as a readiness gap and do not claim parity or refactor completion. In the success report, separate scaffold validation evidence (`check`, lint/typecheck/test through the selected entry point) from refactor parity evidence (`compare*`, conformance/snapshot, golden fixture output).

- In `audit-only` mode, write `docs/agent-readiness-report.md` only when explicitly requested. The report must follow `references/agent-readiness-criteria.md`: discover applications before scoring, preserve denominator stability, include previous-report delta when available, list configured-but-not-blocking findings as partial credit, include the seven control-plane layer summary (Memory, Invariant, Protocol, Permission, Sensorium, Evaluation/GC, Governance), include the AGENTS.md constraint-dimension audit, and rank priority actions by future agent correct-change cost. If the user asks for machine-readable output, also write `.agent-readiness/latest.json` or `docs/agent-readiness-report.json` using the schema in `references/agent-readiness-criteria.md`.

Final response includes files written, `.eng-init/backups/` entries if any, validation evidence, changed generated sections, preserved user-owned sections, and remaining readiness gaps. Do not commit or `git add`.

## Incremental / repair mode notes

- Prefer repairing stale `AGENTS.md`/`CONTEXT.md` over adding parallel files.
- When the large-refactor overlay is active and an existing `## Source of Truth & Refactor Contract` lacks the section template's anti-cheat rules, repairing that section to the template joins the write set — the contract's protection is not grandfathered out by predating the template.
- **AGENTS.md repair style**: content not much, constraints hard. For bloated instruction files, rewrite toward a compact hard kernel: one rule, source-of-truth links, exact commands, verification matrix, forbidden moves, work ownership, human gates, and enforcement index. In repair mode, root AGENTS.md should keep only these hot operating constraints plus minimal identity/links needed to use them; move stack detail, background rationale, and cold explanations to referenced files or preserve them as user-owned sections. Do not grow the root file with another layer of prose.
- **Re-running on a repo eng-init already initialized is an update, never an overwrite.** Present the diff in four classes, and never collapse them:
  1. **Facts** — thresholds, command names, paths, generated tables. Recomputed silently; a hand-edit here is an edit to a projection and is expected to be replaced.
  2. **Decisions** — the chosen profile, the Q1.4b baseline disposition, every downgrade and its stated reason, project identity in the user's own words, domain terms, recorded failure modes. **Never overwritten.** The skill cannot re-derive them, so losing them destroys the ledger that makes the rest legible.
  3. **User-owned sections** — anything not in the generated registry. Preserved untouched and listed separately.
  4. **Retired sections** — content an older version generated that the current version no longer generates. This is the class that silently accumulates zombie rules, so it gets an explicit decision: propose deletion, naming which version produced it and why it is gone. If the user keeps it, record it in the generated-section registry as user-owned from then on, so it stops being re-proposed. Never silently keep, never silently delete.

  The invariant: after a re-run the artifact equals the current version's generated set plus content the user explicitly owns, with no third category surviving unexamined.
- **Schema migration**: when an existing `constraints.yaml` has no `schema_version` or an older version, the Stage 0 scan must flag the version gap. Before writing any files, propose a migration: add missing sections (`verification`, `baseline`, `exemptions`) with conservative defaults, preserve all existing values, and bump `schema_version` to the current template version. Never silently overwrite user-configured values.
- If `CLAUDE.md` exists in a project, do not edit it by default. Treat it as out of scope unless the user explicitly asks.
- If `CONTEXT.md` is missing but domain terms appear in code, create a starter glossary and mark uncertain terms as open questions.
- If command docs and actual scripts disagree, trust runnable scripts, then update `AGENTS.md` to match observed reality.
- If a rule has no mechanical enforcement and the user declines enforcement, label it "review-only" rather than pretending CI checks it.
- Baseline mode: never flip block-level gates on a violation-laden repo without the Q1.4b decision; freeze-baseline is the default recommendation.
- In repair mode, distinguish generated eng-init sections from user-owned sections in the preview. Update generated sections; preserve unknown or hand-written sections by default unless the user explicitly asks for replacement. Track generated section ownership in `constraints.yaml` (`generated_sections.agents_md`) so later repair runs can update only the sections eng-init owns without relying on noisy inline markers.

## Anti-patterns

- Do not use project `CLAUDE.md` as the standard project memory file.
- Do not update global Claude config unless explicitly requested.
- Do not skip the Stage 3 spec gate.
- Do not batch grill questions.
- Do not skip or silently default the strictness profile question; do not infer the profile from lifecycle alone.
- Do not install or decline a conditional module (Q6.8 decision records, Q6.9 incident pipeline, Q6.10 repo-local skills, Q6.11 documentation discipline, Q6.12 agent-harness architecture clauses, DDD/TDD clauses, module-level `AGENTS.md`) without its Stage 3 decision line: question, answer, and reason. Acting on an inferred answer is allowed; leaving the inference invisible is not.
- Do not write warn-level enforcement where the chosen profile requires block, except as a user-confirmed downgrade recorded in the strictness ledger.
- Do not invent commands; read existing manifests first.
- Do not write rules that name tools not installed, configured, or invoked.
- Do not create `_v1`, `_v2`, `_new`, `_old`, `_backup`, `_temp`, `_copy`, or `_final` variants.
- Do not enable block-level gates on legacy violations without a baseline decision (Q1.4b).
- Do not render a temporary rule (baseline freeze, rehabilitation gate, pre-release stance, compatibility layer) without its removal trigger in the rule's first sentence — a temporary policy with no removal condition is permanent debt.
- Do not render a Verification Matrix row whose command does not exist.
- Do not weaken compare tests, snapshots, or fixtures to make a refactor pass.
- Do not grow snapshot/compare normalizers to absorb real behavior differences — fix the fixture or the product; a new normalizer rule needs its own justification.
- Do not let CI write or update snapshots/expected outputs: CI compares in read-only verify mode; record/update modes stay local and human-reviewed.
- Do not shell out to the legacy/reference implementation except from explicit oracle commands.
- Do not ship silent fallback to old code or unapproved dual production paths.
- Do not accept final-output-only parity for compilers, transformers, sync engines, importers, or migrations when an intermediate-state oracle exists.
- Do not claim runtime verification without fresh evidence from the current session.
- Do not let a suite that exists to prove a capability self-skip into green: secret-consuming workflows hard-fail a preflight when the secret is absent (`references/agent-harness-templates.md` § Secret preflight), and capability-proving CI jobs assert zero skipped tests.
- Do not game readiness metrics: no empty tests, disabled lint configs, placeholder configs, or docs-only fake enforcement where mechanical enforcement is possible.
- **Never relax an existing gate in the target repository to fit its own output.** A word budget, coverage floor, size limit, complexity ceiling, or lint severity already in the repo is a calibrated decision someone made; eng-init's content is not a reason to move it. When rendered content exceeds an existing threshold, relocate it, condense it, or write less — and if raising the threshold is genuinely right, propose it as its own decision with the number, the reason, and the user's confirmation, never bundled into the write set as a repair. Editing the gate so your change passes is the defect this skill exists to prevent, and calling it "repaired" does not change what it is.

## Maintaining this skill

Run `./scripts/selfcheck.sh` before shipping any change to `SKILL.md`, `references/`, `evals/`, or `scripts/`. It gates the registry contract and its cross-reference to the criteria table, this skill's own content invariants (`evals/content-checks.json`), and the verifier fixture tests — and fails loud when a prerequisite is missing, because a gate that could not run has not passed. A change that intentionally removes a pinned rule updates its invariant in the same commit; never delete an invariant to get green.

## Reference index

Load only when needed. Files are independent.

| File | When | What |
|---|---|---|
| `references/agent-readiness-criteria.md` | Stage 0/1 and audit-only | Readiness checklist mapped to `AGENTS.md`, `CONTEXT.md`, commands, tests, guardrails, plus control-plane layers and AGENTS.md constraint dimensions |
| `references/readiness-fix-recipes.md` | Repair pipeline | Signal-to-fix recipes, semantic matching guidance, fixability classes, bad-fix examples, validator and rescore expectations |
| `references/readiness-registry.yaml` | Audit / Repair maintenance | Machine-readable subset of criteria with scope, fixability, validator, and rescore evidence; validate with `scripts/check_readiness_registry.py` |
| `references/readiness-report-schema.json` | Audit output | Machine-readable report shape for app catalog, score rows, partial-credit rows, control-plane layers, constraint dimensions, and priority actions |
| `references/readiness-repair-schema.json` | Repair handoff | Machine-readable changed-signal repair handoff: requested signal, matched criterion, pre/post state, validator, decision, and anti-gaming evidence |
| `scripts/score_readiness_report.py` | Audit validation | Validates machine-readable report denominators, null/skippable rules, configured-but-not-blocking partial rows, and recomputes `score.average` |
| `scripts/validate_readiness_repair.py` | Repair validation | Validates changed-signal repair handoffs and rejects fake local completion for external/governance criteria |
| `references/question-bank.md` | Stage 2 | Question text and branching; map answers to core artifacts above |
| `references/context-md-template.md` | Stage 3/4 | `CONTEXT.md` template for domain language and bounded contexts |
| `references/agents-md-sections.md` | Stage 3/4 | `AGENTS.md` section templates and rendering rules |
| `references/lang-constraints.md` | Stage 3/4 | Stack-specific clauses for `AGENTS.md` and tooling |
| `references/ddd-tdd-clauses.md` | Stage 3/4 if opted in | DDD and TDD clauses for `CONTEXT.md`/`AGENTS.md` |
| `references/eng-pillars.md` | Stage 2/4 | Engineering pillars and guardrail rationale |
| `references/aux-file-templates.md` | Stage 4 | justfile, Makefile, lint, CI, hooks, contract-test templates |
| `references/agent-harness-templates.md` | Stage 3/4 | Runtime harness, guardrail self-test, agent-native enforcement, baseline/ratchet, toolchain pinning templates |
| `references/gate-quality-contract.md` | Stage 4 and audit/repair of gates | Gate qualification contract: self-proof dual assertion, error-message protocol, fail-closed scanning, exemption/allowlist hygiene, verify-vs-generate rule |
| `references/verification-tiers.md` | Stage 3/4 and audit/repair of verification | Tiered verification distilled from the DeepSeek Harness SDK: unit → coverage gate → real-API e2e → keyless snapshot replay → built-artifact smokes → browser snapshots, plus the rules that keep each tier honest (real entry path, verify-the-world, source-plane-only, CI-never-writes-snapshots, zero-skipped) |
| `references/decision-record-operations.md` | Stage 3/4 if Q6.8 opts in full | Decision-record operational lifecycle: four-zone tree (proposed/implemented/rejected/archived), kinds, archive freeze, note-required rule, GC by future decision value, manifest/verify script, bilingual pairs |
| `references/documentation-discipline.md` | Stage 3/4 if Q6.11 opts in | Documentation discipline module: doc gate in CI, docs-change-with-code, Known Limitations + allowlist, generated catalogs regenerate-never-hand-patch, one home per fact |
| `references/agent-harness-architecture.md` | Stage 3/4 if Q6.12 opts in (agent-facing codebases) | Architecture clauses distilled from the DeepSeek Harness SDK: model-visible ⟺ logged, capability seams, registrations as effects, explicit defaults, no hardcoded tunables, fail-loud config, runtime invariant companions, branded ids, waterfall delegation |
| `references/defensive-patterns-seeds.md` | Postmortem/danger-patterns work (Q6.9) | Seed catalog of class-level defensive rules from the DeepSeek Harness SDK; seeds for adapting a repo's own earned patterns, never installable verbatim |
| `references/repo-skill-templates.md` | Stage 3/4 if Q6.10 opted in | Repo-local skill layer: placement decision tree, authoring contract, pre-push-checks / prose-contract / decision-record-lifecycle templates |
| `references/incident-pipeline-templates.md` | Stage 3/4 if Q6.9 opted in | Postmortem contract skeleton, three-layer landing contract, danger-patterns convergence threshold |
| `references/constraints-yaml-template.md` | Stage 4 | `constraints.yaml` template |
| `evals/cases.md` | Skill maintenance | Regression cases for changes to this skill |
| `evals/content-checks.json` | Skill maintenance | This skill's own content invariants — every mechanically checkable rule it promises |
| `scripts/check_skill_content.py` | Skill maintenance | Gates those invariants; exits non-zero when a promised rule went missing |
| `scripts/selfcheck.sh` | Skill maintenance | One command running every gate this skill owns; run it before shipping any change here |

## Principles

1. **AGENTS.md is the hot-path interface, not the whole control plane.** It exposes the repo-local operating contract for agent and human work while commands, validators, guardrails, and reports do the enforcement.
2. **CONTEXT.md prevents terminology drift.** One term has one meaning; bounded contexts stop multi-agent context bleed.
3. **Mechanized constraints beat prose.** Every enforced rule points to a config, hook, CI step, or command.
4. **Gray-box by default, white-box for critical paths.** Non-critical internals can be validated through contracts and tests; auth, payments, permissions, data deletion, migrations, security, concurrency, public APIs, and irreversible operations require implementation review.
5. **No phantom enforcement.** A named guardrail that does not run is worse than no guardrail because it creates false confidence.
6. **Spec before writes.** The previewed spec is the write plan; do not add last-minute artifacts during Stage 4.
7. **Strictness is a chosen profile, not an emergent default.** The user picks L1–L4 once; every threshold and enforcement level derives from that choice. Mid-strength defaults that nobody chose are how repos end up under-constrained.
