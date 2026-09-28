# 对话冒烟（chat.hurl）：从空 cookie store 独立可运行，不依赖 public/auth。
# 登录 → 首轮 prompt → 审批作答 → 仅 messages GET 有界重试至 captured assistant/session done
# → 回合控制 → 他账号404 → 无 bearer 代理401。审批作答与回合控制仅在 skip_turn_control=false 时执行。
# 两账号均登出，不留下 live authentication session 与 running 回合。

# 成功登录：exact 200 Principal + 合规 session cookie。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"zhangsan","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u1","account":"zhangsan","role":"成员"}

# 创建会话：exact 201 idle、title null；捕获会话 id。
POST {{base_url}}/api/sessions
HTTP 201
[Captures]
session_id: jsonpath "$.id"
[Asserts]
jsonpath "$.title" == null
jsonpath "$.status" == "idle"

# 发送 prompt：exact 202；捕获 assistantMessageId。不重试本 POST。
POST {{base_url}}/api/sessions/{{session_id}}/prompt
Content-Type: application/json
{"message":"你好"}
HTTP 202
[Captures]
assistant_id: jsonpath "$.assistantMessageId"
user_message_id: jsonpath "$.userMessageId"
[Asserts]
jsonpath "$.userMessageId" exists
jsonpath "$.assistantMessageId" exists

# 审批轮询：有界 retry（约 20s，须 < 60s 自动允许）直到 captured assistant 恰一条 pending bash 审批。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 40
retry-interval: 500ms
HTTP 200
[Captures]
approval_id: jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].id"
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].decision" == null
jsonpath "$.messages[?(@.id=={{assistant_id}})].approvals[0].tool" == "bash"

# 作答 allow：exact 200，不重试；409 即真实故障。
POST {{base_url}}/api/sessions/{{session_id}}/approvals/{{approval_id}}
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"decision":"allow"}
HTTP 200
[Asserts]
jsonpath "$.id" == {{approval_id}}
jsonpath "$.tool" == "bash"
jsonpath "$.decision" == "allow"

# 轮询 messages：仅 GET 有界 retry（≥90s，覆盖 60s 自动允许），直到 captured assistant 与 session 均为 done。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{assistant_id}})].content" matches "{{content_pattern}}"
jsonpath "$.messages[?(@.id=={{assistant_id}} && count(@.steps[?(@.name=='bash')]) >= {{min_bash_steps}})]" exists
jsonpath "$.messages[?(@.id=={{assistant_id}})].steps[?(@.status!='done')]" not exists
jsonpath "$.session.status" == "done"

# (1) 已 done 的首会话 stop：exact 204、空 body。bodyless：无 Content-Type、无 body；不重试。
POST {{base_url}}/api/sessions/{{session_id}}/stop
[Options]
skip: {{skip_turn_control}}
HTTP 204
[Asserts]
body == ""

# (2) 对已 done 的首会话 regenerate：exact 202，新 assistantMessageId 不同于首轮助手。bodyless：无 Content-Type、无 body；不重试。
POST {{base_url}}/api/sessions/{{session_id}}/regenerate
[Options]
skip: {{skip_turn_control}}
HTTP 202
[Captures]
regen_assistant_id: jsonpath "$.assistantMessageId"
[Asserts]
jsonpath "$.assistantMessageId" != {{assistant_id}}

# (2) 新助手审批轮询：有界 retry（约 20s，须 < 60s 自动允许）直到恰一条 pending bash 审批。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 40
retry-interval: 500ms
HTTP 200
[Captures]
regen_approval_id: jsonpath "$.messages[?(@.id=={{regen_assistant_id}})].approvals[0].id"
[Asserts]
jsonpath "$.messages[?(@.id=={{regen_assistant_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{regen_assistant_id}})].approvals[0].decision" == null
jsonpath "$.messages[?(@.id=={{regen_assistant_id}})].approvals[0].tool" == "bash"

# (2) 作答 allow：exact 200，不重试；409 即真实故障。
POST {{base_url}}/api/sessions/{{session_id}}/approvals/{{regen_approval_id}}
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"decision":"allow"}
HTTP 200
[Asserts]
jsonpath "$.id" == {{regen_approval_id}}
jsonpath "$.decision" == "allow"

# (2) 轮询至 done（≥90s）：恰一条 user 与一条 assistant（即 regenerate 捕获 id，旧助手行不留），
# 正文匹配 content_pattern，bash 步骤 done，步骤全 done，审批为作答的 allow（非 60s 超时自动允许）。
GET {{base_url}}/api/sessions/{{session_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.session.status" == "done"
jsonpath "$.messages" count == 2
jsonpath "$.messages[0].role" == "user"
jsonpath "$.messages[1].role" == "assistant"
jsonpath "$.messages[1].id" == {{regen_assistant_id}}
jsonpath "$.messages[1].status" == "done"
jsonpath "$.messages[1].content" matches "{{content_pattern}}"
jsonpath "$.messages[1].steps[?(@.name=='bash')].status" == "done"
jsonpath "$.messages[1].steps[?(@.status!='done')]" not exists
jsonpath "$.messages[1].approvals[0].decision" == "allow"

# (3) 对已 regenerate 的首会话首条（唯一）用户消息 fork：exact 201，draft 为该用户文本，新会话 idle；捕获新会话 id。
# JSON body {messageId}，须带 Content-Type；不重试。
POST {{base_url}}/api/sessions/{{session_id}}/fork
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"messageId":{{user_message_id}}}
HTTP 201
[Captures]
fork_session_id: jsonpath "$.session.id"
[Asserts]
jsonpath "$.draft" == "你好"
jsonpath "$.session.status" == "idle"

# (3) 分叉会话快照：exact 200，零消息，会话 idle。fork 在 201 前已提交，故不重试；不对分叉会话 prompt。
GET {{base_url}}/api/sessions/{{fork_session_id}}/messages
[Options]
skip: {{skip_turn_control}}
HTTP 200
[Asserts]
jsonpath "$.messages" count == 0
jsonpath "$.session.status" == "idle"

# (4) 第二会话（受控上游只在历史无 tool result 的轮次发 bash）：创建 exact 201 idle；捕获会话 id。
POST {{base_url}}/api/sessions
[Options]
skip: {{skip_turn_control}}
HTTP 201
[Captures]
session2_id: jsonpath "$.id"
[Asserts]
jsonpath "$.status" == "idle"

# (4) 第二会话 prompt：exact 202；捕获 assistantMessageId。不重试。
POST {{base_url}}/api/sessions/{{session2_id}}/prompt
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"message":"你好"}
HTTP 202
[Captures]
assistant2_id: jsonpath "$.assistantMessageId"

# (4) 确定性 running 点：有界 retry（约 20s，须 < 60s 自动允许）直到该助手恰一条 pending bash 审批且 bash 步骤 running。
GET {{base_url}}/api/sessions/{{session2_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 40
retry-interval: 500ms
HTTP 200
[Captures]
approval2_id: jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals[0].id"
[Asserts]
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals[0].decision" == null
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals[0].tool" == "bash"
jsonpath "$.messages[?(@.id=={{assistant2_id}})].steps[?(@.name=='bash')].status" == "running"

# (4) 审批挂起时 stop：exact 202、body {}。bodyless：无 Content-Type、无 body；不重试。
POST {{base_url}}/api/sessions/{{session2_id}}/stop
[Options]
skip: {{skip_turn_control}}
HTTP 202
[Asserts]
body == "{}"

# (4) 轮询至 stopped（≥90s，覆盖 8s grace 与 retire 回退）：会话与助手均 stopped（非 failed/done），
# 唯一审批 deny，无 running 步骤，bash 步骤 failed。
GET {{base_url}}/api/sessions/{{session2_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.session.status" == "stopped"
jsonpath "$.messages[?(@.id=={{assistant2_id}})].status" == "stopped"
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals[0].id" == {{approval2_id}}
jsonpath "$.messages[?(@.id=={{assistant2_id}})].approvals[0].decision" == "deny"
jsonpath "$.messages[?(@.id=={{assistant2_id}})].steps[?(@.status=='running')]" not exists
jsonpath "$.messages[?(@.id=={{assistant2_id}})].steps[?(@.name=='bash')].status" == "failed"

# (4) 对已停止会话 regenerate：exact 202，新 assistantMessageId 不同于被停止助手。bodyless；不重试。
POST {{base_url}}/api/sessions/{{session2_id}}/regenerate
[Options]
skip: {{skip_turn_control}}
HTTP 202
[Captures]
regen2_assistant_id: jsonpath "$.assistantMessageId"
[Asserts]
jsonpath "$.assistantMessageId" != {{assistant2_id}}

# (4) 新助手审批轮询：有界 retry（约 20s，须 < 60s 自动允许）直到恰一条 pending bash 审批。
GET {{base_url}}/api/sessions/{{session2_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 40
retry-interval: 500ms
HTTP 200
[Captures]
regen2_approval_id: jsonpath "$.messages[?(@.id=={{regen2_assistant_id}})].approvals[0].id"
[Asserts]
jsonpath "$.messages[?(@.id=={{regen2_assistant_id}})].approvals" count == 1
jsonpath "$.messages[?(@.id=={{regen2_assistant_id}})].approvals[0].decision" == null
jsonpath "$.messages[?(@.id=={{regen2_assistant_id}})].approvals[0].tool" == "bash"

# (4) 作答 allow：exact 200，不重试；409 即真实故障。
POST {{base_url}}/api/sessions/{{session2_id}}/approvals/{{regen2_approval_id}}
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"decision":"allow"}
HTTP 200
[Asserts]
jsonpath "$.id" == {{regen2_approval_id}}
jsonpath "$.decision" == "allow"

# (4) 轮询至 done（≥90s）：恰一条 user 与一条 assistant（即 regenerate 捕获 id，旧助手行不留），
# 正文匹配 content_pattern，bash 步骤 done，步骤全 done。
GET {{base_url}}/api/sessions/{{session2_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.session.status" == "done"
jsonpath "$.messages" count == 2
jsonpath "$.messages[0].role" == "user"
jsonpath "$.messages[1].role" == "assistant"
jsonpath "$.messages[1].id" == {{regen2_assistant_id}}
jsonpath "$.messages[1].status" == "done"
jsonpath "$.messages[1].content" matches "{{content_pattern}}"
jsonpath "$.messages[1].steps[?(@.name=='bash')].status" == "done"
jsonpath "$.messages[1].steps[?(@.status!='done')]" not exists

# (4) 再 prompt：exact 202；捕获 assistantMessageId。不重试。
POST {{base_url}}/api/sessions/{{session2_id}}/prompt
Content-Type: application/json
[Options]
skip: {{skip_turn_control}}
{"message":"你好"}
HTTP 202
[Captures]
followup2_assistant_id: jsonpath "$.assistantMessageId"

# (4) 轮询至 done（≥90s）：正文匹配；历史已有 tool result，本轮无工具调用，故不断言审批与 bash 计数。
GET {{base_url}}/api/sessions/{{session2_id}}/messages
[Options]
skip: {{skip_turn_control}}
retry: 180
retry-interval: 500ms
HTTP 200
[Asserts]
jsonpath "$.session.status" == "done"
jsonpath "$.messages[?(@.id=={{followup2_assistant_id}})].status" == "done"
jsonpath "$.messages[?(@.id=={{followup2_assistant_id}})].content" matches "{{content_pattern}}"

# 本账号登出：exact 204 + clear cookie。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# 他账号登录。
POST {{base_url}}/api/auth/login
Content-Type: application/json
{"account":"lisi","password":"demo"}
HTTP 200
[Asserts]
cookie "workbuddy_session" matches "^[0-9a-f]{64}$"
{"id":"u3","account":"lisi","role":"管理员"}

# 他账号读该会话：exact 404 not_found。
GET {{base_url}}/api/sessions/{{session_id}}/messages
HTTP 404
{"error":{"code":"not_found","message":"请求的资源不存在"}}

# 他账号登出。
POST {{base_url}}/api/auth/logout
HTTP 204
[Asserts]
header "Set-Cookie" == "workbuddy_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
body == ""

# 无 cookie、无 bearer 的模型代理：exact 401 unauthorized。
POST {{base_url}}/v1/chat/completions
Content-Type: application/json
{"messages":[]}
HTTP 401
{"error":{"code":"unauthorized","message":"请先登录"}}
