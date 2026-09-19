# Spec: omp-runtime

## ADDED Requirements

### Requirement: 二进制供给
`make omp-fetch` SHALL 只从 `can1357/oh-my-pi` GitHub release **v18.0.10** 拉取与当前 `uname -sm` 匹配的资产（`omp-darwin-arm64` 或 `omp-linux-x64`），对照仓内固定的 SHA256 表校验后落到 `var/omp/omp` 并置可执行位；校验失败 SHALL 不留下 `var/omp/omp`；目标已存在且校验通过 SHALL 跳过下载。不支持的平台 SHALL 显式失败并打印支持矩阵。app-server SHALL 不依赖 PATH 上的任何 `omp`。

#### Scenario: 首次拉取与幂等
- WHEN 在空 `var/omp/` 下执行 `make omp-fetch`
- THEN 产出 `var/omp/omp`，`var/omp/omp --version` 输出 `omp/18.0.10`；再次执行不产生网络下载且退出 0

#### Scenario: 摘要不符
- WHEN 下载内容的 SHA256 与固定表不一致
- THEN 退出非 0，stderr 含 expected/actual 摘要，且 `var/omp/omp` 不存在

#### Scenario: 不支持平台
- WHEN uname -sm is neither Darwin arm64 nor Linux x86_64
- THEN the command SHALL fail nonzero with the supported platform matrix without downloading

#### Scenario: Make contract protection
- WHEN an equivalent duplicate `omp-fetch :` target or a changed recipe is injected
- THEN the existing harness oracle SHALL reject the mutation while accepting the intended Makefile
