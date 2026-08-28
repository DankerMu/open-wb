# Validation Contract

## Area: Skill Control Plane Upgrade

### VAL-SKILL-001: SKILL.md defines control-plane routing
`/Users/chenwenjie/.agents/skills/eng-init/SKILL.md` presents eng-init as a repo-local Agent Engineering Readiness Control Plane skill, states AGENTS.md is the hot-path interface rather than the whole deliverable, and defines Audit / Initialize / Repair / Refactor Harness routing.
Surface: cli
Tool: file inspection
Evidence: file-path, excerpt, exit-code
RequiredStrength: fixture

### VAL-REPORT-001: Readiness report contract drives repair
The readiness criteria/report reference defines application discovery before scoring, denominator stability, previous-report behavior, configured-but-not-blocking partial credit, control-plane summary, constraint-dimension audit, priority actions, and repair-usable output.
Surface: cli
Tool: file inspection
Evidence: file-path, excerpt, exit-code
RequiredStrength: fixture

### VAL-REPAIR-001: Repair recipes prevent fake fixes
`/Users/chenwenjie/.agents/skills/eng-init/references/readiness-fix-recipes.md` exists and defines universal repair rules, fixability classes, recipe schema, validators, rescore evidence, and initial high-value criterion recipes.
Surface: cli
Tool: file inspection
Evidence: file-path, excerpt, exit-code
RequiredStrength: fixture

### VAL-EVAL-001: Regression eval coverage exists
`/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md` includes new observable cases for existing-report signal repair, no-report direct signal repair, all-passing noop, monorepo denominator stability, and metric-gaming rejection without deleting or weakening existing cases.
Surface: cli
Tool: file inspection
Evidence: file-path, excerpt, exit-code
RequiredStrength: fixture

### VAL-REVIEW-001: Independent review and remediation complete
A fresh independent reviewer inspects changed files against the spec; every finding is fixed, dismissed with rationale, or escalated with exact blocker.
Surface: cli
Tool: review handoff
Evidence: review-output, disposition-table, exit-code
RequiredStrength: fixture

### VAL-EVOLVE-001: Self-evolution pass completes
A bounded self-evolution pass evaluates the upgraded skill against the spec/eval oracle, records weaknesses, mutations, keep/discard decisions, and final rationale.
Surface: cli
Tool: self-evolution log
Evidence: evolution-output, file-path, exit-code
RequiredStrength: fixture

### VAL-SWE-001: swe-agent real-project test completes
The upgraded skill behavior is exercised against `/Users/chenwenjie/workspaces/swe-agent` in a read-only audit/spec-preview style test, with raw evidence and any feedback folded back into the skill or recorded as a gap.
Surface: cli
Tool: file inspection / agent transcript
Evidence: command, stdout, stderr, exit-code
RequiredStrength: fixture
