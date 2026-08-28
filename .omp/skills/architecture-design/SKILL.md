---
name: architecture-design
description: Design a new project's architecture — module decomposition, seams, and directory structure — or audit an existing one for refactoring recommendations, recording load-bearing decisions as ADRs.
disable-model-invocation: true
version: 0.1.0
---

# Architecture Design

Design the **shape of a system** top-down — the whole before the parts. Two modes: **greenfield** (a new project or subsystem: decompose it into modules, decide the seams between them, lay out the directory structure) and **brownfield** (an existing project: audit its structure, dependencies, and patterns, and hand back prioritized refactoring recommendations). In both modes, load-bearing decisions are recorded as ADRs so they survive into implementation.

This skill is self-contained: the vocabulary, patterns, and disciplines it needs are distilled into its `references/` folder. Read each reference at the step that needs it — don't front-load them.

## Process

### 0. Mode

Ask one question: is this a **new** project, an **existing** project, or a **redesign** (an existing project with a target architecture)? For a redesign, run the brownfield audit first, then design against its findings.

### 1. Grounding

Read `CONTEXT.md` and `docs/adr/` for the domain language and the decisions you must not re-litigate, and `AGENTS.md`/`CLAUDE.md` for constraints. In brownfield mode, also read the code around the user's named scope. Facts are the agent's job: dispatch sub-agents for exploration — never ask the user for anything you can look up yourself.

### 2. Interview

Work the design tree in rounds using the interview protocol in the `/grill-me` skill (design tree, frontier, question format). Seed the tree with the architecture decision categories:

- **Goals** — what problem, success criteria, must-haves and must-not-haves
- **Constraints** — scale, performance, team size, timeline, deployment targets, existing stack; in brownfield, the surfaces that must not change
- **Boundaries** — in/out of scope, external systems, entry points (API, CLI, UI, events)
- **Decomposition** — candidate modules, interfaces between them, dependency direction, data flow
- **Directory structure** — which pattern, per the complexity ladder in `ddd-layers.md`
- **Tech choices** — only where unsettled; default to boring

Settle the frontier until it is empty, and don't act until the user confirms shared understanding.

**The frontier is a lock.** While any frontier question is unanswered, your entire output is the questions: no files, no documents, no ADRs, no scaffolds, no `CONTEXT.md` edits — nothing written anywhere. A document produced before the user answers is a decision made on the user's behalf. Only when the frontier is empty AND the user has confirmed shared understanding do you proceed to decomposition and writing.

### 3. Greenfield: decompose

Read `references/deep-modules.md` and `references/ddd-layers.md`. Produce the **module map**:

- Each module with its **interface** — everything a caller must know — and what sits behind its **seam**
- Why each module is **deep** — apply the deletion test to the candidate boundaries
- Dependency direction between modules; data flow across them

Then the **directory structure**: a concrete folder tree following the complexity ladder. For a load-bearing interface worth exploring, run the design-it-twice pattern from `deep-modules.md` (3+ parallel sub-agents, radically different interfaces, then an opinionated recommendation).

### 3'. Brownfield: audit

Read `references/survey.md` and `references/ddd-layers.md`. Send sub-agents to survey the scope: hot spots from `git log --oneline`, module structure, dependency direction, untested areas, and where code names drift from `CONTEXT.md` terms.

Then work the five lenses from `survey.md` — depth/shallowness, directory structure vs the complexity ladder, dependency direction and seams, DDD anti-patterns, duplication and dead code — and prioritize what you find. Every finding carries **what, why, effort (low/medium/high)**, written in the project's domain language.

### 4. Record decisions

Read `references/adr-discipline.md`. Record decisions that meet all three ADR criteria (hard to reverse, surprising without context, a real trade-off) as ADRs **as they settle** — don't batch them at the end. Sharpen new domain terms in `CONTEXT.md` inline as they appear (the docs mode of `/grill-me`).

### 5. Write the document

Ask the user for a scope name (recommended: `docs/architecture/<scope>.md` — any path they choose is fine), then write the architecture document.

Greenfield sections, in order: **Scope & goals / Constraints / Module map / Dependency rules / Directory structure / Data flow / Decisions / Open questions**. The directory structure gets an ASCII tree; use Mermaid for relationship graphs.

Brownfield sections, in order: **Current state / Findings by lens / Recommendations / Decisions / Open questions**.

This document is the deliverable — it feeds the build flow next.

### 6. Hand off

Prose pointers, to the human:

- Greenfield → next run `/to-spec` with this document.
- Huge or foggy effort, too big for one session → use `/implementation-planning` instead.
- Brownfield, once a candidate is picked → run `/improve-codebase-architecture` for the deepening deep-dive, then `/to-spec`.

## Boundaries — not this skill

- A single module's interface → the `codebase-design` skill.
- A deepening survey with an HTML report → `improve-codebase-architecture`.
- A huge foggy multi-session effort → `implementation-planning`.
- Already have a spec → `to-spec`.
- Validating a design question with throwaway code → `prototype`.
