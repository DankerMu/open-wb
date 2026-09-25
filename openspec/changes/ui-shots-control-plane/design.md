# Design: ui-shots-control-plane（#298）

Fixture level：expanded（控制面/oracle/Makefile 入口变更；父组 6 声明）。Review priority：mechanical（source-derived oracle 同步）。

Risk packs：Public API / CLI / script entry（新 Make target 与 env）、Config / project setup（Makefile 赋值与 export、constraints.yaml）、Legacy compatibility（既有四个受保护 target、十条 surface、既有 mutation 用例全部保持）、Documentation / migration notes（AGENTS.md 两行镜像）。

## Governing invariants

1. 目标文本 = 本 change 三份 spec delta（verification-harness「CI 接线与控制面同步」取父 delta 整段；demo-parity-acceptance「ui-shots 截图对产物」补 make 入口；「控制面同步」取父 delta 并做 proposal 所列两处修订）。
2. `Makefile` 是唯一命令面，`AGENTS.md` 与 `constraints.yaml verification` 是其镜像（`Makefile:1-3` 页头），三处与 oracle 同 PR 原子更新。
3. `make ui-shots` 只消费已运行服务：不 build/start/stop/install（与 `ui-walk` 同，`Makefile:69-70`）。
4. CI 不变：不新增 job、不新增第三方 action（`test-ci-harness.sh` 的 workflow oracle 保持原样通过）。

## Sibling surfaces

- `Makefile:5`（`.PHONY` 整行）、`:1-3`（页头）、`:65-70`（`UI_WALK_BASE_URL` 三行冻结 + `ui-walk` 目标）、`:72-73`（`omp-fetch`）、`:75-82`（`MODEL_UPSTREAM_*` 的 `ifneq origin` 冻结块，oracle 以 `origin_url_block`/`origin_key_block` 精确匹配）、`:83-87`（`smoke-live` 目标）。
- `AGENTS.md:79-94`（Verification Matrix；`make smoke-live` 行 `:92`）、`:134-158`（Enforcement Index；`smoke-live` 行 `:154`）。
- `constraints.yaml:108-150`（`verification.surfaces` 十条；`smoke-live` `:146-149`）。
- `scripts/test-ci-harness.sh`：`:92` `contract()`（内嵌 Python：`safe_overrides` 元组、`set(headers) != {"smoke","ui-walk","omp-fetch","smoke-live"}`、`.PHONY` 计数、`recipes(name, expected)`、AGENTS/constraints 行期望、surfaces 解析）；`:121` Make duplicate/redefinition mutation 用例（如 `smoke-live :\n\t@true`）；`:137-154` AGENTS/constraints/Make 页头的篡改 mutation 与 positive control；`:191` `owner_mut` 的 decoy 辅助（surfaces 解析本身在 `:92`）。
- 先例：`90b433f`（#107，smoke-live/omp-fetch 控制面同步：同样四文件 + oracle 扩展）。
- 脚本侧：`web/package.json` `ui-shots` script（#297），`web/e2e/ui-shots.mjs` 读 `UI_SHOTS_BASE_URL`/`UI_SHOTS_OUT`，`UI_SHOTS_OUT` 为空串时按未设置处理（取缺省目录）。

## Decisions

- **D1 Makefile 片段**（紧随 `ui-walk` 目标之后、`omp-fetch` 之前；以下行逐字，注释行措辞可调但须保留）：
  ```
  UI_SHOTS_BASE_URL ?= http://127.0.0.1:3000
  # 与 smoke/ui-walk 相同：$(value) 冻结成 raw 字面后 export；配方不把该值插进 shell 语法。
  override UI_SHOTS_BASE_URL := $(value UI_SHOTS_BASE_URL)
  export UI_SHOTS_BASE_URL
  # UI_SHOTS_OUT 不设缺省（无 ?=）：同样冻结后 export；未设置时导出空串，脚本按未设置取
  # var/ui-shots/<UTC 时间戳>/（Make 不用 $(shell)）。
  override UI_SHOTS_OUT := $(value UI_SHOTS_OUT)
  export UI_SHOTS_OUT
  ui-shots: ## demo 与 app 截图对（只消费已运行服务；不 build/start/stop/install；产物供人工按清单签收）
  	npm run --silent ui-shots --workspace web
  ```
  `.PHONY` 行末追加 ` ui-shots`。页头（oracle 逐字比对 `header_lines`）第 3 行改为、并新增第 4 行，逐字：
  ```
  # smoke-live 是调用方拥有的真实上游手动验证，ui-shots 是调用方拥有服务的手动 demo 截图对；
  # 控制面文档行与 Makefile 目标同步。
  ```
- **D2 `--silent`**：`npm run ui-shots` 失败时 npm 打印 `npm error path/location <仓库绝对路径>`；`--silent` 只压 npm 自身日志，脚本 stdout/stderr 与退出码不变（本地实测：不可达 URL 下 rc=1、npm error 行 0）。这是 #297 PR 记录的观察项的落地。
- **D3 `UI_SHOTS_OUT` 冻结后 export、不设缺省**（相对父 spec「只 `export`」的有意偏离，第三处偏离）：父文本的意图是"Make 不设缺省、缺省由脚本计算"，无 `?=` 即满足；但只 export 时，命令行形式 `make ui-shots UI_SHOTS_OUT='out/$x'` 会被 Make 展开（`$x` 被吃掉、`$(shell …)` 被执行；本机 GNU Make 3.81 与测试机 4.3 实测一致，环境变量形式不展开），与 `Makefile:50-53` 记录的冻结理由相悖。无条件两行 `override UI_SHOTS_OUT := $(value UI_SHOTS_OUT)` + `export UI_SHOTS_OUT` 不需要 `ifneq origin` 块；未定义时 `$(value)` 为空、导出空串，`web/e2e/ui-shots.mjs:115-119` 的 `if (raw)` 按未设置处理（与只 export 时未定义导出空串的行为一致）。
- **D4 AGENTS.md 两行**（Matrix 插在 `make smoke-live` 行之后；Enforcement 插在 `make smoke-live` 行之后）：
  - `| demo 一致性截图对 | Playwright Chromium（调用方拥有已运行服务） | `make ui-shots` | 退出码 0；60 张截图 + index.html，人工按清单签收 |`
  - `| demo 一致性截图对 | 本文件 Verification Matrix | `make ui-shots` | review-only |`
  （父 spec 该行 `）|` 无空格系排版遗漏，按兄弟行统一为 `） |`。）
- **D5 constraints.yaml**：在 `smoke-live` 之后追加
  ```
      ui-shots:
        command: "make ui-shots"
        evidence: "exit-code; demo-vs-app screenshot pairs for manual checklist sign-off"
        required_at: "manual"
  ```
- **D6 oracle 扩展**（`scripts/test-ci-harness.sh:92` 内嵌 `contract()`，沿用现有结构，不重写）：
  1. `safe_overrides` 增三项：`UI_SHOTS_BASE_URL ?= http://127.0.0.1:3000`、`override UI_SHOTS_BASE_URL := $(value UI_SHOTS_BASE_URL)`、`override UI_SHOTS_OUT := $(value UI_SHOTS_OUT)`。
  2. **存在性**：现行 Make 行检查只是白名单（赋值/`override` 行不在集合即拒），不检查行是否存在，`export …` 行因无分隔符、非赋值而直接放行（fixture r1 P1）。新增 ui-shots 块精确检查：在 `active_shell(filtered)`（去注释后的有效行）中，`UI_SHOTS_BASE_URL ?= …`、`override UI_SHOTS_BASE_URL := …`、`export UI_SHOTS_BASE_URL`、`override UI_SHOTS_OUT := …`、`export UI_SHOTS_OUT` 五行各恰出现 1 次、在 `active_shell` 列表上为连续 5 个元素（注释行已被去除；不要对原始文本做 `makefile.count(block)`，D1 五行之间有注释）、且紧接其后的有效行是 `ui-shots:` 目标头（思路参照 `origin_url_block` + `leftover`，引入于 `0ff5ad2`/#94）。另拒绝任何其他以 `UI_SHOTS_`、`export UI_SHOTS_`、`override UI_SHOTS_`、`unexport UI_SHOTS_` 开头的行。
  3. 受保护目标集 `{"smoke","ui-walk","omp-fetch","smoke-live"}` 增 `"ui-shots"`；`.PHONY` 计数增 `phony.count("ui-shots") != 1`；`recipes("ui-shots", ["\tnpm run --silent ui-shots --workspace web"])`。
  4. AGENTS Matrix/Enforcement 行期望各 +1（`one(matrix_rows, …)` 等同类位置）；surfaces 期望 +1（十→十一，顺序敏感，追加在 smoke-live 之后），各字段逐字。
  5. 页头 `header_lines` 按 D1 逐字更新。
  6. 会因锚点文本变化而 `FAIL missing anchor` 的既有 mutation 用例须同步其锚点（期望结果不变）：`:141-142` matrix/enforcement 整节包注释与 fence 用例（4 条）；`:152` peer-section-move 用例（8 条）；`:153` 页头 deferral 与 truncation 用例；`:154` foreign-owner decoy（锚点跨 smoke-live 到 `enforced_by`）。（`:121` 的 `.PHONY` 用例锚点是新行前缀子串，仍唯一，不受影响。）实现时以 `make test-guardrails` 无 `missing anchor` 为准，若另有同类用例一并同步并在 PR 列出。
- **D7 mutation 用例**（加在 `:121`/`:137-154` 同类位置，每条都必须 rc≠0 即 PASS）：`ui-shots :\n\t@true` spaced duplicate；`ui-shots:` 配方篡改（去掉 `--silent` 或改 workspace）；`.PHONY` 去掉 `ui-shots`；`UI_SHOTS_BASE_URL ?=` 缺省改端口；`override UI_SHOTS_BASE_URL` 行改为 `=`；AGENTS Matrix 行 evidence 篡改、Enforcement 级别 `review-only`→`block`、两行各自注释掉（`<!-- … -->`）；constraints `ui-shots` command/evidence/required_at 各篡改一条；constraints `ui-shots` quoted duplicate。删除或截断页头新职责句（D1 第 3 行的 ui-shots 从句或第 4 行）；ui-shots 变量块五行各自删除一次（5 条）、`export UI_SHOTS_OUT` 移到 `ui-shots:` 之后、`override UI_SHOTS_OUT` 改为 `UI_SHOTS_OUT := $(value UI_SHOTS_OUT)`（缺 override）。另加一条 positive control：只改 `ui-shots` 目标的 `##` 注释文字 → oracle 仍 PASS（现行 oracle 只检查 `##` 前缀）。

## Must preserve

- 既有十条 surface、四个受保护 target 与其配方、`MODEL_UPSTREAM_*` origin 块、全部既有 mutation 与 positive control 的期望结果不变。
- `make ui-walk`/`make smoke`/`make smoke-live` 行为不变；`web/**`、`.github/**` 不改。

## Must add/change

- `Makefile`、`AGENTS.md`、`constraints.yaml`、`scripts/test-ci-harness.sh` 按 D1–D7。

## Required evidence

1. `make test-guardrails` exit 0；输出中 D7 每条新 mutation 为 PASS（rc=1），总 PASS 数较 master 增加且 FAIL 为 0；列出新增用例名。
2. `make check` exit 0。
3. `make ui-shots` 实跑（按 #297 design 的本地运行面起服务，`UI_SHOTS_BASE_URL=http://127.0.0.1:18017`，`UI_SHOTS_OUT` 取相对路径 `var/ui-shots/pr298`）：rc 0，60 png + index.html 位于仓库根 `var/ui-shots/pr298/`（证明 Make cwd 下相对路径解析与 export 生效）；再以 `make ui-shots UI_SHOTS_BASE_URL=http://127.0.0.1:1 2>&1 | tee $RT/unreach.log` → rc≠0（取 `PIPESTATUS[0]`），`grep -c 'npm error' $RT/unreach.log` 为 0，`grep -cF "$PWD" $RT/unreach.log` 为 0。另以 `make ui-shots UI_SHOTS_BASE_URL=http://127.0.0.1:1 'UI_SHOTS_OUT=var/ui-shots/$x'` 证明冻结：打印的输出目录为 `var/ui-shots/$x/`（`$` 未被 Make 吃掉）。
4. 未设置 `UI_SHOTS_OUT` 时 `make -n ui-shots` 仅打印配方行；实跑（服务不可达即可）打印的输出目录为 `var/ui-shots/<UTC 时间戳>/` 形式（证明空/未设置等价）。
5. `git diff master --stat` 只含四个控制面文件（与 openspec 本 change）。

## Not yet specified

- 无。
