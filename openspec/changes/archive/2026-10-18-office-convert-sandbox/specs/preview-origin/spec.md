## MODIFIED Requirements

### Requirement: 预览令牌签发端点
`POST /api/workspaces/:id/preview-token` SHALL 是主站上受 cookie 鉴权的无请求体端点（归属 content-parser 集，见 http-service-skeleton「统一错误信封」），仅在装配了预览依赖时注册。属他人或不存在的 `:id`、或该空间的根目录不存在 → 与其它工作空间端点相同的 404 `not_found`，不签发。成功 SHALL 以 `ownerId` = 当前账号、`workspaceId` = `:id`、`embedOrigin` = 本次请求的 `Origin` 头（没有该头时为 `null`）调用登记表，并返回 200、`Cache-Control: no-store`：

`{token, base, officeBase, expiresAt, documentMaxBytes, officeAvailable}`

其中 `base` 为 `<预览来源>/w/<token>/`、`officeBase` 为 `<预览来源>/o/<token>/`；`<预览来源>` 在配置了 `PREVIEW_ORIGIN` 时恰为该值，否则为 `<本次请求的协议>://<本次请求 Host 头里的主机名>:<预览监听器实际绑定的端口>`（主机名不含端口；IPv6 字面量保留方括号）；`expiresAt` 为毫秒时间戳；`documentMaxBytes` 为 `PREVIEW_DOCUMENT_MAX_BYTES` 的取值；`officeAvailable` 当且仅当配置了 `OFFICE_SPOOL_DIR` **且**启动时的办公文档 sidecar 预检通过（office-preview「转换 sidecar 的健康与 fail-closed」）时为 `true`；它是装配时取定的布尔，进程存活期间不变——预检失败的服务直到重启都答 `false`；运行期 sidecar 宕机时它仍为 `true`，此时 `/o/` 按 office-preview「办公文档预览路由」答 503 固定文案。本端点 SHALL NOT 写审计，SHALL NOT 访问请求路径之外的文件系统内容。响应体之外，令牌 SHALL NOT 出现在任何响应头、日志或错误信息里。

#### Scenario: 签发与复用
- **WHEN** zhangsan 对自己的工作空间连续两次 `POST …/preview-token`（请求头带 `Origin: http://127.0.0.1:3000`、`Host: 127.0.0.1:3000`），预览监听器绑定在端口 `P`，未配置 `PREVIEW_ORIGIN` 与 `OFFICE_SPOOL_DIR`
- **THEN** 两次都是 200 且 `token` 相同，`base` 恰为 `http://127.0.0.1:<P>/w/<token>/`，`officeBase` 恰为 `http://127.0.0.1:<P>/o/<token>/`，第二次的 `expiresAt` 不小于第一次，`documentMaxBytes` 为 `104857600`，`officeAvailable` 为 `false`；响应带 `no-store`；审计表没有新增行

#### Scenario: 对外来源与转换可用
- **WHEN** 配置 `PREVIEW_ORIGIN=https://preview.example.test` 与 `OFFICE_SPOOL_DIR`、且启动时的 sidecar 预检通过（假 sidecar 在 spool 里维持新鲜的 `heartbeat`）后签发
- **THEN** `base` 恰为 `https://preview.example.test/w/<token>/`，`officeAvailable` 为 `true`

#### Scenario: 归属与请求体
- **WHEN** lisi 对 zhangsan 的工作空间、任一账号对不存在的 id、未登录的请求、以及带 `{}` 请求体的请求分别调用
- **THEN** 依次为 404、404、401、400 `bad_request`；四种情况都没有令牌被签发（随后以任何字符串访问预览监听器都得不到文件）

#### Scenario: sidecar 不可用时转换不可用
- **WHEN** 配置了 `OFFICE_SPOOL_DIR`，但启动时的 sidecar 预检失败（spool 目录不存在、属主或 mode 不对、`heartbeat` 缺席或 5 s 内未新鲜），服务仍成功启动，随后签发令牌
- **THEN** 响应 200，`officeAvailable` 为 `false`，`officeBase` 仍为 `<预览来源>/o/<token>/`；以该令牌请求 `/o/<token>/<某 docx>` 得到 503 与固定文案「服务器未启用文档转换，请下载后查看」；application stderr 在 `server_started` 之前恰有一行 `{"event":"office_convert_sidecar_unavailable"}`；进程存活期间重复签发始终为 `false`
