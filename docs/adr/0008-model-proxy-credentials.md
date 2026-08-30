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
