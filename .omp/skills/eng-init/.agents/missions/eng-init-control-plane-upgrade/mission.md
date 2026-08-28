# Mission: eng-init Agent Control Plane Upgrade

## Goal
Implement `/Users/chenwenjie/.agents/skills/eng-init/eng-init-control-plane-upgrade.spec.md` so `eng-init` becomes an Agent Engineering Readiness Control Plane skill with first-class Audit, Initialize, Repair, and Refactor Harness pipelines.

## Scope
Allowed edits:
- `/Users/chenwenjie/.agents/skills/eng-init/SKILL.md`
- `/Users/chenwenjie/.agents/skills/eng-init/references/agent-readiness-criteria.md`
- `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-fix-recipes.md`
- optional `/Users/chenwenjie/.agents/skills/eng-init/references/readiness-report-contract.md`
- `/Users/chenwenjie/.agents/skills/eng-init/evals/cases.md`
- minor template reference updates only if needed by the spec

## Non-goals
No skill rename. No Droid prompt dump. No full YAML/JSON registry migration. No global config changes. No destructive writes to `/Users/chenwenjie/workspaces/swe-agent`.

## Execution policy
Implementation WorkUnits must be performed by worker subagents. Review and validation must be fresh independent sessions. Orchestrator owns planning, evidence, and final gate.
