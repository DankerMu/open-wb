# Output Formats & Tone

Templates and delivery discipline for Phase 3/4. The severity table and verdict logic live in SKILL.md; this file holds the full templates.

## Finding protocol

Every `P0`, `P1`, and `P2` finding must include:

- **Issue**: what is wrong
- **Consequence**: why it matters
- **Evidence**: file path, line, schema field, config key, or diff hunk
- **Fix direction**: the expected repair direction, not just "please fix"

Questions supplement findings; they do not replace clear findings. Do not report formatter noise, import ordering, or lint-only issues unless they reveal a real behavioral or policy risk.

**Two axes, no masking.** Standards findings and spec-conformance findings answer different questions — "is the code good" vs "is it the right change" — and a change can pass one axis while failing the other. Spec findings get their own `#### Spec conformance` group in the output (never folded into the content-type groups), and the summary names the worst finding per axis. A clean standards pass must not soften a spec miss, or vice versa.

## Quick mode

```
[verdict emoji] [verdict]. [1 sentence summary].

- 🔴 **[title]** (`file:line`): [issue + fix]
- 🟠 **[title]** (`file:line`): [issue + fix]
- ❓ [question, if any — omit if none]
```

## Standard mode

```markdown
## Review: [brief title]

### Summary
[1-2 sentences. What it does, overall assessment.]

**Verdict**: ✅ Approve / ⚠️ Approve with suggestions / 🔴 Request changes
**Risk**: Low / Medium / High | **Files**: N (+X/-Y lines)

---

### Findings

[For mixed PRs, group by content type. Within each group, order by severity.]

#### 🔴 P0 — Critical
> **[Title]** (`path/to/file:line`)
> [Why this matters — not just what's wrong, but the consequence]
> ```diff
> - problematic
> + fixed
> ```

[P1, P2, P3, Suggestions follow same format]

#### 🎉 What Looks Good
- [Acknowledge good patterns, thorough tests, clean design]

### Questions
[Things the reviewer can't determine from the diff alone — where the answer would change the assessment. Skip this section if there are no genuine open questions.]

### Quick Wins
[Top 3-5 high-impact, low-effort fixes]
```

If findings >15, show top 10 and offer to expand.

## Deep mode

Standard format plus:
- **Behavioral Changes**: list each behavioral difference between old and new code, noting whether it is intentional or accidental
- **Removal Inventory**: confirm clean removal of deleted types/functions/modules (no orphaned references)
- Impact analysis section with consumer list
- Summary table: `| Content Type | P0 | P1 | P2 | P3 |`
- Escalation flags (see SKILL.md)

## Phase 4 — next-step menus

Review before repair: present findings first, apply changes only on explicit request.

**Code / Tests / Frontend / Infrastructure / Configuration:**
> 1. 🔧 Fix all — 2. 🔴 Fix critical only — 3. 🎯 Fix specific — 4. ⏭️ Skip

Apply code edits directly. Explain behavioral impact before applying changes.

**Documentation:**
> 1. ✏️ Rewrite flagged sections — 2. 🎯 Rewrite specific — 3. ⏭️ Skip

Rewrite the relevant sections inline.

**PRD / Design Doc / API Spec:**
> 1. 💡 Provide suggested rewrites — 2. ⏭️ Skip

These content types reflect design decisions that belong to the author. Provide concrete rewrite suggestions and explain the reasoning, but don't apply changes directly — the author decides what to adopt.

## Tone

Review is an execution protocol, not a conversation style guide:
- **Be direct, evidence-based, and severity-calibrated.**
- **Explain consequences**, not just rules. "This is vulnerable to injection *because*..." not just "use parameterized queries."
- **Use questions only when missing context blocks confidence.** Do not turn a clear correctness or security issue into a suggestion.
- **Keep praise brief and selective.** Use it only when it helps preserve a strong pattern worth keeping.
- **Separate opinion from requirement.** Style preferences are P3 at most, and often omitted if automation already covers them.
- **Show, don't just tell.** Every non-trivial finding gets a concrete before/after — diff for code, rewritten text for docs.
