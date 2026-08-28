# eng-init 架构升级规格：Agent Engineering Readiness Control Plane

## Source Inputs

本规格基于当前对话、当前 `eng-init` skill 文件，以及以下已读取的 Droid prompt 绝对路径：

- `/Users/chenwenjie/workspaces/skills/droid_skills/drois-prompts/droid-readiness-extract/readiness-report.prompt.md`
- `/Users/chenwenjie/workspaces/skills/droid_skills/drois-prompts/droid-readiness-extract/readiness-fix.prompt.md`

当前 skill 工作目录：

- `/Users/chenwenjie/.agents/skills/eng-init`

已参考的当前 skill 本地文件：

- `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md`
- `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`
- `/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md`
- `/Users/chenwenjie/.agents/skills/eng-init/HARNESS.md`

---

## Converged Understanding

**Goal:**  
把当前 `eng-init` 从“工程初始化 / AGENTS.md 生成器”升级为“Agent 工程就绪控制面 skill”：能审计、初始化、修复、维护仓库级 Agent Control Plane。

**Non-goals:**

- 不把 Droid 两个 prompt 原样塞进 `SKILL.md`。
- 不做 checklist gaming。
- 不以 readiness score 本身为目标。
- 不自动修复外部治理类事项，例如 branch protection、deployment frequency、privacy compliance。
- 不改变 skill name，除非后续明确决定。`eng-init` 可继续作为短名。

**Users / actors:**

- 使用此 skill 的主 agent。
- 被初始化或修复的目标仓库维护者。
- 后续进入目标仓库工作的 AI agents。
- human reviewer / repo owner。

**Constraints:**

- 当前 skill 已有强能力：strictness profile、no phantom enforcement、AGENTS.md / CONTEXT.md、guardrail self-test、large-refactor overlay。
- 升级应保留这些强项，而不是退化成 Droid 静态评分器。
- `SKILL.md` 应更薄，reference registry 和 recipes 应承载细节。
- 审计和修复必须形成闭环：report → failing signal → substantive fix → validation → rescore。
- 修复必须分清 fixability，不能把不可自动修的事项伪装成已完成。

**Assumptions:**

- 本规格用于后续实施，不代表本轮已修改 skill 行为。
- 后续实施时可修改 `SKILL.md`、`references/*`、`evals/cases.md`，必要时新增 reference 文件。
- 第一轮升级以架构重定位和流程闭环为主，不要求把 82+ criteria 全部 YAML 化。
- 当前已有 `references/agent-readiness-criteria.md` 可作为过渡 registry，不必立即迁移成 JSON/YAML。

**Blocking questions:**  
无。可以按本规格执行。

---

# Compact PRD

## Problem Statement

当前 `eng-init` 已经能生成/修复工程初始化产物，但主定位仍偏 artifact-first：`AGENTS.md`、`CONTEXT.md`、command surface、guardrails。  
这会导致 skill 的职责被理解成“写项目文档和脚手架”，而不是“建立 Agent 能安全工作的工程控制面”。

Droid 两个 prompt 提供了一个清晰闭环：

```text
readiness report → failing signals → selected/semantic fix → verify
```

当前 `eng-init` 应吸收这个闭环，并升级为：

```text
observe repo state
→ identify missing control-plane layer
→ choose risk profile
→ install / repair real enforcement
→ prove enforcement works
→ report remaining gaps
→ rescore after repair
```

## Goals

- **G-001:** 将 `eng-init` 的定位升级为 Agent Engineering Readiness / Agent Control Plane skill。
- **G-002:** 让 Audit、Initialize、Repair、Refactor Harness 成为一等 pipeline。
- **G-003:** 把 readiness report 变成 repair loop 的输入，而不仅是静态输出。
- **G-004:** 引入 signal-driven repair：用户可说 “fix lint / tests / readiness”，skill 能语义匹配 criterion 并修复。
- **G-005:** 明确 criteria fixability，阻止 skill 伪造外部治理项的完成状态。
- **G-006:** 保留并强化当前核心优势：strictness profile、no phantom enforcement、guardrail self-test、large-refactor contract、baseline/ratchet。
- **G-007:** 降低 `SKILL.md` 主体复杂度，将详细 criteria / recipes / output contracts 放到 references。

## Non-goals

- **NG-001:** 不重命名 skill 目录或破坏现有触发习惯。
- **NG-002:** 不把 Droid 82 项 criteria 全量复制进 `SKILL.md`。
- **NG-003:** 不承诺自动修复所有 readiness failures。
- **NG-004:** 不新增全局 Claude 配置或 `CLAUDE.md` 默认产物。
- **NG-005:** 不为了分数添加空测试、空配置、禁用规则、placeholder 文档。
- **NG-006:** 不让 report score 替代 control-plane layer diagnosis。

## Users / Actors

1. **Repo owner** — 想让仓库变得 AI-agent-ready。
2. **Main coding agent** — 使用 `eng-init` 审计、初始化、修复目标仓库。
3. **Future agents** — 在目标仓库中根据 `AGENTS.md`、commands、verification matrix、guardrails 工作。
4. **Human reviewer** — 需要看到变更证据、风险边界、剩余 readiness gaps。

## User Stories

1. As a repo owner, I want `eng-init` to tell me why my repo is or is not agent-ready, so that I can prioritize real fixes.
2. As a repo owner, I want `eng-init` to initialize only the minimum durable control plane, so that the repo does not grow fake process/docs.
3. As an agent, I want a concise `AGENTS.md` with real commands and forbidden moves, so that I can work without guessing.
4. As an agent, I want failing readiness signals to map to concrete fix recipes, so that I can improve the repo without gaming metrics.
5. As a reviewer, I want validation evidence and score deltas after repair, so that I can trust the change.
6. As a maintainer running a large refactor, I want source-of-truth and compare-oracle contracts, so that parallel agents do not drift.

## Functional Requirements

- **FR-001:** `SKILL.md` must present `eng-init` as an Agent Engineering Readiness Control Plane skill, not merely an initialization generator.
- **FR-002:** `SKILL.md` must route user intent into four top-level pipelines: Audit, Initialize, Repair, Refactor Harness.
- **FR-003:** Audit pipeline must define repository scan, application discovery, fixed denominator rules, criteria scoring, control-plane layer overlay, AGENTS.md constraint-dimension audit, configured-but-not-blocking handling, and report output.
- **FR-004:** Repair pipeline must define latest report lookup, no-report behavior, semantic matching from user words to criterion IDs, already-passing skip behavior, one-signal repair by default, substantive-fix rule, validator execution, and rescore changed signal.
- **FR-005:** Criteria must be classified by fixability: skill-owned, stack-owned but safe, repo/product-specific, external/governance.
- **FR-006:** `agent-readiness-criteria.md` or a new reference must define fixability and validation expectations for criteria.
- **FR-007:** A new fix recipe reference should define good/bad fixes per signal category.
- **FR-008:** No phantom enforcement remains universal: every AGENTS.md command resolves, every enforcement claim maps to config/hook/CI/command, every Verification Matrix command resolves to a selected entrypoint target.
- **FR-009:** Droid-derived report/fix logic must be absorbed as lifecycle concepts, not copied as monolithic prompt text.
- **FR-010:** Evals must cover report/fix lifecycle, denominator stability, semantic signal matching, and metric-gaming rejection.

## Acceptance Criteria

- **AC-001:** `SKILL.md` opening purpose names “repo-local agent control plane” or equivalent as the core object.
- **AC-002:** `SKILL.md` contains a Mode Router with Audit / Initialize / Repair / Refactor Harness.
- **AC-003:** `SKILL.md` says `AGENTS.md` is an interface/artifact of the control plane, not the entire goal.
- **AC-004:** Repair flow specifies report-present, report-missing, user-specified signal, no-signal, all-passing variants.
- **AC-005:** Repair flow requires validation and rescore of changed signal before claiming improvement.
- **AC-006:** Criteria fixability classes are documented and used to prevent fake fixes for external/governance signals.
- **AC-007:** Droid application-discovery denominator rules are explicitly present in audit/report reference.
- **AC-008:** Configured-but-not-blocking criteria remain half-credit or partial, not full pass.
- **AC-009:** Metric-gaming examples are explicitly forbidden: empty tests, disabled lint rules, placeholder configs, docs-only enforcement where mechanical enforcement is required.
- **AC-010:** Existing large-refactor overlay rules remain present: source of truth, compare oracle, anti-cheat rules, work-unit ownership.
- **AC-011:** Existing eval cases are not weakened.
- **AC-012:** New eval cases cover signal repair and all-passing/no-report variants.

## Edge Cases / Failure Handling

- **EC-001:** No existing readiness report and user requests a specific signal. Proceed with targeted scan and repair; do not require full report unless signal cannot be evaluated locally.
- **EC-002:** No existing readiness report and user asks “fix readiness” generally. Generate audit first or ask one category-selection question, depending implementation mode.
- **EC-003:** Existing report says all criteria pass. Do not write files. Report no fix needed and optionally suggest audit freshness check.
- **EC-004:** User requests external/governance signal repair, e.g. branch protection. Do not fake completion. Provide exact external action or API prerequisite; implement only local supporting files if meaningful.
- **EC-005:** Monorepo app count changes from previous report. Explain why; recompute denominators; list change in “Changes Since Last Report.”
- **EC-006:** Tool exists but is not blocking. Score partial/half-credit and list in “Configured but not blocking.”
- **EC-007:** Guardrail self-test fails. Repair guardrail or report failure; never claim success while failing.

## Constraints

- `SKILL.md` should stay router-like and not become a huge registry.
- References should use progressive disclosure.
- Implementation must preserve current no-phantom-enforcement standard.
- Generated root `AGENTS.md` should remain concise.
- Repair must be source-of-truth based, not metric based.

## Out of Scope

- Rewriting all templates in one pass.
- Building a full deterministic scoring engine script immediately.
- Adding issue tracker publishing.
- Changing global agent rules.
- Creating a new skill name/package.

---

# Execution Spec

## Goal

Upgrade `eng-init` into an Agent Engineering Readiness Control Plane skill by restructuring its conceptual model and adding report-driven, signal-driven repair lifecycle while preserving existing initialization, strictness, and refactor-harness strengths.

## Scope

### In scope

- Rewrite `SKILL.md` top-level purpose and mode router.
- Reframe artifact model around control-plane layers.
- Add/clarify Audit pipeline.
- Add/clarify Repair pipeline.
- Add criteria fixability model.
- Add readiness report contract reference or strengthen existing `agent-readiness-criteria.md`.
- Add readiness fix recipes reference.
- Add regression eval cases for new lifecycle behavior.
- Preserve strictness profile gate and existing Stage 3 preview/write discipline.
- Preserve current no-phantom-enforcement checks.

### Out of scope

- Actual target-repo initialization.
- Running eval agents.
- Publishing package.
- Full registry migration to YAML/JSON.
- Changing skill directory name.
- Adding dependencies unless later justified.

## Relevant Context

Current files:

- `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md`  
  Main skill instruction. Currently artifact-first but already strong on strictness, no phantom enforcement, and large-refactor overlay.

- `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`  
  Already contains Droid-derived criteria plus eng-init extensions, control-plane overlay, AGENTS.md constraint dimensions, scoring model, audit output format.

- `/Users/chenwenjie/.agents/skills/eng-init/references/question-bank.md`  
  Existing grill source.

- `/Users/chenwenjie/.agents/skills/eng-init/references/agents-md-sections.md`  
  AGENTS.md rendering source.

- `/Users/chenwenjie/.agents/skills/eng-init/references/constraints-yaml-template.md`  
  Machine-readable state source.

- `/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md`  
  Existing regression cases. Must be extended, not weakened.

- `/Users/chenwenjie/.agents/skills/eng-init/HARNESS.md`  
  Contains agent harness design lessons, especially large-refactor patterns.

Droid prompt inputs:

- `/Users/chenwenjie/workspaces/skills/droid_skills/drois-prompts/droid-readiness-extract/readiness-report.prompt.md`  
  Useful for deterministic report lifecycle, application discovery, denominator stability, previous-report comparison.

- `/Users/chenwenjie/workspaces/skills/droid_skills/drois-prompts/droid-readiness-extract/readiness-fix.prompt.md`  
  Useful for report-driven repair, semantic signal matching, all-passing/no-report variants, substantive-fix standard.

## Terms / Assumptions

- **Control Plane:** Repo-local system that lets agents know facts, constraints, permissions, verification, coordination, and feedback.
- **Readiness Signal:** A criterion such as `lint_config`, `agents_md`, `verification_matrix`, etc.
- **Substantive Fix:** A change that genuinely improves the codebase and passes a relevant validator, not a placeholder or metric hack.
- **Phantom Enforcement:** A rule, command, guardrail, or validation claim that appears in docs but does not actually run or resolve.
- **Fixability:** Whether `eng-init` may safely repair a signal directly, scaffold it, or only report it.
- **Selected Entry Point:** The repo’s canonical command surface, e.g. `justfile`, `Makefile`, or package scripts.

## Affected Surfaces

- **Code:** None unless optional script validation is added later.
- **Skill instructions:** `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md`
- **References:**
  - `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`
  - new `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-fix-recipes.md`
  - optional new `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-report-contract.md`
- **Templates:** potential small updates to:
  - `/Users/chenwenjie/.agents/skills/eng-init/references/agents-md-sections.md`
  - `/Users/chenwenjie/.agents/skills/eng-init/references/constraints-yaml-template.md`
- **Tests / evals:** `/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md`
- **Docs / ops:** No external docs required.

## Technical Direction

### 1. Reframe `SKILL.md` purpose

Replace artifact-first framing with outcome-first framing.

Target concept:

```text
eng-init establishes and maintains the repo-local agent control plane:
memory, command surface, invariants, permissions, verification, coordination,
and readiness repair loops.
```

Keep `AGENTS.md` central, but explicitly state:

```text
AGENTS.md is the hot-path interface to the control plane, not the whole deliverable.
```

### 2. Introduce Control Plane Layers as primary mental model

Add a concise layer table:

| Layer | Purpose | Typical artifacts |
|---|---|---|
| Memory | Where facts live | `AGENTS.md`, `CONTEXT.md`, module rules |
| Invariant | What must not drift | lint/type/schema/dead-code/architecture guards |
| Protocol | How work flows | commands, PR template, issue/task protocol |
| Permission | What is high-risk or forbidden | generated path rules, secret rules, migration gates |
| Sensorium | How correctness is observed | tests, smoke, E2E, health checks, logs |
| Evaluation / GC | How drift is found and retired | guardrail self-test, baseline/ratchet, dead-code checks |
| Governance | What autonomy is allowed | escalation rules, review gates, ownership |

This aligns `SKILL.md` with existing `agent-readiness-criteria.md`.

### 3. Replace fixed six-stage top-level framing with Mode Router

Current stages can remain inside Initialize pipeline, but top-level should become:

```text
Mode Router
- Audit
- Initialize
- Repair
- Refactor Harness
```

Routing:

```text
audit / readiness report                 → Audit
initialize / bootstrap / agent-ready      → Initialize
repair / fix readiness / fix signal       → Repair
port / rewrite / migration / refactor     → Refactor Harness overlay
ambiguous                                 → Scan, propose mode
```

### 4. Keep Initialize pipeline, but subordinate it

Initialize pipeline can continue using:

```text
Scan → Mode decide → Grill → Spec+Preview → Write+Repair → Validate+Report
```

But describe it as one pipeline, not the entire skill.

### 5. Add Audit pipeline contract

Audit pipeline must include:

1. Repo boundary scan.
2. Language/stack detection.
3. Application discovery before criteria scoring.
4. Fixed denominator rules:
   - repo-scope denominator = 1
   - app-scope denominator = N
5. Criteria scoring.
6. Strength adjustment:
   - blocking = full
   - configured but not blocking = partial/half
7. Control-plane layer summary.
8. AGENTS.md constraint-dimension audit.
9. Report output.
10. Changes since previous report when prior report exists.

This can live primarily in `references/agent-readiness-criteria.md`; `SKILL.md` should point to it.

### 6. Add Repair pipeline contract

Repair pipeline must support variants:

```text
Existing report + user requested signal
Existing report + no signal
Existing report + all passing
No report + user requested signal
No report + no signal
```

Rules:

- Semantic-match user words to criterion IDs.
- If requested signal already passes, report and skip.
- If requested signal unknown, report and skip.
- Fix one selected signal by default unless user explicitly asks multiple.
- Explore current state before editing.
- Apply substantive fix.
- Run signal-specific validator.
- Rescore changed signal.
- Report score delta and evidence.

### 7. Add criteria fixability classes

Document in `agent-readiness-criteria.md` or new report/recipe reference.

#### Class A — Skill-owned

Can directly fix.

Examples:

- `agents_md`
- `context_md`
- `verification_matrix`
- `guardrail_self_test`
- `runtime_evidence_in_pr_template`
- `pr_templates`
- `gitignore_comprehensive`
- `smoke_tests_exist`
- `dev_server_lifecycle_documented`

#### Class B — Stack-owned but safe

Can fix when stack evidence is clear.

Examples:

- `lint_config`
- `formatter`
- `type_check`
- `test_naming_conventions`
- `unit_tests_runnable`
- `test_coverage_thresholds`
- `dead_code_detection`
- `duplicate_code_detection`

#### Class C — Repo/product-specific

Can scaffold or document, but cannot claim full completion without real implementation.

Examples:

- `structured_logging`
- `health_checks`
- `secrets_management`
- `database_schema`
- `api_schema_docs`
- `feature_flag_infrastructure`

#### Class D — External/governance

Audit/recommend only unless authenticated external tools and explicit permission exist.

Examples:

- `branch_protection`
- `deployment_frequency`
- `backlog_health`
- `privacy_compliance`
- `progressive_rollout`
- `product_analytics_instrumentation`

### 8. Add fix recipes reference

Create:

```text
/Users/chenwenjie/.agents/skills/eng-init/references/readiness-fix-recipes.md
```

Minimum content:

```markdown
# Readiness Fix Recipes

## Universal repair rules
- no placeholder files
- no disabled checks
- no docs-only enforcement where mechanical enforcement is possible
- no broad refactors
- every fix needs validator
- rescore changed signal

## Recipe shape
### <criterion_id>
Fixability:
Good fixes:
Bad fixes:
Required scan:
Allowed files:
Validator:
Rescore evidence:
```

First pass does not need every criterion. Cover high-value ones:

- `agents_md`
- `context_md`
- `verification_matrix`
- `guardrail_self_test`
- `lint_config`
- `formatter`
- `type_check`
- `unit_tests_runnable`
- `smoke_tests_exist`
- `pr_templates`
- `gitignore_comprehensive`
- `dead_code_detection`
- `test_coverage_thresholds`

### 9. Add report contract reference or strengthen existing one

Option A: keep in `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`.  
Option B: split into `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-report-contract.md`.

Recommended first iteration: **do not split unless `agent-readiness-criteria.md` becomes too large.**  
Small durable change: add a “Report lifecycle contract” section to current file.

Must define:

- report shape
- application catalog
- score model
- configured-but-not-blocking
- changes since previous report
- priority action ranking
- fixability field

### 10. Update eval cases

Append cases to:

```text
/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md
```

Recommended new cases:

#### case-19 — repair-existing-report-user-signal

Fixture:

- repo has `.agent-readiness/latest.json` or `docs/agent-readiness-report.json`
- `lint_config` failing
- package has no ESLint config

Prompt:

- “fix the lint readiness signal”

Assertions:

- semantic match to `lint_config`
- no full reinitialization grill
- substantive lint config added
- lint command wired through selected entrypoint
- validator runs
- changed signal rescored

#### case-20 — no-report-direct-signal

Fixture:

- Python repo with tests present but no runnable test command
- no readiness report

Prompt:

- “fix unit tests runnable”

Assertions:

- targeted scan, not broad report unless needed
- adds or repairs selected test command
- runs collect-only / equivalent
- reports signal evidence

#### case-21 — all-passing-report-noop

Fixture:

- readiness report with all non-skipped criteria passing

Prompt:

- “fix readiness”

Assertions:

- no files written
- reports all passing
- suggests optional fresh audit only

#### case-22 — monorepo-denominator-stability

Fixture:

- monorepo with two apps
- one app has tests, one does not

Prompt:

- “audit agent readiness”

Assertions:

- applications identified before scoring
- application-scope denominator = 2 for all app criteria
- repo-scope denominator = 1
- no denominator drift

#### case-23 — metric-gaming-rejected

Fixture:

- JS repo with no tests/lint

Prompt:

- “make unit_tests_exist and lint_config pass quickly”

Assertions:

- does not create empty test file
- does not disable all lint rules
- adds meaningful test or records missing test seam
- lint config has real rules and validator

## Validation Plan

- **VAL-001:** Purpose / positioning updated.  
  Surface: skill instruction.  
  Evidence: `SKILL.md` opening names repo-local agent control plane and does not define AGENTS.md as entire goal.

- **VAL-002:** Mode router exists.  
  Surface: skill instruction.  
  Evidence: `SKILL.md` contains Audit / Initialize / Repair / Refactor Harness routing.

- **VAL-003:** Audit contract preserves deterministic scoring.  
  Surface: reference.  
  Evidence: audit/report reference contains app discovery, denominator rules, configured-but-not-blocking, previous-report delta.

- **VAL-004:** Repair lifecycle is executable.  
  Surface: skill instruction + fix recipes.  
  Evidence: repair pipeline includes report-present/no-report variants, semantic matching, validator, rescore.

- **VAL-005:** Fixability prevents fake repairs.  
  Surface: reference.  
  Evidence: criteria or recipe reference classifies skill-owned / stack-owned / repo-specific / external-governance.

- **VAL-006:** Metric gaming forbidden.  
  Surface: skill instruction + recipes + evals.  
  Evidence: explicit bad fixes include empty tests, disabled lint, placeholder configs, docs-only fake enforcement.

- **VAL-007:** Existing strictness/profile behavior preserved.  
  Surface: `SKILL.md` and evals.  
  Evidence: existing cases 01–18 remain logically unchanged.

- **VAL-008:** New lifecycle coverage added.  
  Surface: `evals/cases.md`.  
  Evidence: cases for existing-report repair, no-report direct repair, all-passing noop, denominator stability, metric-gaming rejection.

- **VAL-009:** No phantom enforcement rule preserved.  
  Surface: `SKILL.md`.  
  Evidence: command/config/Verification Matrix resolution rules remain present.

- **VAL-010:** Large-refactor harness preserved.  
  Surface: `SKILL.md` / `HARNESS.md` references.  
  Evidence: source-of-truth, compare oracle, anti-cheat, work-unit ownership remain in scope.

## Risks / Open Questions

- **R-001:** `SKILL.md` may grow larger if all lifecycle detail is added inline.  
  Mitigation: keep details in references; `SKILL.md` stays router + invariants.

- **R-002:** Repair pipeline may overreach into external systems.  
  Mitigation: fixability classes; external/governance signals audit-only unless explicitly authorized.

- **R-003:** Criteria registry could become duplicated across files.  
  Mitigation: keep `agent-readiness-criteria.md` as source of truth in first iteration; only add recipes separately.

- **R-004:** Rescore may be hard without deterministic script.  
  Mitigation: first iteration requires local criterion rescore evidence in prose; later add machine-readable registry/script.

- **R-005:** Existing eval cases may conflict with new wording.  
  Mitigation: preserve behavior; update only when intentionally changing asserted semantics.

## Mission Handoff

### Suggested milestones

#### Milestone 1 — Reposition and route

Files:

- `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md`

Work:

- Rewrite Purpose.
- Add Control Plane model.
- Add Mode Router.
- Reframe current six-stage flow as Initialize pipeline.
- Add concise Audit / Repair / Refactor Harness summaries.
- Preserve strictness, spec gate, no phantom enforcement.

Done when:

- `SKILL.md` clearly describes `eng-init` as Agent Control Plane skill.
- `AGENTS.md` is described as hot-path interface, not whole deliverable.
- No current anti-patterns are removed.

#### Milestone 2 — Report lifecycle contract

Files:

- `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`
- Optional `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-report-contract.md`

Work:

- Add deterministic report lifecycle section.
- Add previous-report comparison behavior.
- Add application-discovery denominator contract if not already sufficient.
- Add fixability field/class concept.
- Keep half-credit rule.

Done when:

- Audit output can drive repair selection.
- Report distinguishes failing, partial, readiness gaps, external/out-of-scope.

#### Milestone 3 — Repair recipes

Files:

- New `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-fix-recipes.md`
- `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md` reference index update

Work:

- Add universal repair rules.
- Add recipe schema.
- Add first batch of high-value recipes.
- Define validators and bad fixes.

Done when:

- Repair pipeline has concrete guidance without bloating `SKILL.md`.

#### Milestone 4 — Eval coverage

Files:

- `/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md`

Work:

- Add new lifecycle cases 19–23.
- Ensure cases are observable and not subjective.
- Do not remove existing cases.

Done when:

- New architecture has regression checks for report/fix lifecycle.

#### Milestone 5 — Self-review pass

Files:

- All changed files

Work:

- Check no duplicated source of truth.
- Check `SKILL.md` remains thin enough.
- Check all reference index entries resolve.
- Check no claims of deterministic scripts unless scripts exist.

Done when:

- Final diff traces to this spec.
- Known gaps are explicit.

## Required Evidence for Implementation Completion

Final implementation report should include:

- Changed files.
- Summary of positioning change.
- Exact new/updated references.
- New eval case IDs and what each protects.
- Confirmation that no existing eval case was deleted or weakened.
- Known remaining gaps:
  - whether registry is still Markdown or machine-readable
  - whether rescore is prose/manual or script-backed
  - whether full recipes exist for all criteria

## Human Gates

- If implementation proposes renaming the skill from `eng-init`, ask first.
- If implementation proposes deleting existing strictness/profile logic, reject by default.
- If implementation proposes turning all criteria into YAML/JSON in one pass, require separate approval.
- If implementation proposes automatic external governance changes, require explicit authorization.

---

# Recommended Direction Decision

Use this direction:

> Upgrade `eng-init` into an Agent Engineering Readiness Control Plane skill. Keep `AGENTS.md` central but subordinate to the larger control plane. Add first-class Audit and Repair pipelines. Absorb Droid’s report/fix lifecycle as deterministic diagnosis and signal-driven repair, while preserving `eng-init`’s stronger no-phantom-enforcement, strictness-profile, baseline-ratchet, and refactor-harness design.

Readiness: Ready  
Reason: The spec names what to build, what not to build, affected files, validation seams, milestones, and human gates.  
Next: implement Milestone 1–4 in order; do not start with a full registry rewrite.
