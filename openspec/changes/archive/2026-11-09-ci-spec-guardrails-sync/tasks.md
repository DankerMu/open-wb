# Tasks: ci-spec-guardrails-sync

## 1. 规格计数与 CI 实际一致

- [x] 1.1 改写三个 MODIFIED requirement 中的计数、job 清单与 Enforcement Index 描述（proposal What Changes）。
- [x] 1.2 验证：
  - 先归档本 change。
  - `git grep -nE '十一个 direct|eleven direct|11 ?/ ?9|九个 setup-node|十一项 aggregate|共十二个 job' -- openspec/specs` 无结果。
  - `npx openspec validate --all --strict --no-interactive` 退出 0。
  - `make test-guardrails` 全 PASS。
  - `git diff --stat origin/master -- .github scripts AGENTS.md constraints.yaml` 为空。
