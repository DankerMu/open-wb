# open-workbuddy 唯一命令面。所有工作流经此路由；AGENTS.md 验证矩阵与 constraints.yaml
# verification 段是它的镜像，增删目标须三处同步。
SHELL := /bin/bash
.PHONY: setup hooks lint fmt typecheck test anti-drift guard check test-guardrails precommit

setup: ## 安装依赖 + 挂 git hooks
	npm install
	cd kbservice && uv sync
	$(MAKE) hooks
	@command -v gitleaks >/dev/null || echo "提示: brew install gitleaks 可启用本地密钥扫描（CI 恒定扫描）"

hooks:
	git config core.hooksPath .githooks

lint: ## Biome(TS) + Ruff(Py)，格式与复杂度≤15 皆在此
	npx biome check server web scripts vitest.shared.ts
	cd kbservice && uv run ruff check . && uv run ruff format --check .

fmt:
	npx biome check --write server web scripts vitest.shared.ts
	cd kbservice && uv run ruff check --fix . && uv run ruff format .

typecheck:
	npm run typecheck --workspaces

test: ## 单元测试 + 覆盖率≥80% 门禁（vitest/pytest 各自 fail-under）
	npm test --workspaces
	cd kbservice && uv run pytest

anti-drift: ## 死代码(knip) + 重复代码(jscpd≤3%) + 命名/行数守卫全量扫描
	npx knip
	npx jscpd --config .jscpd.json
	bash scripts/naming-guard.sh $$(git ls-files 'server/**' 'web/**' 'kbservice/**' 'scripts/**')
	bash scripts/size-guard.sh

guard: ## 仅自研守卫（pre-commit 用）
	bash scripts/naming-guard.sh
	bash scripts/size-guard.sh

check: lint typecheck test anti-drift ## 全链验证，推送前必绿

test-guardrails: ## 守卫自证：每条 guard 对注入违例必须报错
	bash scripts/test-guardrails.sh

precommit: guard
