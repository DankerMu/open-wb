---
name: review
description: >
  Structured review of concrete artifacts: PRs, diffs, commits, branches, staged changes, named
  files, docs, API specs, database migrations, or infrastructure config. Activate on explicit,
  artifact-scoped review requests — "code review", "review my changes", "find bugs in",
  "security review" — and on consistency/drift requests ("is this consistent with our
  conventions?", naming drift, pattern duplication), which run consistency mode. Produces
  severity-graded findings with fix directions. Do NOT activate for brainstorming, open-ended
  design feedback, governance/library audits, or whether-an-approach-seems-good conversations.
invocation_posture: hybrid
version: 0.8.0
---

# Review

Unified review skill for agent-performed reviews. Auto-detects content types in a change set, applies the appropriate review dimensions, and delivers severity-graded findings with actionable fixes. Covers two axes of quality — **correctness** (the per-type checklists) and **consistency/drift** (the entropy dimensions) — plus a **spec axis** (does the change do what was asked).

## When to Activate

- User asks to review a PR, diff, branch, commit, staged changes, or specific files
- Uses: "code review", "CR", "LGTM?", "security review", "find bugs in", "review my changes", "check my PR"
- Names a concrete artifact and asks for bug finding, breaking-change checks, migration risk review, API/doc correctness, or config/infrastructure review
- Pastes code/text and asks for a review (not a discussion)
- **Consistency mode**: asks whether a change introduces naming drift, pattern fragmentation, or "is this consistent with our conventions?" — run only the consistency axis ([references/consistency-checklist.md](references/consistency-checklist.md))

## When Not To Activate

- Open-ended design/architecture discussion, brainstorming, option comparison → `brainstorming` or plain discussion
- Governance or library-audit requests about skills, agents, or repository hygiene → `skill-lifecycle-manager`
- Teaching review culture, reviewer communication, or mentoring practices
- General quality feedback without a concrete artifact or change set to inspect
- Multi-perspective, high-risk, or risk-adaptive-depth reviews (parallel reviewer packs, invariant/state-machine focus) → `risk-adaptive-cross-review`
- Full repository entropy scan → `repo-entropy-audit`; control-plane/instruction-file audit → `control-plane-auditor`

## Review Modes

| Mode | When | Behavior |
|---|---|---|
| **Quick** | ≤3 files or "quick look" | P0/P1 only. Inline findings, no template overhead. |
| **Standard** | 4–15 files (default) | Full analysis. Structured output with severity grading. |
| **Deep** | >15 files, "thorough", or high-risk | Full analysis + impact analysis + cross-file tracing. |
| **Consistency** | Consistency/drift-only requests | Only the consistency axis; E-graded verdict. |

**Risk-based override**: File count is the default heuristic, but content risk takes precedence. Even with ≤3 files, upgrade to Standard if the change touches auth/authz, payment/billing, database schemas, or public API contracts. Conversely, user intent always wins — "quick look" means Quick, "thorough" means Deep, regardless of file count.

---

## Phase 1 — Scope

1. **Gather the target**: PR (`gh pr diff <n>` / `git diff <base>...<head>` + description and linked issues), branch (`git log --oneline main..<branch>` + `git diff main...<branch>`), staged (`git diff --cached`), unstaged (`git diff`), specific files, or pasted content. If diff >2000 lines, chunk by directory/feature and inform the user.
2. **Read project conventions** — instruction files, linter configs, PR template, recent commits; don't flag what automation already covers. Detail: [references/analysis-guides.md](references/analysis-guides.md).
3. **Understand intent**: summarize the change in one sentence before diving in. If intent is unclear from diff + description, ask the user first — reviewing without intent produces noise.
4. **Classify content types** (most specific match wins; priority resolves overlaps — a `*.tsx` in `__tests__/` is Tests, not Frontend):

| Priority | Content type | Detected by | Reference |
|---|---|---|---|
| 1 | **API Spec** | `openapi.*`, `swagger.*`, `*.graphql`, `*.proto` | `references/content-checklist.md` |
| 2 | **Database** | `*.sql`, `migrations/`, `schema/` | `references/code-checklist.md` |
| 3 | **Infrastructure** | `Dockerfile`, `*.tf`, `k8s/`, CI YAML | `references/code-checklist.md` |
| 4 | **Tests** | `*.test.*`, `*_test.*`, `__tests__/` | `references/code-checklist.md` |
| 5 | **Design Doc** | `*prd*`, `*design*`, `*rfc*`, `*adr*` | `references/content-checklist.md` |
| 6 | **Documentation** | `*.md`, `docs/`, `README*` | `references/content-checklist.md` |
| 7 | **Frontend** | `*.tsx`, `*.vue`, `*.css`, `components/` | `references/code-checklist.md` |
| 8 | **Configuration** | `*.yaml`, `*.json`, `*.toml`, `*.env*` | `references/content-checklist.md` |
| 9 | **Code** (default) | `*.py`, `*.ts`, `*.go`, `*.java`, `src/` | `references/code-checklist.md` |

5. **Locate the originating spec** for the spec axis, in order: issues/PRDs linked from PR description or commits; a spec path the user passed; a PRD/spec/OpenSpec change under `docs/`, `specs/`, or `openspec/` matching the branch/feature name. If nothing turns up, ask once; if there is no spec, skip the spec axis and say so. Do not reconstruct an imagined spec from the diff.

> **Canonical-source note**: For `subagent-workflow` Phase 4 (parallel reviewer packs), `reviewer-packages.md` in `risk-adaptive-cross-review` is the canonical checklist source. This skill's per-type checklists serve standalone single-pass reviews.

---

## Phase 2 — Analyze

For each detected content type, read the corresponding reference checklist and apply its dimensions. Principles:

- **Scope to changes only.** Read surrounding code for context, but only comment on what was added or modified. A pre-existing bug in untouched code is not a finding (unless the change makes it worse).
- **Prioritize by impact, not checklist order.** Security and correctness beat style. Go deep on what matters for *this* change.
- **Look beyond code patterns.** For refactoring PRs especially, ask: "Does the new code behave identically in all cases?" Run the behavioral-change checklist in [references/analysis-guides.md](references/analysis-guides.md) (state models, error paths, defaults, timing, API contracts, scope narrowing). Accidental behavioral changes are typically P1.
- **Consistency axis.** When the change set warrants drift analysis (new identifiers/patterns/error handling in an established codebase) — or always in consistency mode — apply the eight entropy dimensions in [references/consistency-checklist.md](references/consistency-checklist.md): naming, error handling, dependency direction, doc sync, state model, pattern duplication, pattern contagion, agent verifiability. Load constraint context (glossary, error model, dependency rules) as described there.
- **Spec axis.** Check missing/partial, unrequested, and implemented-but-wrong against the located spec; quote the spec line per finding.
- **Cross-cutting**: code-doc consistency, missing companions (endpoint without tests, schema change without migration), changelog entries.
- **Calibrate severity.** "Will this cause a real problem if left unfixed?" Duplicated logic that will silently diverge is P2, not P3.
- **Non-findings**: formatter/linter-covered issues, pure style preferences, untouched pre-existing issues, alternate designs without a concrete risk.
- **Deep mode**: add removal inventory, impact analysis (all callers/consumers of changed interfaces), and open questions — procedures in [references/analysis-guides.md](references/analysis-guides.md).

---

## Phase 3 — Synthesize

| Level | Label | Merge gate | When to use |
|---|---|---|---|
| **P0** | 🔴 Critical | Block | Security vuln, data loss, crash, factual error in docs causing harm |
| **P1** | 🟠 High | Should fix | Correctness bug, breaking API change, missing rollback, misleading docs |
| **P2** | 🟡 Medium | Recommended | Design issue, missing tests, incomplete docs; DRY violations with >2 copies, conventions that will confuse consumers |
| **P3** | 🟢 Nit | Optional | Style preference, minor wording that doesn't cause confusion |
| — | 💡 Suggestion / 🎉 Praise | — | Alternative approach / good pattern worth preserving |

Consistency-axis findings use E0–E3 grading with a defined crosswalk into P-severities (E0 → P1 or P0, E1/E2 → P2, E3 → Note) — see [references/consistency-checklist.md](references/consistency-checklist.md). P3/Nit maps to "Note" in the `risk-adaptive-cross-review` finding contract.

**Verdict logic**: ✅ Approve — no P0/P1. ⚠️ Approve with suggestions — no P0; exactly 1 P1 with author aware and a clear fix path. 🔴 Request changes — any P0, or 2+ P1s, or any P1 without a clear fix. Consistency mode verdicts (❌/⚠️/✅ by highest E-grade) are defined in the consistency checklist.

Every P0–P2 finding needs issue, consequence, evidence (file:line), and fix direction. Spec findings report under their own group — never folded into content-type groups. Full templates per mode, the finding protocol, next-step menus, and tone discipline: [references/output-formats.md](references/output-formats.md).

---

## Phase 4 — Act

Review before repair: present findings first; only apply changes when the user explicitly asks or picks a next-step option (menus in [references/output-formats.md](references/output-formats.md)). Code-type fixes are applied directly with behavioral impact explained; PRD/design/API-spec content gets suggested rewrites only — the author decides.

## Escalation Triggers

Flag for senior review instead of resolving yourself: database schema changes, public API contract changes, auth/authz logic, payment/billing/PII processing, new external dependencies, production-affecting infrastructure, architecture decisions with long-term consequences.

## Caveats

- Reviews changes for quality — does not execute tests or run the app
- Large diffs (>50 files) split across multiple passes
- Domain detection is heuristic — tell the reviewer your stack if it gets it wrong
- Read-only by default; fixes in Phase 4 need write permission
- The consistency axis reviews for drift, not correctness; a consistent but logically wrong change still needs the correctness axis
- Generated code and vendored dependencies are excluded from review scope
