## ADDED Requirements

### Requirement: 上游地址的视图形式与拼接
`server/src/core/base-url.ts` SHALL 是上游 base URL 的视图形式、净化部件与子路径拼接的唯一实现（`models/` 与 `model-proxy/` 都经它，不各自写正则）：
- `withoutUserinfo(baseUrl)`：WHATWG `new URL` 解析成功且 `username` 或 `password` 非空时，清空两者后返回 `href`；解析成功但无 userinfo、或解析失败时，返回兜底正则 `^\s*([A-Za-z][A-Za-z0-9+.-]*:[/\\]*)((?:[^/\\?#][^/?#]*)?)@` 替换为第 1 组的结果（容忍前导空白与 `:` 后任意个 `/` 或 `\`；userinfo 段可含 `\`；未命中即原样）。`ModelView.upstream.baseUrl` 与 `store.update` 的沿用判据都用它。
- `userinfoParts(baseUrl)`：正则取到的 userinfo 原文与其密码段，并上 `new URL` 一侧的 `password` 与 userinfo 整串（整串只在 `password` 非空、或正则未取到 userinfo 时加入；无密码时即用户名）及二者的百分号解码形式，去空去重（不单列用户名）；upstream-failure「上游原文净化」的 base URL 部件用它。
- `upstreamEndpoint(baseUrl, sub)`：解析后把路径去掉结尾斜杠接 `/<sub>`，清空 fragment，查询串与 userinfo 原样保留。

#### Scenario: 非规范种子地址不回显密码
- **WHEN** env 种子行的上游地址分别为 `http:/u:<哨兵>@gw.example/v1`、`http:u:<哨兵>@gw.example/v1`、`https:\u:<哨兵>@gw.example/v1`、` https://u:<哨兵>@gw.example/v1`（前导空格），管理员 `GET /api/models`
- **THEN** 每个视图的 `upstream.baseUrl` 不含 `<哨兵>` 与 `u:`；以该视图地址 `PUT` 只改名 → 存储地址逐字不变；`userinfoParts` 对四者都含 `<哨兵>`

#### Scenario: 拼接保留查询串且既有形状不变
- **WHEN** `upstreamEndpoint` 分别作用于 `http://h/v1`、`http://h/v1/`、`http://h`、`http://h/tenant/v1?org=a`、`http://h/v1#frag`，`sub` 为 `chat/completions`
- **THEN** 依次得到 `http://h/v1/chat/completions`、`http://h/v1/chat/completions`、`http://h/chat/completions`、`http://h/tenant/v1/chat/completions?org=a`、`http://h/v1/chat/completions`

## MODIFIED Requirements

### Requirement: 探活
`POST /api/models/probe?id=<id>` SHALL 对该模型的上游发 `GET`，目标为「上游地址的视图形式与拼接」的 `upstreamEndpoint(baseUrl, "models")`（路径去掉结尾斜杠后接 `/models`，查询串保留），头 `authorization: Bearer <apiKey>`、`accept: application/json`，建连期限 10 s、整体期限 15 s，不跟随重定向，不重试。结果 SHALL 写入该行：2xx → `probe_status = 'ok'`、`probe_message = NULL`；其它状态 → `'failed'`、`probe_message = "HTTP <status>：<摘要>"`（摘要为 `upstreamExcerpt`（密钥集为全部已登记上游与本次所探上游自身的 base URL 与密钥各部分；正文至多读 16 KiB）的结果再截到 200 码点：超出时保留前 194 个码点并接 `…（已截断）`，不拆代理对）；连接被拒、重置或 DNS 失败 → `'failed'`、`"无法连接"`；建连期限或整体期限到期 → `'failed'`、`"超时"`；模型没有上游 → 不发请求、`'failed'`、`"未配置上游"`。`probe_at` 为完成时刻。探活 SHALL NOT 触发托管文件重写，SHALL 记审计 `model.probe`（detail `{modelId, status}`）。同一模型的并发探活 SHALL 串行；探活在途期间该行被删除时结果 SHALL 丢弃、响应 404 `not_found`。探活 2xx 只证明上游可达且密钥被接受，不核对 `data[].id` 含该模型（design「Not yet specified」）。密钥 SHALL NOT 出现在响应、审计、stdout/stderr。

#### Scenario: 四种结果
- **WHEN** 对上游为假上游（`GET /models` 答 200）的模型探活；对答 `401 {"error":{"message":"bad key <哨兵>"}}` 的探活；对指向未监听端口的探活；对指向只接受连接不应答的夹具（整体期限注入 1 s）探活；对没有上游的模型探活
- **THEN** 视图 `probe` 依次为 `{ok, <时刻>, null}`、`{failed, <时刻>, "HTTP 401：…"}`（不含哨兵）、`{failed, <时刻>, "无法连接"}`、`{failed, <时刻>, "超时"}`、`{failed, <时刻>, "未配置上游"}`；假上游记录恰一次 `GET /models` 且 bearer 为该模型密钥；最后一例假上游零请求；每次各一条 `model.probe` 审计；`models.yml` 的 mtime 不变

#### Scenario: 带查询串的上游地址
- **WHEN** 模型上游地址为 `http://127.0.0.1:<port>/v1?org=a`（测试内记录请求行的服务），管理员探活
- **THEN** 服务收到恰一个请求，请求行路径为 `/v1/models?org=a`；探活结果按应答状态判定
