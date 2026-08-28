---
name: to-spec
disable-model-invocation: true
description: Turn conversation context, repo facts, or a feature idea into a compact PRD plus execution spec by default, with independently-grabbable issue slices when requested, or a questionnaire for someone else to fill in. Use when the user asks for a PRD, feature spec, implementation spec, mission handoff, issue breakdown, task slicing, a questionnaire, or to convert requirements into agent-ready work.
version: 0.1.0
---

# To Spec

Turn intent into an executable source of truth. Default output is **compact PRD + execution spec**. Add issue slices when the user asks for tickets, task breakdown, mission intake, or “turn this into work.”

Core rule: **clarity before ceremony**. Ask only blocking questions. If the answer can be safely inferred, record it as an assumption and continue. Judge task granularity before declaring slices ready.

## Inputs

Use existing context first:
- Conversation constraints and decisions.
- Project memory: `AGENTS.md`, `CONTEXT.md`, ADRs, manifests, existing specs/issues.
- Relevant source/tests only when needed to name real seams or validators.
- Issue tracker labels/templates only when publishing issues.

Do not perform broad archaeology. Do not fabricate commands, owners, or labels.

## Mode Selection

- **Default / PRD / spec** → compact PRD + execution spec.
- **Issues / tickets / task breakdown** → PRD + execution spec + vertical issue slices.
- **Mission handoff / agent-ready work** → PRD + execution spec + issue slices with validation evidence expectations.
- **Questionnaire** → a discovery questionnaire for one external person who holds knowledge you need (see [Questionnaire Mode](#questionnaire-mode)).
- **Only PRD** or **only spec** → produce the requested single artifact only when the user explicitly says “only.”

## Process

### 1. Converge

Restate load-bearing facts:

```text
Goal:
Non-goals:
Users / actors:
Constraints:
Known context:
Assumptions:
Blocking questions:
```

Uncertainty types:
- **Blocking question** — cannot produce an executable spec without it.
- **Assumption** — safe default; record and proceed.
- **Deferred detail** — not needed for this spec/slice.

Ask the smallest useful batch only when blockers remain.

### 2. Choose Verification Seams

Name proof before tasks. Prefer the highest existing seam:

1. User-visible flow: browser, CLI, API, mobile automation.
2. Service boundary: handler, command, job, callback, event subscriber.
3. Domain boundary: aggregate, use case, state transition.
4. Lower seams only when higher seams are unavailable or too slow.

Unknown validators are written as `TBD - infer from project manifests during implementation`.

### 3. PRD Output

Use for product intent and user-visible behavior.

```markdown
## Problem Statement
## Goals
## Non-goals
## Users / Actors
## User Stories
1. As a <actor>, I want <capability>, so that <benefit>.
## Functional Requirements
- FR-001: ...
## Acceptance Criteria
- AC-001: ...
## Edge Cases / Failure Handling
## Constraints
## Out of Scope
```

PRD rules:
- Requirements describe behavior, not implementation guesses.
- Acceptance criteria are testable.
- Non-goals are explicit.
- Vague adjectives get numbers, examples, or deletion.
- Every requirement traces to a goal or user story.

### 4. Spec Output

Use for agent implementation, mission intake, or technical handoff.

```markdown
## Goal
## Scope
### In scope
### Out of scope
## Relevant Context
## Terms / Assumptions
## Affected Surfaces
- Code:
- Data / schema:
- API / CLI / UI:
- Tests:
- Docs / ops:
## Technical Direction
## Validation Plan
- VAL-001: <behavior>, Surface: <ui|api|cli|data|business-flow>, Evidence: <test/log/screenshot/stdout/etc>
## Risks / Open Questions
## Mission Handoff
- Suggested milestones:
- Required evidence:
- Human gates:
```

Spec rules:
- Optimize for execution clarity; keep normal specs compact.
- Preserve user constraints verbatim when paraphrasing weakens a boundary.
- Do not mark ready while build-blocking ambiguity remains.

### 5. Issue Slice Output

Break work into vertical tracer bullets. Each slice proves one behavior through the needed layers.

```markdown
## Issue: <short title>
Type: AFK | HITL
Blocked by: <issue title/id or None>
User stories covered: <ids or summaries>

### What to build
End-to-end behavior, not a layer-by-layer chore list.

### Acceptance criteria
- [ ] ...

### Validation
- Command / scenario:
- Evidence expected:

### Notes
- Constraints, risks, or references.
```

Slice rules:
- Prefer many thin slices over a few thick slices.
- Each slice must be independently demoable or verifiable.
- Mark **HITL** only when a human decision is genuinely required.
- Publish to the issue tracker only when the user asks or workflow requires it.
- Do not close or modify parent issues unless explicitly asked.


### 6. Slice Granularity Check

Before returning issues, judge whether the split is right-sized:

```text
Granularity: Right-sized | Too coarse | Too fine | Blocked
Reason:
Adjustments:
```

Right-sized slices:
- Prove one user-visible or contract-visible behavior.
- Have one clear validation seam and evidence type.
- Are independently mergeable or demoable.
- Avoid horizontal chores like “build database layer” unless that layer is itself the deliverable.
- Are small enough for one focused agent/work unit, but not so small that they cannot be verified alone.

Split a slice when it crosses unrelated user flows, has multiple validation seams, hides a human decision, or cannot state one acceptance outcome.

Merge slices when they are setup-only chores, cannot be validated independently, or create artificial dependencies without reducing risk.

## Questionnaire Mode

When the thing blocking the work isn't in your head or the codebase but in **someone else's**, write them a questionnaire — a Markdown document they fill in async, or together over a meeting. The recipient holds knowledge you lack; the questionnaire pulls it out of them.

**Grill the send, not the subject.** Interview the user only about the _send_, which they can always answer: who it goes to, and what they need back. The questions in the document then target the **gap** between what the recipient knows and what the user needs.

1. **Who is it going to?** Ask, in one exchange, the recipient's role, expertise, and relationship to the user. This fixes the questionnaire's tone and how much context it must carry. Done when you know who the recipient is and what they know that the user doesn't.
2. **What do you need back?** Ask, in one exchange, the specific decisions or facts the user can't resolve alone and needs from this person. Done when you have a concrete list of what the user must walk away able to do or decide.
3. **Write the questionnaire.** Draft questions aimed at the gap from steps 1–2, following the template in [questionnaire-template.md](./questionnaire-template.md). Write it to `to-questionnaire-<slug>.md` in the current directory (slug from the topic) and report the path. Done when the file exists and every item the user named in step 2 is covered by a question.

## Readiness

End with:

```text
Readiness: Ready | Draft | Blocked
Reason:
Next:
```

Use `Ready` only when the artifact names what to build, what not to build, how to verify it, and, when slices are requested, how to split the work without hidden build-blockers.
