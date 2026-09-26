# Spec delta: omp-pool（#451 OMP_MAX_PROCESSES 配置）

## ADDED Requirements

### Requirement: OMP_MAX_PROCESSES 配置
应用配置 SHALL 新增可选键 `OMP_MAX_PROCESSES`，缺省值 `16`。其解析纪律 SHALL 与 `OMP_IDLE_MS` 完全一致：只接受 canonical ASCII decimal 正整数 `1..2147483647`（无符号、无空白、无小数/指数、除 `0` 外无前导零），非法或超限值 SHALL 在任何 filesystem/database/listen 副作用前使启动失败，配置错误消息 SHALL 命名 `OMP_MAX_PROCESSES` 而不含输入值。该值 SHALL 经 `agent-config` 同一纯解析器进入 supervisor，不得由 supervisor 直接读 `process.env`。

#### Scenario: 缺省与覆盖
- **WHEN** 未设置 `OMP_MAX_PROCESSES` 启动，或设置为 `1`、`2`、`2147483647`
- **THEN** supervisor 的上限分别为 16、1、2、2147483647，其它十二项配置行为不变

#### Scenario: 非法值启动失败
- **WHEN** `OMP_MAX_PROCESSES` 为空串、`0`、`abc`、`-1`、`1.5`、`+3`、`016`、` 8`、`2147483648`
- **THEN** 启动 nonzero，stderr 恰一行既有 generic failure record，错误命名该键且不含输入值，无任何 filesystem/database/listen 副作用

