## MODIFIED Requirements

### Requirement: 控制面 oracle 校验 base URL 冻结块的存在与顺序
`make test-guardrails` 的 Makefile 契约 oracle SHALL 对 `SMOKE_BASE_URL`、`UI_WALK_BASE_URL`、`UI_SHOTS_*` 三组采用同一种检查：该组的 `?=` 默认值（`UI_SHOTS_OUT` 按设计没有默认值，只有冻结与 `export`）、`override … := $(value …)` 冻结与 `export` 行 SHALL 在生效行中各恰出现一次、连续、按此顺序，并紧接对应目标头；块外 SHALL NOT 存在引用该组变量的其它 `export`/`unexport`/`override`/`undefine`/`define`（含不带运算符的多行 `define NAME … endef`）或赋值行。缺失、重排、重复或块外散落任一行时 oracle SHALL 失败；当前 Makefile SHALL 通过。

#### Scenario: 删除冻结或导出行被拒
- **WHEN** 从 Makefile 删除 `override SMOKE_BASE_URL := $(value SMOKE_BASE_URL)`、`export SMOKE_BASE_URL`、`override UI_WALK_BASE_URL := $(value UI_WALK_BASE_URL)`、`export UI_WALK_BASE_URL` 或两组 `?=` 默认值行中的任一行后运行契约检查
- **THEN** 检查以非零退出

#### Scenario: 重排、重复与散落被拒
- **WHEN** 把某组的 `export` 移到 `override` 之前、把整块复制一份、或在目标之后追加一行 `export SMOKE_BASE_URL`、在 Makefile 末尾追加 `unexport SMOKE_BASE_URL`
- **THEN** 检查以非零退出，而未改动的 Makefile 检查退出 0

#### Scenario: 块外裸 define 被拒
- **WHEN** 在各组 `?=` 默认值行之前（如 `SHELL := /bin/bash` 之后）插入 `define SMOKE_BASE_URL`、`define UI_WALK_BASE_URL`、`define UI_SHOTS_BASE_URL` 或 `define UI_SHOTS_OUT`，body 为 `http://evil`、以 `endef` 结束，然后运行契约检查
- **THEN** 四种变异各自以非零退出，而未改动的 Makefile 检查退出 0
