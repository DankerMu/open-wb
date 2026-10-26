# model-registry Spec Delta

> models-probe-identity（#1760）：探活按行身份写回——上游与身份在串行链内同一次表读取得；删后重建同 id 判 404，在途 PUT 换上游丢弃结果、应答当前视图（与 connectors「连接器探活」同一裁定）。其余逐字沿用主规格。

## MODIFIED Requirements

### Requirement: 探活
`POST /api/models/probe?id=<id>` SHALL 对该模型的上游发 `GET`，目标为「上游地址的视图形式与拼接」的 `upstreamEndpoint(baseUrl, "models")`（路径去掉结尾斜杠后接 `/models`，查询串保留），头 `authorization: Bearer <apiKey>`、`accept: application/json`，建连期限 10 s、整体期限 15 s，不跟随重定向，不重试。结果 SHALL 写入该行：2xx → `probe_status = 'ok'`、`probe_message = NULL`；其它状态 → `'failed'`、`probe_message = "HTTP <status>：<摘要>"`（摘要为 `upstreamExcerpt`（密钥集为全部已登记上游与本次所探上游自身的 base URL 与密钥各部分；正文至多读 16 KiB）的结果再截到 200 码点：超出时保留前 194 个码点并接 `…（已截断）`，不拆代理对）；连接被拒、重置或 DNS 失败 → `'failed'`、`"无法连接"`；建连期限或整体期限到期 → `'failed'`、`"超时"`；模型没有上游 → 不发请求、`'failed'`、`"未配置上游"`。`probe_at` 为完成时刻。探活 SHALL NOT 触发托管文件重写，SHALL 记审计 `model.probe`（detail `{modelId, status}`）。同一模型的并发探活 SHALL 串行；探活所用的上游与「这一行」的身份 SHALL 在轮到它时（串行链内）取自同一次表读，身份为该行的 `created_at` 与上游两列（`upstream_base_url`、`upstream_api_key`）；结果 SHALL 只在该行仍是这一身份时写入（change models-probe-identity）。探活在途期间该行被删除、或被删除后以同一 id 重新登记（新行的 `created_at` 与原行不同；被删的恰是最新一行且在同一毫秒内重建时两者可能相同，此时按上游两列判定——与连接器探活同一已接受残余）时，结果 SHALL 丢弃、响应 404 `not_found`、不记审计；同一行的上游地址或密钥在途期间被 `PUT` 改动时，结果 SHALL 丢弃、不记审计，应答 200 与该行当前视图（探活状态保持 `PUT` 之后的值）。只改 `name`、`reasoning`、`vision`、`maxTokens`、`efforts` 或缺省标记时结果照常写入并记审计。探活 2xx 只证明上游可达且密钥被接受，不核对 `data[].id` 含该模型（design「Not yet specified」）。密钥 SHALL NOT 出现在响应、审计、stdout/stderr。

#### Scenario: 四种结果
- **WHEN** 对上游为假上游（`GET /models` 答 200）的模型探活；对答 `401 {"error":{"message":"bad key <哨兵>"}}` 的探活；对指向未监听端口的探活；对指向只接受连接不应答的夹具（整体期限注入 1 s）探活；对没有上游的模型探活
- **THEN** 视图 `probe` 依次为 `{ok, <时刻>, null}`、`{failed, <时刻>, "HTTP 401：…"}`（不含哨兵）、`{failed, <时刻>, "无法连接"}`、`{failed, <时刻>, "超时"}`、`{failed, <时刻>, "未配置上游"}`；假上游记录恰一次 `GET /models` 且 bearer 为该模型密钥；最后一例假上游零请求；每次各一条 `model.probe` 审计；`models.yml` 的 mtime 不变

#### Scenario: 带查询串的上游地址
- **WHEN** 模型上游地址为 `http://127.0.0.1:<port>/v1?org=a`（测试内记录请求行的服务），管理员探活
- **THEN** 服务收到恰一个请求，请求行路径为 `/v1/models?org=a`；探活结果按应答状态判定

#### Scenario: 在途期间删后重建同 id
- **WHEN** 对 `m1` 的探活挂起在上游（测试夹具不应答），其间管理员 `DELETE m1`（204），再 `POST /api/models` 以另一个上游重新登记 `m1`，随后放行旧探活
- **THEN** 探活应答 404 `not_found`；新 `m1` 的视图 `probe` 仍为 `{never, null, null}`；`model.probe` 审计为 0 条

#### Scenario: 在途期间 PUT 换上游
- **WHEN** 对 `m1` 的探活挂起，其间管理员 `PUT m1` 改了上游地址（或填了新密钥），随后放行旧探活
- **THEN** 探活应答 200，视图 `probe` 等于 `PUT` 之后读到的值（不是旧上游的结果）；`model.probe` 审计为 0 条

#### Scenario: 在途期间只改名称
- **WHEN** 对 `m1` 的探活挂起，其间管理员 `PUT m1` 只改 `name`，随后放行
- **THEN** 探活应答 200，视图 `probe` 为本次结果；`model.probe` 审计恰 1 条

#### Scenario: 排队的探活读到新上游
- **WHEN** 对 `m1` 的探活 A 挂起，同一 `m1` 再排一个探活 B，其间管理员 `PUT m1` 把上游换成另一个（新密钥），随后放行 A
- **THEN** A 应答 200、结果丢弃、无审计；B 向新上游发出恰一次 `GET /models`（bearer 为新密钥），视图 `probe` 为 B 的结果，`model.probe` 审计恰 1 条
