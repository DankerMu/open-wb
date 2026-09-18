# omp 经 app-server 模型代理访问模型网关，环境零凭证

不变量 4 禁止模型网关密钥进入 omp 子进程可读环境（omp 的 bash 工具可读 env）。决定：app-server
提供 OpenAI 兼容的本地模型代理端点，omp 的 provider baseURL 指向它，环境里只有会话标识；真密钥由
app-server 注入转发，每会话计量/限额/审计顺带落在代理层。会话标识必须是每会话随机生成的
不可猜测 token、仅对该会话有效——它就是该会话在代理处的配额凭证（omp bash 可 curl 本地端口，
可猜测标识意味着跨租户盗用配额）。内网单机下多一跳可忽略。kb-service 的
嵌入/重排调用不走此代理（其凭证本就允许持有，直连网关，避免摄取批量流量耦合 app-server）。

## Considered Options
- 每会话限时 token：少一跳，但依赖网关签发能力（未知），且 token 仍入 omp 环境。
- 共享密钥进环境：直接违反不变量 4，弃。

## 2026-09-18 补充：开发期上游端点（S0b 前置，用户拍板）

仓库内原先没有任何具体模型端点。决定：开发期 model-proxy 的上游用**公网 OpenAI 兼容供应商作替身**，
内网网关在部署时经同一配置面替换。纪律：

- 单元/inject 测试一律打**假 OpenAI 兼容上游**（测试内启动），只有 `make smoke` 与 P0 里程碑验收打真实端点。
- 供应商、base URL 与凭证一律不进任何被跟踪文件：本机 shell env + GitHub Secrets；仓库是 public。
- 配置项命名与注入方式由 S0b design 定；本补充只定类别与凭证落点。
