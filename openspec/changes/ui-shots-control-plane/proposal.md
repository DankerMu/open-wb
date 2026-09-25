# Proposal: ui-shots-control-plane（#298）

## Why
父 change `s1e-frontend-parity` tasks 6.3b。#297 已交付 `web/e2e/ui-shots.mjs` 与 `npm run ui-shots --workspace web`，但仓库唯一命令面 `Makefile` 与其两份镜像（`AGENTS.md` Verification Matrix/Enforcement Index、`constraints.yaml verification.surfaces`）还不知道这个手动 surface；source-derived oracle `scripts/test-ci-harness.sh` 把这三处与受保护 Make targets 锁死，四处必须原子一刀，否则 `make test-guardrails` 红。

## What Changes
- `Makefile`：页头职责句加 ui-shots；`.PHONY` 加 `ui-shots`；`UI_SHOTS_BASE_URL` 三行冻结（`?=` 缺省 `http://127.0.0.1:3000` + `override … := $(value …)` + `export`）；`UI_SHOTS_OUT` 不设缺省、`override … := $(value …)` 冻结后 export（相对父 spec「只 export」的有意偏离，理由见 design D3）；目标 `ui-shots:` 配方 `npm run --silent ui-shots --workspace web`。
- `AGENTS.md`：Verification Matrix 与 Enforcement Index 各增一行（逐字见 spec）。
- `constraints.yaml`：`verification.surfaces` 增第十一条 `ui-shots`（`make ui-shots` / evidence / `required_at: "manual"`）。
- `scripts/test-ci-harness.sh`：AGENTS 行期望 +2、surfaces 元组 +1、受保护目标集 +1、`safe_overrides` +3 项（`UI_SHOTS_BASE_URL ?=`、两条 `override … := $(value …)`）+ ui-shots 变量块五行的存在性/顺序精确检查、`recipes("ui-shots", …)`、`.PHONY` 整行锚点；新增 `ui-shots :` spaced duplicate/redefinition 与各新镜像行篡改的 mutation 用例。

## Non-goals
- `web/**`（脚本已在 #297 交付）；CI workflow（不新增 job/action，四 action 白名单不变）；验收清单（6.4 #301）。
- 不为 ui-shots 提供起服务的一体化入口（调用方拥有服务，与 smoke/ui-walk 同）。

## Capabilities
- MODIFIED `verification-harness`「CI 接线与控制面同步」：整段取父 delta（十一 surfaces、五 targets、ui-shots review-only、CI 不新增 job/action）。
- MODIFIED `demo-parity-acceptance`「ui-shots 截图对产物」：补 `make ui-shots` 入口与配方。
- ADDED `demo-parity-acceptance`「控制面同步」：父 delta 原文，两处修订——AGENTS 行按兄弟行统一 `） |` 空格；`UI_SHOTS_OUT` 由「只 export」改为冻结后 export、`safe_overrides` 表述改为三项白名单 + 五行存在性检查。

## Impact
- Error handling：脚本 exit 0 时 `make ui-shots` exit 0；脚本非零时 Make 以失败码退出（GNU Make 为 2）；服务不可达/浏览器缺失时非零（脚本行为不变）。
- 回滚：四文件一次 revert。
