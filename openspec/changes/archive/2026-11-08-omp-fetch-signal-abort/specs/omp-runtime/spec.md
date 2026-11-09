## MODIFIED Requirements

### Requirement: 二进制供给的下载回退
`scripts/omp-fetch.sh` 从主地址 `https://github.com/can1357/oh-my-pi/releases/download/v18.12.3/<asset>` 下载失败（curl 以小于 128 的非零码退出）时 SHALL 改从同一 release 资产的 API 地址 `https://api.github.com/repos/can1357/oh-my-pi/releases/assets/<asset_id>`（`Accept: application/octet-stream`）再下载一次；资产 id SHALL 是仓内固定常量（`omp-darwin-arm64` 657108328、`omp-linux-x64` 657108334）。两条路径下载的内容 SHALL 经「二进制供给」的同一 SHA256 校验，校验不过或两条都失败时 SHALL 以非零退出且不留 `var/omp/omp` 与临时文件。回退 SHALL 只在主地址 curl 的退出码小于 128 时发生；主地址 curl 的退出码大于等于 128（被信号终止）时，脚本 SHALL 以该退出码退出、SHALL NOT 回退。脚本自身收到 INT、HUP、TERM 时 SHALL 以 128+信号号（130、129、143）退出、SHALL NOT 继续执行后续步骤；任一退出路径 SHALL 删除临时文件且不留 `var/omp/omp`。两条请求 SHALL 都不带凭证（不读 `GITHUB_TOKEN` 或任何 secret）；脚本 SHALL NOT 提供按环境变量覆盖 SHA256、资产 id 或下载地址的旁路。

#### Scenario: 主地址失败时经 API 资产地址回退
- **WHEN** 主地址下载以小于 128 的非零码退出（例如 22），API 资产地址返回与固定 SHA256 一致的内容
- **THEN** 产出 `var/omp/omp` 且可执行，stderr 含 `omp-fetch: primary download failed; retrying via GitHub API asset`，退出 0

#### Scenario: 两条路径都失败
- **WHEN** 主地址与 API 资产地址都以非零退出
- **THEN** 退出非 0，`var/omp/omp` 与 `var/omp/.omp-fetch.*` 都不存在

#### Scenario: 回退内容摘要不符
- **WHEN** 主地址失败，API 资产地址返回的内容 SHA256 与固定表不一致
- **THEN** 退出非 0，stderr 含 expected/actual 摘要，`var/omp/omp` 不存在

#### Scenario: 回退请求不带凭证
- **WHEN** 环境里有 `GITHUB_TOKEN`，主地址失败后走 API 资产地址
- **THEN** 两次请求都不带 `Authorization` 头

#### Scenario: 主地址可用时不访问 API
- **WHEN** 在空 `var/omp/` 下执行，主地址返回正确内容
- **THEN** 只发出主地址一个下载请求，产出 `var/omp/omp`

#### Scenario: 主下载被信号中断不回退
- **WHEN** 主地址 curl 以 130 或 143 退出
- **THEN** 脚本以同一退出码退出，curl 只被调用一次，stderr 不含回退行，`var/omp/omp` 与 `var/omp/.omp-fetch.*` 都不存在

#### Scenario: 取消送达脚本进程组
- **WHEN** 主地址下载进行中，INT 或 TERM 送达脚本所在进程组（Ctrl-C 或 CI 取消作业）
- **THEN** 脚本以 130（INT）或 143（TERM）退出，不发出 API 资产地址请求，不留 `var/omp/omp` 与临时文件
