# Design evaluator

Evaluate the delivered artifact, not the author's intention. Use browser facts, behavioral evidence, screenshots, and the task-local design contract together.

## Review maturity

Infer the maturity from the request:

- **Concept** — direction, intent, information architecture, content, and visual expression must hold; real backend and production routes are not required.
- **Prototype** — the primary path and important state transitions must be demonstrable with visible feedback.
- **Delivery** — routes, data integration, responsive behavior, accessibility, failure recovery, and production constraints must meet the repository's delivery standard.

Maturity changes release blocking, not what good design means.

## Six dimensions

### Product intent

Check target user, value or outcome, primary task, content tone, and whether the primary action matches the real objective.

### Trust and domain fit

Check terminology, evidence, data context, uncertainty, permissions, risk, sensitive data, consequences, and whether the artifact could plausibly belong to this domain.

### Information architecture

Check hierarchy, grouping, navigation, order, density, reading/scanning path, content growth, and responsive priority.

### Interaction readiness

Check affordances, primary path, state feedback, input validation, transitions, permissions, error recovery, and whether controls connect to the object/state they claim to affect.

### System craft

Check typography, spacing, surface hierarchy, component grammar, semantic tokens, focus, responsive behavior, consistency, and rendered execution.

### Visual and brand expression

Check color, type character, image, composition, motion, originality, and whether expression supports the category and intent rather than masking them.

## Page-shape emphasis

Do not use one weighting profile for every artifact:

- Brand landing: product intent, visual expression, trust.
- Product console: product intent, IA, interaction, trust.
- Data dashboard: IA, trust, system craft.
- Agentic interface: interaction, trust, product intent.
- Content/editorial: IA, trust, typography/system craft.
- Mobile flow: interaction, IA, system craft.
- Deck: product intent, IA, visual expression, legibility.

Use this emphasis to prioritize fixes. Do not invent a precise numerical score unless the evaluation harness supplies calibrated weights.

## Evidence layers

### Deterministic evidence

Inspect markup/runtime facts: asset failures, console errors, overflow, clipped text, duplicate ids, unnamed controls, missing focus, invalid targets, or broken references.

### Behavioral evidence

Exercise the primary path and critical transitions. Verify the artifact responds visibly and preserves coherent state.

### Visual evidence

Inspect target-viewport screenshots for text readability, focal point, composition, density, brand/domain fit, and responsive behavior. When DOM claims and the screenshot conflict, the screenshot represents the user's experience.

### Semantic evidence

Compare visible content and behavior with the task-local intent, states, domain rules, system authority, and acceptance scenarios.

## Blocking findings

Do not deliver with any applicable blocker:

- unclear primary task;
- critical rendering failure or unreadable primary content;
- visual concept blocking product information;
- broken primary task path or dead-end operation;
- disconnected controls, selected object, details, and feedback;
- missing required loading, empty, error, permission, or recovery state;
- wrong domain logic, misleading risk, unsafe action, or mishandled sensitive data;
- untrustworthy AI result; unsupported evidence; unlabeled invented statistics; fake customer proof; fabricated confidence scores or citations; or findings that blur evidence, inference, recommendation, and uncertainty;
- generic template output that could belong to any product;
- inconsistent design system or competing local visual language;
- mobile overflow, inaccessible target size, or platform-breaking navigation;
- deck legibility, scaling, navigation, or slide-count failure;
- missing visual evidence when rendering tools are available.

## Critique record

For each meaningful finding, capture:

```yaml
issue: concrete observable problem
evidence: screenshot region, interaction, DOM/runtime fact, or visible copy
source: spec | domain | shape | components | system | craft | implementation
impact: affected dimension and user consequence
fix: the smallest concrete change that resolves the cause
```

Fix blockers first. Then fix the few highest-impact deductions. Return to the owning phase; do not discard parts that already work.

## Review output

For review-only tasks, lead with findings ordered by severity and cite evidence. For implementation tasks, keep the detailed ledger internal, apply fixes, rerun affected evidence, and report only delivered decisions and real remaining gaps.