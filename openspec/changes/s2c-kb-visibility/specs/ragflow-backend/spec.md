## MODIFIED Requirements

### Requirement: 知识库可用性
未配置 `RAGFLOW_BASE_URL` 时知识库 SHALL 关闭：
- `GET /api/kb/status` 返回 `{enabled:false}`。
- 其余全部 `/api/kb/*` 端点（含管理员端点）返回 503 `kb_disabled`，不发任何出站请求。
- 判定次序：cookie guard 的 401 在前，`kb_disabled` 其次，之后才是管理员 403 与 body 解析。

配置了 `RAGFLOW_BASE_URL` 时：
- 服务 SHALL 照常启动，启动时不连接 RAGFlow。
- 之后任何一次 RAGFlow 请求失败只影响当次请求，按「RAGFlow 出站请求」映射；会话、文件等其它功能不受影响。
- 版本钉住只决定 `GET /api/kb/status` 的 `available`，其它知识库端点不因版本不符而拒绝请求。
- `available:false` 时，中心「知识库」tab 只显示不可用提示与 `重试`（knowledge-bases「中心「知识库」tab」）；模型 tab 的「知识库模型」段不看 `available`，只看 `enabled`：它读本地设置，RAGFlow 不可达时保存失败，显示信封文案。

#### Scenario: 未配置即关闭
- **WHEN** 未配置 `RAGFLOW_BASE_URL` 时，管理员逐个请求 `GET /api/kb/status` 之外的十四条知识库路由，`POST` / `PUT` 路由带 malformed JSON body；再以匿名身份请求其中一条
- **THEN** 管理员的十四次都是 503 `kb_disabled` 信封；匿名那次是 401；假 RAGFlow 收到零个请求

#### Scenario: 不可达不阻断
- **WHEN** `RAGFLOW_BASE_URL` 指向一个已关闭的端口时启动服务（store 里预置一个知识库行）；随后依次创建会话、请求 `GET /api/kb/status`、`GET /api/kb/bases` 与 `DELETE /api/kb/bases/:id`
- **THEN** 启动成功，会话创建成功；状态为 `available:false`；列表为 200，含该库；删除为 503 `kb_unavailable`，库行仍在
