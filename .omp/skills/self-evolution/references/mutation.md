# Layered Mutation Strategy

## Contents
- Why Layers
- Three Layers (universal definition + per-artifact-type mapping)
- Cross-Layer Rules
- Priority Ladder
- Evidence-Based Mutation Protocol

## Why Layers

Not all mutations are equal. Changing a keyword is cheap and low-risk. Restructuring architecture is expensive and high-risk. Start with the cheapest changes, escalate only when cheaper options are exhausted.

Analogous to learning rate schedules — large cheap adjustments first, then expensive fine-tuning.

## Three Layers

### Layer 1 — Surface

The cheapest, lowest-risk changes. Metadata, naming, formatting, shallow content.

| Artifact Type | What You CAN Change | What You CANNOT Change |
|--------------|--------------------|-----------------------|
| Prompt | Phrasing, keyword choices, formatting, examples order | Core instructions, logic flow |
| Skill | Frontmatter description, trigger keywords, first section | SKILL.md body, references, scripts |
| Code | Variable names, constants, config values, comments, formatting | Function logic, algorithms, architecture |
| Idea | Title, framing, word choice, section order | Arguments, evidence, conclusions |
| Config | Individual values, feature flags | Structure, key names, dependencies |
| Experiment | Run tag, description, metric parser wording, hyperparameters/constants | Benchmark harness, metric direction, forbidden scope |
| Harness | **Contracts** — what information each step passes to the next | Hops, roles, instructions |

**When exhausted:** K consecutive discards (default K=3). Surface quality is already good — problems lie deeper.

Note that `harness` inverts the usual ordering — see "Why Harness Layers Are Inverted" below.

### Layer 2 — Core Content

The primary logic and substance. Medium cost, medium risk.

| Artifact Type | What You CAN Change | What You CANNOT Change |
|--------------|--------------------|-----------------------|
| Prompt | Instructions, decision logic, examples, constraints, output format | External references, helper scripts |
| Skill | SKILL.md instruction body, decision trees, routing, format specs | Reference files, scripts |
| Code | Function implementations, algorithm logic, control flow, error handling | Module boundaries, public interfaces, external dependencies |
| Idea | Arguments, evidence, logical structure, supporting data | Fundamental premise (unless explicitly allowed) |
| Config | Structural reorganization, adding/removing sections | External schema requirements |
| Experiment | Algorithm choices, training loop behavior, optimizer/scheduler logic inside editable scope | Evaluation harness, data path, metric parser, dependencies |
| Harness | **Hops** — the interaction structure and workflow step logic | Roles, instructions |

**When exhausted:** K consecutive discards. Core is solid — problems are in supporting infrastructure.

### Layer 3 — Architecture

The most expensive, highest-risk changes. Supporting materials, structure, dependencies.

| Artifact Type | What You CAN Change | Everything |
|--------------|--------------------|-|
| Prompt | Split into sub-prompts, add chain-of-thought scaffolding, restructure entirely | |
| Skill | Reference files, scripts, add new supporting files | |
| Code | Module structure, interfaces, dependencies, add helper modules | |
| Idea | Fundamental framing, target audience, core premise | |
| Config | Schema changes, migration to different format | |
| Experiment | Architecture changes inside editable scope, helper modules allowed by contract | |
| Harness | **Roles and instructions** — who the agents are and what each is told to do | |

**When exhausted:** Evolution is complete. All layers have been tried.

## Why Harness Layers Are Inverted

For every other artifact type, Layer 1 is the cheapest surface: phrasing, naming, formatting. For `harness` artifacts — multi-step agent loops, sub-agent workflows, orchestrator pipelines — Layer 1 is the information contract between steps, and role and instruction wording is pushed all the way to Layer 3.

The reasoning, from two independent sources that converge:

- RHI (Lee et al., arXiv 2607.15524) decomposes a harness into agent design (roles, instructions) and agent workflow (contracts, hops), and prioritizes workflow. Their component analysis found contracts stabilize earliest across iterations and cluster most sharply by task, while roles change slowest and separate least.
- Lilian Weng's harness-engineering ladder orders optimization targets as: instruction prompts → structured context → workflow → harness code → optimizer code, with the leverage increasing along the ladder.

The mechanism both point at: a task-specific contract states exactly which information needs to cross each boundary, so downstream steps stop dragging the whole interaction history. That is a sparsity pattern imposed on information flow — the default "everyone sees everything" is dense attention, and a tight contract is the sparse version. It cuts redundant context propagation, improves cache hit rates, and lowers cost. RHI attributes its up-to-60% inference cost reduction to this, not to shorter reasoning.

**This ordering is a hypothesis, not a measured law.** RHI states its component analysis is correlational rather than causal, and notes that contracts and hops may look prominent partly because the harness optimizer's own system prompt emphasized them. Adopt the ordering; abandon it if three consecutive contract-layer mutations produce nothing on your artifact.

## Mutation Families

Independent of layer, these are the recurring shapes a mutation takes. Naming them makes Phase 1's "which patterns succeeded" question answerable.

| Family | What it does | Where it pays off |
|---|---|---|
| Disambiguation | Adds a rule that resolves an input the artifact currently handles inconsistently | Prompts, skills, routing |
| Constraint tightening | Narrows what the artifact is permitted to output | Any type with format failures |
| Context compression | Cuts what gets carried forward without cutting what gets used | Harness, prompt, agent loops |
| Contract sparsification | Restricts what one step passes to the next to what the next actually needs | Harness |
| Decomposition | Splits one overloaded step into two with a defined boundary | Harness, prompt |
| Deletion | Removes content and checks the metric holds | Every type |

**Context compression deserves specific attention** because it is the family this skill historically never proposed. AIDE² compressed its full prompt 16× against naive history concatenation and improved. Wang et al. observed the opposite failure in harness-evolution runs they studied: the meta-agent's edits mostly memorized fixes rather than distilling strategies, and the growing volume of persistent prompt text introduced context bloat that offset the remaining gains.

That is a warning about this loop's own default behavior. Mutations that add text are easy to propose and easy to justify; mutations that remove text feel like losing ground. The accumulated result is an artifact that is longer every iteration and better only sometimes.

## Cross-Layer Rules

1. **Start at Layer 1, progress sequentially.** Can override starting layer in evolve_plan.md when baseline analysis shows a layer is irrelevant. Once chosen, exhaust current layer before promoting.
2. **Never cross layers in one iteration.** If at Layer 2, don't also change architecture. Split into two iterations.
3. **Layer promotion requires L3 evaluation.** Checkpoint holdout performance before moving up.
4. **Layer demotion is allowed.** If at Layer 3 you realize a Layer 1 fix would help, drop back — but stay within the demoted layer's scope.

## Priority Ladder

Regardless of layer, follow this order for choosing WHAT to change:

### Priority 1 — Fix Crashes
Cases that error out instead of producing output. A crash yields zero diagnostic information.

### Priority 2 — Exploit Success Patterns
If mutation type X worked on case A, try the same pattern on case B. Disambiguation hints that fixed case-12 may fix case-17 too.

### Priority 3 — Attack Persistent Failures
Cases failing 3+ consecutive iterations. Review their traces carefully — the pattern of failure often reveals a systematic issue.

### Priority 4 — Explore New Directions
Try a mutation type not yet attempted. Prevents getting stuck in a local optimum.

### Priority 5 — Simplify
Remove content that isn't contributing. Shorter artifacts often perform better — less instruction means less confusion. Check if removing a section maintains pass_rate.

**Simplify is on a schedule, not a fallback.** Run at least one deletion mutation every 5 iterations regardless of where the loop is on this ladder. Waiting until everything passes means never running it, because a loop that only adds text on the way up arrives at its ceiling already bloated. A deletion that ties on the metric is a KEEP under Dimension 2's tie rule.

### Priority 6 — Aggressive Mutation
Only after 5+ consecutive discards. Restructure a section, change the approach, try a fundamentally different strategy. High risk, necessary when incremental changes stall.

## Evidence-Based Mutation Protocol

Every mutation proposal MUST include:

1. **Target case(s):** Which specific cases this mutation aims to fix
2. **Trace evidence:** Specific content from the trace showing WHY the case failed
3. **Falsifiable prediction:** "If I change X, case-12 and case-17 flip to PASS and case-03 is unaffected" — stated precisely enough that the L2 results can prove it wrong
4. **Mutation family:** Which row of the family table above, so Phase 1 can aggregate
5. **Risk assessment:** Which currently-passing cases might be affected

This prevents "vibe-based" mutations — changes made because they "feel right" rather than because evidence supports them.

**The prediction is written to the ledger and scored afterwards.** Phase 7 records `predicted_effect` and, once L2 has run, `prediction_correct`. This is Weng's decision-observability principle: every edit is paired with a falsifiable prediction so it can be checked later.

The value is not in any single prediction. It is that after twenty iterations, `experiments.jsonl` answers a question the loop otherwise cannot ask — which mutation families it is systematically wrong about. A family with a high KEEP rate and a low prediction-correct rate is being kept for reasons the loop does not understand, which is the signature of the metric drifting rather than the artifact improving. Score the prediction against observed results independent of the KEEP/DISCARD decision; a mutation can be kept for the wrong reason, and that is precisely what this field exists to catch.

The trace is the diagnostic tool. Don't summarize — read the raw trace. The difference between correct and incorrect behavior is often one sentence, one condition, one example.
