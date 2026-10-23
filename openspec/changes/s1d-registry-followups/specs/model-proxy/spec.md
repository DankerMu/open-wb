## ADDED Requirements

### Requirement: 上游端点拼接
代理转发的目标 SHALL 为 model-registry「上游地址的视图形式与拼接」的 `upstreamEndpoint(<该模型的 baseUrl>, "chat/completions")`：路径去掉结尾斜杠后接 `/chat/completions`，查询串保留、fragment 丢弃；不带查询串的 base URL（`…/v1`、`…/v1/`、无路径）的转发目标与此前逐字相同。

#### Scenario: 带查询串的上游
- **WHEN** 登记模型的上游地址为 `http://127.0.0.1:<port>/v1?org=a`（测试内记录请求行的服务），有效 token 以该模型发一次请求
- **THEN** 上游收到恰一个请求，请求行路径为 `/v1/chat/completions?org=a`，bearer 为该模型密钥
