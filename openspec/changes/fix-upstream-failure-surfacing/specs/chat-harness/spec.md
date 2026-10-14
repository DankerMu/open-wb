## ADDED Requirements

### Requirement: 上游失败的冒烟与走查
`smoke/chat.hurl` SHALL 在既有用例之后、退出登录之前新建一个会话，发送一条含 `WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret` 的 prompt（202；假上游的 `secret` 正文逐字含受控上游的密钥、一个 bearer 令牌与一个 `sk-` 串，分类仍是 `auth_failed`），以有界重试轮询消息快照，直到被捕获的助手消息为 `failed`；断言其 `error.reason` 为 `auth_failed`、`error.status` 为 401、`error.message` 为 `鉴权失败：模型服务拒绝了配置的 API 密钥`、`error.detail` 非空且不含受控上游的密钥、`leak-token-0123456789` 与 `sk-leakleakleakleakleak`，会话为 `failed`；随后在同一会话发送一条普通 prompt，按既有方式作答审批并轮询到 `done`；最后按「冒烟与走查不留会话与临时空间」在 logout 之前 `DELETE` 该会话（exact 204）。这些条目（含删除） SHALL 与回合控制条目一样带 `[Options]` `skip: {{skip_turn_control}}`，使 `make smoke-live`（真实上游）全部跳过；`make smoke` 的配方、Hurl 文件参数与 `AGENTS.md` 的冒烟证据行不变。

`make ui-walk` SHALL 有一步：在一个新会话里发送含 `WORKBUDDY_FAKE_STATUS=401 WORKBUDDY_FAKE_BODY=secret` 的消息，断言回合结束后助手消息显示 `鉴权失败：模型服务拒绝了配置的 API 密钥（HTTP 401）`、`查看原文` 展开后显示原文且不含受控上游的密钥与 `leak-token-0123456789`、输入框已解锁；随后发送一条普通消息并完成。该步骤在两个 project 下都运行，结束时按「冒烟与走查不留会话与临时空间」清理它建的会话。

两者只用受控假上游，永不打真实模型端点。

#### Scenario: 冒烟断言上游失败
- **WHEN** `make smoke`（`skip_turn_control=false`）对编译后的服务与受控假上游运行 `smoke/chat.hurl`
- **THEN** 401 标记的回合在轮询上限内到达 `failed`，快照 `error` 的四个字段如上（`detail` 的「不含密钥」断言在净化器被跳过时必然判红，因为上游正文逐字含该密钥）；同一会话随后的普通 prompt 到达 `done`；`make smoke-live` 运行同一文件时这些条目全部跳过

#### Scenario: 走查看到错误块并能继续
- **WHEN** `make ui-walk` 运行上游失败一步
- **THEN** 错误块的说明与 `（HTTP 401）` 可见、展开后原文可见且不含密钥、输入框可输入并可发送；后续普通消息完成为 `done`；步骤结束后该会话已被删除
