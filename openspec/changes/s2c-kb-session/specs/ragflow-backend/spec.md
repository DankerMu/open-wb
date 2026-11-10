## MODIFIED Requirements

### Requirement: RAGFlow 出站请求
`kb` 模块对 RAGFlow 的全部请求 SHALL 经同一个客户端发出：
- `agent:false`，不跟随重定向，不重试。唯一的例外是检索的重排降级（见下面「调用点对类型化结果的处理」），它恰重试一次。
- JSON 请求：连接期限 10 s，总期限 30 s，响应体至多 1 MiB。
- 上传与下载：连接期限 10 s，空闲期限 60 s。
- 检索请求（`POST /api/v1/retrieval`，含重排降级的那一次重试）SHALL 接受调用方的中止信号（knowledge-bases「单轮检索」）：信号已中止时不发出请求；请求进行中被中止时放弃连接，结果与期限到期相同。
- 除 `/api/v1/system/version` 外，每个请求都带 `Authorization: Bearer <密钥>`。

结果映射 SHALL 按以下次序判定：
1. 下表的路由专属组合先于下面各条，识别为类型化结果，由调用点处理：
   | 路由 | 组合 | 类型化结果 |
   |---|---|---|
   | `GET /datasets/<id>/documents` | `code:404` | not-found |
   | `POST /datasets/<id>/documents` | `code:102` 且 message 以 `Can't find the dataset with ID` 开头 | not-found |
   | `POST /datasets/<id>/documents` | `code:500` 且 message 含 `This type of file has not been supported yet!` | 不支持的文件 |
   | `POST …/documents/parse` | `code:404` | not-found |
   | `POST …/documents/parse` | `code:0` 且 `success_count` 为 0 | 解析未启动 |
   | `POST …/documents/stop` | `code:404`；`code:100` 且 message 以 `Documents not found:` 开头 | not-found |
   | `DELETE …/documents` | `code:404`；`code:102` 且 message 以 `These documents do not belong to dataset` 开头 | not-found |
   | `DELETE …/documents` | `code:0` 且 `deleted` 为 0 | 未删除 |
   | `DELETE /datasets` | `code:403` | not-found |
   | `DELETE /agents/<id>` | `code:103` | not-found |
   | `DELETE /compilation-template-groups/<id>` | `code:404` | not-found |
   | `GET …/documents/<doc>` | 见「嵌入模型更换与全量重建」的下载判别 | 文件流或 not-found |
   | `POST /retrieval` | `code:102` | 检索失败 |
2. HTTP 2xx 且 body `code` 为 0：成功。
3. body `code` 为 101 或 102：`kb_rejected`（400）。
4. HTTP 401，或 body `code` 为 401 / 403：`kb_unavailable`（503），并经受管 stderr writer 写一行，恰为 `{"event":"kb_upstream_auth_failed"}`；同一进程 60 秒内至多一行。
5. 其余（其它非零 `code`、非 2xx、3xx、非 JSON、超出体积、超时、连接失败、成功应答缺少调用点要读的字段）：`kb_unavailable`。

调用点对类型化结果的处理：
- not-found：删除视为已删除；文档列表视为该库的数据集已丢失，全部文档 `missing`；上传与解析触发按 `kb_unavailable` 处理。
- 解析未启动：SHALL 视为解析触发失败，不得当作成功。
- 不支持的文件、未删除：见 knowledge-bases 各端点。
- 检索失败（实测记录 §19.4：重排端点不通、上游密钥无效、重排模型不存在都是这个组合；它区分不出失败是否来自重排）：
  - 这次请求带了 `rerank_id`：SHALL 去掉 `rerank_id`、其余字段不变，再发恰一次；并经受管 stderr writer 写一行，恰为 `{"event":"kb_rerank_degraded"}`，同一进程 60 秒内至多一行。重试的结果按普通检索处理，应答里没有降级的标记。
  - 这次请求没带 `rerank_id`（含上面那次重试）：`kb_unavailable`。
  - 结果：不是重排引起的检索失败，也会先触发一次不带重排的重试，再以 `kb_unavailable` 结束。

`DELETE /datasets` 的 `ids` SHALL 恰含一个非空 id，成功 SHALL 以 `success_count` 为 1 为准。客户端 SHALL NOT 提供 `GET /providers/<提供方>/instances/<实例>`：该应答明文回显上游密钥。

RAGFlow 应答的 message 与错误应答的正文 SHALL NOT 进入本系统的响应、审计或日志，message 只用于上面的前缀判定。唯一的例外是成功检索应答里命中切片的 `content` 与 `similarity`：它们作为数据进入检索测试的 200 应答（knowledge-bases「单轮检索」），仍 SHALL NOT 进入审计或日志。

#### Scenario: 结果映射
- **WHEN** 假 RAGFlow 对建库请求依次应答：HTTP 200 `code:0`；HTTP 200 `code:101`；HTTP 401 `code:401`；HTTP 302；HTTP 200 非 JSON；挂起超过总期限（期限经装配注入缩短）
- **THEN** `POST /api/kb/bases` 依次得到 201、400 `kb_rejected`、503 `kb_unavailable`（并恰一行 `kb_upstream_auth_failed`）、503、503、503；后五次都不插知识库行；任何响应与 stderr 都不含假 RAGFlow 返回的 message 文本

#### Scenario: 权限错误的防御性映射
- **WHEN** 假 RAGFlow 对文档列表应答 HTTP 200 `code:403`；另一次对 `DELETE /datasets` 应答同样的组合
- **THEN** 文档列表为 503 `kb_unavailable`，并恰一行 `kb_upstream_auth_failed`；删数据集视为已删除，不写这一行

#### Scenario: 成功码下的失败
- **WHEN** 客户端收到 `POST …/documents/parse` 的 `{code:0, data:{success_count:0}}`；`DELETE …/documents` 的 `{code:0, data:{deleted:0}}`；经故障注入，`DELETE /datasets` 的 `{code:0, data:{deleted:[]}}`（实测记录 §4.6 里空 `ids` 的形状，没有 `success_count`；本系统不发空 id，这条是防御性判定）
- **THEN** 三者都不是成功：依次为解析未启动、未删除与 `kb_unavailable`

#### Scenario: 路由各异的不存在组合
- **WHEN** 假 RAGFlow 按实测记录表 B 应答：`DELETE /datasets` 的 `code:403`；`POST /datasets/<id>/documents` 的 `code:102` 与 `Can't find the dataset with ID <id>!`；`DELETE …/documents` 的 `code:102` 与 `These documents do not belong to dataset <id> or Document not found: <id>`；`POST …/documents/stop` 的 `code:100` 与 `Documents not found: ['<id>']`；`DELETE /agents/<id>` 的 `code:103`；`DELETE /compilation-template-groups/<id>` 的 `code:404`
- **THEN** 六者都是 not-found；同一路由上别的 `102` 或 `100` 不是，分别按 `kb_rejected` 与 `kb_unavailable` 映射

#### Scenario: 不存在视为已删
- **WHEN** 假 RAGFlow 对删数据集与删文档请求都应答实测记录给出的「不存在」组合，用户先移出一份文档，再删除该知识库
- **THEN** 两次分别为 204；文档行与知识库行都已删除；各有一条 `kb.document_delete` 与 `kb.delete`

#### Scenario: 每个请求带密钥
- **WHEN** 知识库端点触发对假 RAGFlow 的建库、上传、列表、删除与版本请求
- **THEN** 除版本请求外，每个请求的 `Authorization` 恰为 `Bearer <密钥>`；版本请求不带 `Authorization`；没有请求跟随重定向

#### Scenario: 重排降级
- **WHEN** 配置了重排模型；假 RAGFlow 对带 `rerank_id` 的检索回 HTTP 200 `code:102`、message 为 `retrieval search failed: vLLM rerank API error: 401 Unauthorized, body: {…}`，对不带的回两条切片；连续检索三次
- **THEN** 三次都是 200 且各两条命中，应答与无重排时同形；假 RAGFlow 每次检索都恰收到两次请求，第二次不含 `rerank_id`、其余字段与第一次相同；stderr 恰一行 `{"event":"kb_rerank_degraded"}`；任何响应与 stderr 都不含 message 文本

#### Scenario: 检索失败的映射
- **WHEN** 未配置重排模型，假 RAGFlow 对检索依次回 `code:102`、`code:404`（`Resource not found`）、`code:101`；另一次配置了重排模型，带与不带 `rerank_id` 都回 `code:102`
- **THEN** 依次 503 `kb_unavailable`、503 `kb_unavailable`、400 `kb_rejected`，每次假 RAGFlow 只收到一次请求，没有 `kb_rerank_degraded`；配置了重排的那次 503 `kb_unavailable`，假 RAGFlow 收到恰两次请求

#### Scenario: 超时不降级
- **WHEN** 配置了重排模型，假 RAGFlow 挂起带 `rerank_id` 的检索超过总期限（期限经装配注入缩短）
- **THEN** 503 `kb_unavailable`；假 RAGFlow 只收到这一次请求

#### Scenario: 检索请求被中止
- **WHEN** 假 RAGFlow 挂起检索应答，调用方在总期限之前中止信号
- **THEN** 结果与期限到期相同（`kb_unavailable`），不等到总期限；假 RAGFlow 观察到连接关闭；没有重试
