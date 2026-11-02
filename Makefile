# open-workbuddy 唯一命令面。所有工作流经此路由；AGENTS.md 验证矩阵与 constraints.yaml
# verification 段是它的镜像，增删目标须三处同步。omp-fetch 是官方 v18.12.3 二进制供给前置，
# smoke-live 是调用方拥有的真实上游手动验证；
# smoke-kb 是调用方拥有服务与共用 RAGFlow 栈的真实知识库手动验证；
# 控制面文档行与 Makefile 目标同步。
SHELL := /bin/bash
.PHONY: setup hooks lint fmt typecheck test anti-drift guard check test-guardrails precommit dev smoke smoke-live smoke-kb ui-walk omp-fetch

setup: ## 安装依赖 + 挂 git hooks
	npm install
	$(MAKE) hooks
	@command -v gitleaks >/dev/null || echo "提示: brew install gitleaks 可启用本地密钥扫描（CI 恒定扫描）"

hooks:
	git config core.hooksPath .githooks

lint: ## Biome，格式与复杂度≤15 皆在此
	npx biome check server web scripts converter vitest.shared.mjs

fmt:
	npx biome check --write server web scripts converter vitest.shared.mjs

typecheck:
	npm run typecheck --workspaces

test: ## 单元测试 + 覆盖率≥80% 门禁（vitest fail-under）
	npm test --workspaces

anti-drift: ## 死代码(knip) + 重复代码(jscpd≤3%) + 命名/行数守卫全量扫描
	npx knip
	npx jscpd --config .jscpd.json
	bash scripts/naming-guard.sh $$(git ls-files 'server/**' 'web/**' 'scripts/**')
	bash scripts/size-guard.sh

guard: ## 仅自研守卫（pre-commit 用）
	bash scripts/naming-guard.sh
	bash scripts/size-guard.sh

check: lint typecheck test anti-drift ## 全链验证，推送前必绿

test-guardrails: ## 守卫自证：每条 guard 对注入违例必须报错
	bash scripts/test-guardrails.sh

dev: ## 唯一启动转发边：同一 workspace start owner（Issue #7）
	npm run start --workspace server

SMOKE_BASE_URL ?= http://127.0.0.1:3000
# 两步传递：先以 $(value) 把 Make 侧值冻结成 raw 字面（默认值/环境/普通 = 赋值均保持原样，
# 包括其中的 $(shell ...) 字节），再 export 进 recipe 环境；配方只在 shell 侧做一次
# 带引号的参数展开，shell 不把其内容当语法重解析。
override SMOKE_BASE_URL := $(value SMOKE_BASE_URL)
export SMOKE_BASE_URL
# 工具发现只发生在受控子进程内，且绝不把发现出的路径字节写回 recipe 文本：
# 预检与调用都以字面 `hurl` 交给 /usr/bin/env 经 PATH 定位（env -i 只带 PATH，
# 函数/别名/HURL 变量不进子进程），shell 不重新解析 PATH 组件——注入的引号/分号
# 等字节只会成为路径的一部分，不会变成 shell 语法。
# 调用方在启动服务前自行：cp -R smoke/fixtures/sandbox/u1 <SANDBOX_ROOT>/
# Make 不预置夹具、不 start/stop 服务。
smoke: ## Hurl HTTP 冒烟（只消费已运行服务；缺 hurl 显式失败并打印安装指引 https://hurl.dev/docs/installation.html）
	@/usr/bin/env -i PATH="$$PATH" /bin/sh -c 'command -v hurl >/dev/null 2>&1' || { echo "错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html" >&2; exit 1; }
	/usr/bin/env -i PATH="$$PATH" hurl --test --jobs 1 --retry 0 --variable "base_url=$${SMOKE_BASE_URL}" --variable "content_pattern=^你好，这是 WorkBuddy 的第一条流式回复。$$" --variable "min_bash_steps=1" --variable "skip_turn_control=false" smoke/public.hurl smoke/auth.hurl smoke/chat.hurl smoke/files.hurl smoke/session-meta.hurl

UI_WALK_BASE_URL ?= http://127.0.0.1:3000
# 与 smoke 相同：$(value) 冻结成 raw 字面后 export；配方不把该值插进 shell 语法。
override UI_WALK_BASE_URL := $(value UI_WALK_BASE_URL)
export UI_WALK_BASE_URL
ui-walk: ## Playwright UI 走查（只消费已运行服务；不 build/start/stop/install）
	npm run ui-walk --workspace web

omp-fetch: ## 拉取官方 omp v18.12.3 到 var/omp/omp（SHA256 校验；已校验则跳过）
	bash scripts/omp-fetch.sh

ifneq ($(origin MODEL_UPSTREAM_BASE_URL),undefined)
override MODEL_UPSTREAM_BASE_URL := $(value MODEL_UPSTREAM_BASE_URL)
export MODEL_UPSTREAM_BASE_URL
endif
ifneq ($(origin MODEL_UPSTREAM_API_KEY),undefined)
override MODEL_UPSTREAM_API_KEY := $(value MODEL_UPSTREAM_API_KEY)
export MODEL_UPSTREAM_API_KEY
endif
smoke-live: ## 手动真实上游冒烟（只消费已运行服务；缺配置先失败；缺 hurl 显式失败并打印安装指引 https://hurl.dev/docs/installation.html）
	@[ -n "$${MODEL_UPSTREAM_BASE_URL}" ] || { echo "错误：未设置 MODEL_UPSTREAM_BASE_URL" >&2; exit 1; }
	@[ -n "$${MODEL_UPSTREAM_API_KEY}" ] || { echo "错误：未设置 MODEL_UPSTREAM_API_KEY" >&2; exit 1; }
	@/usr/bin/env -i PATH="$$PATH" /bin/sh -c 'command -v hurl >/dev/null 2>&1' || { echo "错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html" >&2; exit 1; }
	/usr/bin/env -i PATH="$$PATH" hurl --test --jobs 1 --retry 0 --variable "base_url=$${SMOKE_BASE_URL}" --variable "content_pattern=(?s)^.+$$" --variable "min_bash_steps=0" --variable "skip_turn_control=true" smoke/chat.hurl

precommit: guard

# smoke-kb 只消费调用方已运行、已接上共用 RAGFlow 栈的服务（SMOKE_BASE_URL 同 smoke；登录同 smoke/chat.hurl）。
# 前提：调用方已按 smoke/fixtures/README.md 把 smoke/fixtures/sandbox/u1 复制到该服务的 SANDBOX_ROOT/u1，本目标不替它复制。
# 前置检测都在任何知识库请求之前：RAGFLOW_BASE_URL 只从调用方 shell 环境读，未设置即停；再确认 node 带 fetch（Node 18+），
# 免得缺 node 被误报成栈未运行；最后请求它的版本接口，
# 判据同服务端（server/src/kb/ragflow-client.ts 的 version() 与 server/src/kb/rest.ts 的 PINNED_VERSION）：
# GET /api/v1/system/version，不带密钥（所以不读 RAGFLOW_API_KEY_FILE），总期限 5 s，不跟随重定向，
# 2xx 且 code 为 0、data 为 v1.0.0-rc2 才放行。本目标不启动、不停止、不配置任何 RAGFlow 容器。
# 轮询上限 SMOKE_KB_POLL_SECONDS（缺省 300）只在 shell 侧读，按 5 s 一次折成 hurl 的重试次数，每段轮询各自计时。
# smoke/kb-cleanup.hurl 在 kb.hurl 之前与它失败之后各跑一次；清理的失败不改变退出码。
smoke-kb: ## 手动真实 RAGFlow 冒烟（只消费已接上共用 RAGFlow 栈的已运行服务；缺 RAGFLOW_BASE_URL 或栈不对先失败；缺 hurl 显式失败并打印安装指引 https://hurl.dev/docs/installation.html）
	@[ -n "$${RAGFLOW_BASE_URL}" ] || { echo "错误：RAGFlow 私有配置缺失（未设置 RAGFLOW_BASE_URL）" >&2; exit 1; }
	@/usr/bin/env -i PATH="$$PATH" node -e 'process.exit(typeof fetch==="function"&&typeof AbortSignal.timeout==="function"?0:1)' >/dev/null 2>&1 || { echo "错误：未找到 Node 18+（版本检测需要 fetch）" >&2; exit 1; }
	@/usr/bin/env -i PATH="$$PATH" node -e '(async()=>{const r=await fetch(new URL("/api/v1/system/version",process.argv[1]),{redirect:"manual",signal:AbortSignal.timeout(5000)});if(r.status<200||r.status>299)return false;const b=await r.json();return b!==null&&typeof b==="object"&&b.code===0&&b.data==="v1.0.0-rc2"})().then((ok)=>process.exit(ok?0:1),()=>process.exit(1))' "$${RAGFLOW_BASE_URL}" || { echo "错误：共用 RAGFlow 栈未运行或版本不符" >&2; exit 1; }
	@case "$${SMOKE_KB_POLL_SECONDS:-300}" in ""|0*|*[!0-9]*) echo "错误：SMOKE_KB_POLL_SECONDS 须为正整数" >&2; exit 1 ;; esac
	@/usr/bin/env -i PATH="$$PATH" /bin/sh -c 'command -v hurl >/dev/null 2>&1' || { echo "错误：未找到 hurl；安装说明：https://hurl.dev/docs/installation.html" >&2; exit 1; }
	/usr/bin/env -i PATH="$$PATH" hurl --test --jobs 1 --retry 0 --variable "base_url=$${SMOKE_BASE_URL}" smoke/kb-cleanup.hurl || echo "提示：冒烟前的清理没有完成，继续" >&2
	/usr/bin/env -i PATH="$$PATH" hurl --test --jobs 1 --retry 0 --variable "base_url=$${SMOKE_BASE_URL}" --variable "poll_retries=$$(( ($${SMOKE_KB_POLL_SECONDS:-300} + 4) / 5 ))" smoke/kb.hurl || { rc=$$?; /usr/bin/env -i PATH="$$PATH" hurl --test --jobs 1 --retry 0 --variable "base_url=$${SMOKE_BASE_URL}" smoke/kb-cleanup.hurl || echo "提示：失败后的清理没有完成" >&2; exit $$rc; }
